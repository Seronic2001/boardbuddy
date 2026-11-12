/**
 * Hybrid logical clock (Kulkarni et al., 2014).
 *
 * A timestamp is (wall, counter, client). It is totally ordered by wall, then counter,
 * then client, so two timestamps from different clients are never equal. `wall` stays
 * close to physical time, so "last writer" means roughly "the edit made later". `counter`
 * orders events inside the same millisecond, or while the local physical clock lags behind
 * a timestamp we have already seen.
 */
export type HLC = {
  readonly wall: number;
  readonly counter: number;
  readonly client: string;
};

export function compareHLC(a: HLC, b: HLC): number {
  if (a.wall !== b.wall) return a.wall < b.wall ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.client !== b.client) return a.client < b.client ? -1 : 1;
  return 0;
}

export function hlcEquals(a: HLC, b: HLC): boolean {
  return compareHLC(a, b) === 0;
}

/** Fixed-width string form that sorts like compareHLC. Useful for logs and DB keys. */
export function encodeHLC(ts: HLC): string {
  return `${ts.wall.toString(36).padStart(11, "0")}:${ts.counter
    .toString(36)
    .padStart(5, "0")}:${ts.client}`;
}

export function decodeHLC(s: string): HLC {
  const first = s.indexOf(":");
  const second = s.indexOf(":", first + 1);
  if (first < 0 || second < 0) throw new Error(`Invalid HLC string: ${s}`);
  return {
    wall: parseInt(s.slice(0, first), 36),
    counter: parseInt(s.slice(first + 1, second), 36),
    client: s.slice(second + 1),
  };
}

export class ClockDriftError extends Error {
  constructor(
    readonly remote: HLC,
    readonly physical: number,
    readonly maxDriftMs: number,
  ) {
    super(
      `Remote timestamp is ${remote.wall - physical} ms ahead of local time (max ${maxDriftMs} ms)`,
    );
    this.name = "ClockDriftError";
  }
}

export type ClockOptions = {
  /** Physical time source. Inject a fake for tests and the simulator. */
  now?: () => number;
  /**
   * Reject remote timestamps more than this far ahead of local physical time. This limits
   * how far one badly skewed client can drag everyone's clock forward.
   */
  maxDriftMs?: number;
};

const DEFAULT_MAX_DRIFT_MS = 60_000;

export class Clock {
  private wall = 0;
  private counter = 0;
  private readonly now: () => number;
  private readonly maxDriftMs: number;

  constructor(
    readonly client: string,
    options: ClockOptions = {},
  ) {
    if (client.length === 0) throw new Error("Clock client id must be non-empty");
    if (client.includes(":")) throw new Error("Clock client id must not contain ':'");
    this.now = options.now ?? Date.now;
    this.maxDriftMs = options.maxDriftMs ?? DEFAULT_MAX_DRIFT_MS;
  }

  /** Timestamp for a local event (an op we are about to create). Strictly increasing. */
  tick(): HLC {
    const physical = this.now();
    if (physical > this.wall) {
      this.wall = physical;
      this.counter = 0;
    } else {
      this.counter += 1;
    }
    return this.current();
  }

  /**
   * Merge a remote timestamp so that every later local tick() sorts after it.
   * Throws ClockDriftError if the remote clock is too far ahead; the caller decides
   * whether to drop the message or only skip the clock update.
   */
  receive(remote: HLC): HLC {
    const physical = this.now();
    if (remote.wall - physical > this.maxDriftMs) {
      throw new ClockDriftError(remote, physical, this.maxDriftMs);
    }
    const wall = Math.max(this.wall, remote.wall, physical);
    if (wall === this.wall && wall === remote.wall) {
      this.counter = Math.max(this.counter, remote.counter) + 1;
    } else if (wall === this.wall) {
      this.counter += 1;
    } else if (wall === remote.wall) {
      this.counter = remote.counter + 1;
    } else {
      this.counter = 0;
    }
    this.wall = wall;
    return this.current();
  }

  current(): HLC {
    return { wall: this.wall, counter: this.counter, client: this.client };
  }
}
