import { z } from "zod";
import type { TransportClientMessage } from "@boardbuddy/sync-core";

/**
 * Wire validation for everything a browser can send. Anything that fails is a protocol
 * violation, and the socket is closed. Deeper rules (authorship, skew, reserved fields)
 * run inside the Room so rejected ops still use up their cseq.
 */

const MAX_DEPTH = 6;
const MAX_STRING = 10_000;
const MAX_ARRAY = 5_000;
const MAX_KEYS = 64;

// JSON values with bounded depth and size. Path layers carry point arrays, hence MAX_ARRAY.
const json = (depth: number): z.ZodType<unknown> =>
  depth >= MAX_DEPTH
    ? z.union([z.null(), z.boolean(), z.number().finite(), z.string().max(MAX_STRING)])
    : z.lazy(() =>
        z.union([
          z.null(),
          z.boolean(),
          z.number().finite(),
          z.string().max(MAX_STRING),
          z.array(json(depth + 1)).max(MAX_ARRAY),
          z
            .record(z.string().max(64), json(depth + 1))
            .refine((o) => Object.keys(o).length <= MAX_KEYS, "Too many keys"),
        ]),
      );

const id = z.string().regex(/^[A-Za-z0-9_~.-]{1,128}$/);
const field = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/);

const hlc = z.object({
  wall: z.number().int().nonnegative(),
  counter: z.number().int().nonnegative().max(1_000_000),
  client: id,
});

const op = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("create"),
    layer: id,
    fields: z.record(field, json(1)).refine((o) => Object.keys(o).length <= MAX_KEYS),
    ts: hlc,
  }),
  z.object({ kind: z.literal("set"), layer: id, field, v: json(1), ts: hlc }),
  z.object({ kind: z.literal("delete"), layer: id, ts: hlc }),
  z.object({ kind: z.literal("restore"), layer: id, ts: hlc }),
]);

const pendingOps = z
  .array(z.object({ cseq: z.number().int().positive(), op }))
  .max(1_000);

const clientMessage = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello"),
    token: z.string().max(4_096).optional(),
    tab: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
    lastSeq: z.number().int().nonnegative(),
    pending: pendingOps,
  }),
  z.object({ t: z.literal("ops"), batch: pendingOps }),
  z.object({
    t: z.literal("presence"),
    data: z.record(z.string().max(32), json(1)).refine((o) => Object.keys(o).length <= 16),
  }),
  z.object({ t: z.literal("reauth"), token: z.string().max(4_096) }),
]);

export function parseClientMessage(raw: string): TransportClientMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = clientMessage.safeParse(data);
  return result.success ? (result.data as TransportClientMessage) : null;
}
