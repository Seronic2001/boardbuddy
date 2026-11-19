/**
 * Latency histogram: 0.1 ms buckets up to 2 s, then 10 ms buckets up to 120 s, then one
 * overflow bucket. Plain arrays, so worker threads can post them and the main thread can
 * merge them exactly (percentiles of percentiles would be wrong).
 */
const FINE_MS = 0.1;
const FINE_UNTIL_MS = 2_000;
const COARSE_MS = 10;
const COARSE_UNTIL_MS = 120_000;
const FINE = FINE_UNTIL_MS / FINE_MS;
const COARSE = (COARSE_UNTIL_MS - FINE_UNTIL_MS) / COARSE_MS;
const BUCKETS = FINE + COARSE + 1; // the last bucket holds everything above COARSE_UNTIL_MS

function bucketOf(ms: number): number {
  if (ms < FINE_UNTIL_MS) return Math.floor(ms / FINE_MS);
  if (ms < COARSE_UNTIL_MS) return FINE + Math.floor((ms - FINE_UNTIL_MS) / COARSE_MS);
  return BUCKETS - 1;
}

function upperEdge(bucket: number): number {
  if (bucket < FINE) return (bucket + 1) * FINE_MS;
  return FINE_UNTIL_MS + (bucket - FINE + 1) * COARSE_MS;
}

export type HistogramData = { counts: number[]; max: number; sum: number; n: number };

export class Histogram {
  readonly counts = new Array<number>(BUCKETS).fill(0);
  max = 0;
  sum = 0;
  n = 0;

  record(ms: number): void {
    const v = Math.max(0, ms);
    const i = bucketOf(v);
    this.counts[i] = (this.counts[i] ?? 0) + 1;
    if (v > this.max) this.max = v;
    this.sum += v;
    this.n++;
  }

  merge(other: HistogramData): void {
    for (let i = 0; i < BUCKETS; i++) this.counts[i] = (this.counts[i] ?? 0) + (other.counts[i] ?? 0);
    this.max = Math.max(this.max, other.max);
    this.sum += other.sum;
    this.n += other.n;
  }

  /** Upper edge of the bucket holding the p-th percentile (0..100), capped at the max seen. */
  percentile(p: number): number {
    if (this.n === 0) return NaN;
    const rank = Math.ceil((p / 100) * this.n);
    let seen = 0;
    for (let i = 0; i < BUCKETS; i++) {
      seen += this.counts[i] ?? 0;
      if (seen >= rank) return i === BUCKETS - 1 ? this.max : Math.min(this.max, upperEdge(i));
    }
    return this.max;
  }

  get mean(): number {
    return this.n === 0 ? NaN : this.sum / this.n;
  }

  toJSON(): HistogramData {
    return { counts: this.counts, max: this.max, sum: this.sum, n: this.n };
  }
}
