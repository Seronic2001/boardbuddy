import { isVisible, type Doc } from "./doc";

/**
 * Fractional indexing for layer z-order.
 *
 * A key is a base-62 string read as a fraction in (0, 1): "V" ≈ 0.5, "0V" ≈ 0.008. Keys
 * compare with plain string comparison, and there is always room for a new key between
 * two different keys, so moving a layer writes one LWW field (`z`) and never renumbers
 * other layers.
 *
 * Two clients that insert between the same neighbours at the same time can produce the
 * same key. Ordering breaks those ties by layer id, so every replica still agrees.
 */

export const Z_FIELD = "z";

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;

export function isValidKey(key: string): boolean {
  if (key.length === 0 || key.endsWith(DIGITS[0]!)) return false;
  for (const ch of key) if (!DIGITS.includes(ch)) return false;
  return true;
}

/**
 * Returns a key strictly between `a` and `b`. `null` means "no lower bound" or
 * "no upper bound".
 */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null && !isValidKey(a)) throw new Error(`Invalid fractional key: ${a}`);
  if (b !== null && !isValidKey(b)) throw new Error(`Invalid fractional key: ${b}`);
  if (a !== null && b !== null && a >= b) {
    throw new Error(`keyBetween requires a < b, got ${a} >= ${b}`);
  }
  if (a === null && b === null) return DIGITS[BASE / 2]!;
  // Open-ended inserts ("bring to front", "send to back") step one digit instead of
  // halving the gap. Keys then grow by one character every ~31 moves instead of every ~5.
  if (b === null) return after(a!);
  if (a === null) return before(b);
  return midpoint(a, b);
}

function after(a: string): string {
  const d = DIGITS.indexOf(a[0]!);
  if (d < BASE - 1) return DIGITS[d + 1]!;
  const rest = a.slice(1);
  return DIGITS[BASE - 1]! + (rest.length > 0 ? after(rest) : DIGITS[BASE / 2]!);
}

function before(b: string): string {
  const d = DIGITS.indexOf(b[0]!);
  if (d > 1) return DIGITS[d - 1]!;
  const rest = b.slice(1);
  if (d === 1) return rest.length > 0 ? DIGITS[1]! : DIGITS[0]! + DIGITS[BASE / 2]!;
  // d === 0: rest is non-empty because valid keys never end in "0".
  return DIGITS[0]! + before(rest);
}

/** Keys after `a` (or from the start if null) and before `b`, evenly spread. */
export function keysBetween(a: string | null, b: string | null, n: number): string[] {
  if (n <= 0) return [];
  if (n === 1) return [keyBetween(a, b)];
  const mid = keyBetween(a, b);
  const left = Math.floor((n - 1) / 2);
  return [...keysBetween(a, mid, left), mid, ...keysBetween(mid, b, n - 1 - left)];
}

// `a` may be "" (lower bound 0). `b` may be null (upper bound 1). Neither ends in "0".
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    // Skip the shared prefix, padding `a` with zeros.
    let n = 0;
    while ((a[n] ?? DIGITS[0]) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a.length > 0 ? DIGITS.indexOf(a[0]!) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0]!) : BASE;
  if (digitB - digitA > 1) {
    return DIGITS[Math.round((digitA + digitB) / 2)]!;
  }
  // Adjacent first digits.
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA]! + midpoint(a.slice(1), null);
}

// ---------------------------------------------------------------------------------------
// Doc helpers
// ---------------------------------------------------------------------------------------

function zOf(doc: Doc, id: string): string {
  const v = doc.layers.get(id)?.fields[Z_FIELD]?.v;
  return typeof v === "string" ? v : "";
}

/** Visible layer ids from bottom to top: by z key, then by layer id. */
export function orderedLayerIds(doc: Doc): string[] {
  const ids: string[] = [];
  for (const [id, record] of doc.layers) if (isVisible(record)) ids.push(id);
  return ids.sort((x, y) => {
    const zx = zOf(doc, x);
    const zy = zOf(doc, y);
    if (zx !== zy) return zx < zy ? -1 : 1;
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/**
 * z key that places a layer directly above `belowId` (or at the bottom if null), skipping
 * the layer being moved. Handles neighbours that share a z key after a concurrent tie.
 */
export function zKeyAbove(doc: Doc, belowId: string | null, movingId?: string): string {
  const order = orderedLayerIds(doc).filter((id) => id !== movingId);
  const index = belowId === null ? -1 : order.indexOf(belowId);
  if (belowId !== null && index < 0) throw new Error(`Layer ${belowId} is not visible`);
  const lower = index >= 0 ? zOf(doc, order[index]!) : null;
  // The upper bound is the first neighbour above with a strictly greater key.
  let upper: string | null = null;
  for (let i = index + 1; i < order.length; i++) {
    const z = zOf(doc, order[i]!);
    if (lower === null || z > lower) {
      upper = z;
      break;
    }
  }
  return keyBetween(lower || null, upper || null);
}

export function zKeyTop(doc: Doc, movingId?: string): string {
  const order = orderedLayerIds(doc).filter((id) => id !== movingId);
  const top = order.at(-1);
  return keyBetween(top === undefined ? null : zOf(doc, top) || null, null);
}

export function zKeyBottom(doc: Doc, movingId?: string): string {
  const order = orderedLayerIds(doc).filter((id) => id !== movingId);
  const bottom = order[0];
  return keyBetween(null, bottom === undefined ? null : zOf(doc, bottom) || null);
}
