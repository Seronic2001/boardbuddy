import {
  isVisible,
  orderedLayerIds,
  zKeyAbove,
  zKeyTop,
  type Doc,
  type Json,
  type LayerRecord,
  type Tx,
} from "@boardbuddy/sync-core";
import { LayerType, type Color, type Layer } from "@/types/canvas";
import type { LayerHandle, LayerIdList, LayersMap, MutableStorage, StorageView } from "./types";

/**
 * Maps the BuddySync document (per-field LWW registers plus a fractional `z` key) to the
 * shapes the canvas expects: a map of plain Layer objects and an ordered id list.
 *
 * There is no list CRDT: order comes from the `z` field. Liveblocks-style list
 * operations become z writes. push = move to top; move(from, to) = a key between the new
 * neighbours. Deletion lives on the layer, so removing an id from the list is a no-op.
 */

const BLACK: Color = { r: 0, g: 0, b: 0 };

const num = (v: Json | undefined, fallback = 0) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

function color(v: Json | undefined): Color {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return { r: num(v.r), g: num(v.g), b: num(v.b) };
  }
  return BLACK;
}

function points(v: Json | undefined): number[][] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (p): p is number[] => Array.isArray(p) && p.length >= 2 && p.every((n) => typeof n === "number"),
  );
}

/**
 * A Layer from a record. Values come from any collaborator, so they are coerced to the
 * expected shapes instead of trusted (the server only checks they are bounded JSON).
 */
export function recordToLayer(record: LayerRecord): Layer {
  return plainToLayer((name) => record.fields[name]?.v);
}

/** Same coercion for a plain object, e.g. a layer exported from Liveblocks. */
export function plainToLayer(f: (name: string) => Json | undefined): Layer {
  const type = num(f("type"), LayerType.Rectangle) as LayerType;
  const base = {
    x: num(f("x")),
    y: num(f("y")),
    width: num(f("width")),
    height: num(f("height")),
    fill: color(f("fill")),
    ...(typeof f("value") === "string" ? { value: f("value") as string } : {}),
  };
  if (type === LayerType.Path) return { ...base, type, points: points(f("points")) };
  if (
    type === LayerType.Rectangle ||
    type === LayerType.Ellipse ||
    type === LayerType.Text ||
    type === LayerType.Note
  ) {
    return { ...base, type } as Layer;
  }
  return { ...base, type: LayerType.Rectangle };
}

/**
 * Caches views so that unchanged layers keep the same object (memoised layer components
 * skip re-rendering), and the whole view only changes when the Doc does.
 */
export class StorageViewCache {
  private doc: Doc | null = null;
  private view: StorageView = { layers: new Map(), layerIds: [] };
  private readonly layerCache = new Map<string, { record: LayerRecord; layer: Layer }>();

  get(doc: Doc): StorageView {
    if (doc === this.doc) return this.view;
    this.doc = doc;
    const layers = new Map<string, Layer>();
    for (const [id, record] of doc.layers) {
      if (!isVisible(record)) {
        this.layerCache.delete(id);
        continue;
      }
      const cached = this.layerCache.get(id);
      if (cached && cached.record === record) {
        layers.set(id, cached.layer);
      } else {
        const layer = recordToLayer(record);
        this.layerCache.set(id, { record, layer });
        layers.set(id, layer);
      }
    }
    const ids = orderedLayerIds(doc);
    const prevIds = this.view.layerIds;
    const layerIds = ids.length === prevIds.length && ids.every((id, i) => id === prevIds[i]) ? prevIds : ids;
    this.view = { layers, layerIds };
    return this.view;
  }
}

function layerToFields(layer: Layer): Record<string, Json> {
  const fields: Record<string, Json> = {
    type: layer.type,
    x: layer.x,
    y: layer.y,
    width: layer.width,
    height: layer.height,
    fill: { ...layer.fill },
  };
  if (layer.value !== undefined) fields.value = layer.value;
  if (layer.type === LayerType.Path) fields.points = layer.points.map((p) => [...p]);
  return fields;
}

/** The Liveblocks-shaped mutation API on top of one BuddySync transaction. */
export function storageForTx(tx: Tx): MutableStorage {
  const visible = (id: string) => isVisible(tx.doc.layers.get(id));

  const handle = (id: string): LayerHandle => ({
    get: (key) => recordToLayer(tx.doc.layers.get(id)!)[key],
    set: (key, value) => tx.set(id, key, value as Json),
    update: (patch) => {
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) tx.set(id, key, value as Json);
      }
    },
  });

  const layers: LayersMap = {
    get size() {
      let n = 0;
      for (const record of tx.doc.layers.values()) if (isVisible(record)) n++;
      return n;
    },
    get: (id) => (visible(id) ? handle(id) : undefined),
    set: (id, layer) => tx.create(id, { ...layerToFields(layer), z: zKeyTop(tx.doc, id) }),
    delete: (id) => {
      if (visible(id)) tx.delete(id);
    },
    toImmutable: () => new StorageViewCache().get(tx.doc).layers,
  };

  const layerIds: LayerIdList = {
    get length() {
      return orderedLayerIds(tx.doc).length;
    },
    push: (id) => {
      // New layers are created on top already; for existing ones this means "to front".
      if (!visible(id)) return;
      const order = orderedLayerIds(tx.doc);
      if (order.at(-1) !== id) tx.set(id, "z", zKeyTop(tx.doc, id));
    },
    move: (from, to) => {
      const order = orderedLayerIds(tx.doc);
      const id = order[from];
      if (id === undefined || from === to || to < 0 || to >= order.length) return;
      const rest = order.filter((x) => x !== id);
      const below = to > 0 ? rest[to - 1]! : null;
      tx.set(id, "z", zKeyAbove(tx.doc, below, id));
    },
    indexOf: (id) => orderedLayerIds(tx.doc).indexOf(id),
    delete: () => {
      // Order is derived from z; the layer leaves the list when layers.delete() hides it.
    },
    toImmutable: () => orderedLayerIds(tx.doc),
  };

  function get(key: "layers"): LayersMap;
  function get(key: "layerIds"): LayerIdList;
  function get(key: "layers" | "layerIds"): LayersMap | LayerIdList {
    return key === "layers" ? layers : layerIds;
  }
  return { get };
}
