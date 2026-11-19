// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { LayerType, type Layer } from "@/types/canvas";
import {
  SyncBackendProvider,
  shallow,
  useMutation,
  useOthersMapped,
  useSelf,
  useStorage,
} from "./hooks";
import { INITIAL_PRESENCE, type StorageView, type SyncBackend, type User } from "./types";

/** Minimal in-memory backend: enough to test the hooks' subscription and memo behaviour. */
function fakeBackend() {
  const listeners = new Set<() => void>();
  let storage: StorageView = { layers: new Map(), layerIds: [] };
  let self: User = { connectionId: 1, presence: INITIAL_PRESENCE };
  let others: readonly User[] = [];
  const notify = () => listeners.forEach((l) => l());
  const sub = (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  };
  const backend: SyncBackend = {
    getStorage: () => storage,
    subscribeStorage: sub,
    mutate: (fn) =>
      fn({
        get: ((key: string) =>
          key === "layers"
            ? {
                set: (id: string, layer: Layer) => {
                  storage = { layers: new Map(storage.layers).set(id, layer), layerIds: [...storage.layerIds, id] };
                  notify();
                },
              }
            : {}) as never,
      }),
    getSelf: () => self,
    getOthers: () => others,
    subscribePresence: sub,
    updatePresence: (patch) => {
      self = { ...self, presence: { ...self.presence, ...patch } };
      notify();
    },
    history: { undo() {}, redo() {}, pause() {}, resume() {} },
    canUndo: () => false,
    canRedo: () => false,
    subscribeHistory: sub,
    getStatus: () => "connected",
    subscribeStatus: sub,
  };
  return {
    backend,
    setOthers: (next: readonly User[]) => {
      others = next;
      notify();
    },
    touch: () => {
      storage = { ...storage }; // new snapshot, same contents
      notify();
    },
  };
}

const rect: Layer = { type: LayerType.Rectangle, x: 0, y: 0, width: 1, height: 1, fill: { r: 0, g: 0, b: 0 } };
const wrap = (backend: SyncBackend) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <SyncBackendProvider backend={backend}>{children}</SyncBackendProvider>;
  };

describe("sync hooks", () => {
  it("useStorage re-renders only when the selected slice changes", () => {
    const fake = fakeBackend();
    let renders = 0;
    function Count() {
      renders++;
      const n = useStorage((root) => root.layerIds.length);
      return <span>{n}</span>;
    }
    const { container } = render(<Count />, { wrapper: wrap(fake.backend) });
    expect(renders).toBe(1);
    act(() => fake.touch());
    expect(renders).toBe(1); // new snapshot but the same count
    act(() => fake.backend.mutate((s) => s.get("layers").set("a", rect)));
    expect(container.textContent).toBe("1");
    expect(renders).toBe(2);
  });

  it("useMutation returns a stable function that always runs the latest closure", () => {
    const fake = fakeBackend();
    const seen: unknown[] = [];
    let latest: (() => void) | null = null;
    function Comp({ value }: { value: number }) {
      const run = useMutation(({ setMyPresence }) => setMyPresence({ selection: [String(value)] }), [value]);
      useEffect(() => {
        seen.push(run);
        latest = run;
      });
      return null;
    }
    const { rerender } = render(<Comp value={1} />, { wrapper: wrap(fake.backend) });
    rerender(<Comp value={2} />);
    expect(seen[0]).toBe(seen[1]);
    act(() => latest!());
    expect(fake.backend.getSelf().presence.selection).toEqual(["2"]);
  });

  it("useSelf with a selector and useOthersMapped with shallow keep results stable", () => {
    const fake = fakeBackend();
    let renders = 0;
    function Comp() {
      renders++;
      useSelf((me) => me.presence.selection);
      useOthersMapped((o) => ({ draft: o.presence.pencilDraft, color: o.presence.penColor }), shallow);
      return null;
    }
    render(<Comp />, { wrapper: wrap(fake.backend) });
    const other: User = { connectionId: 7, presence: INITIAL_PRESENCE };
    act(() => fake.setOthers([other]));
    expect(renders).toBe(2);
    // A cursor move changes the user object but not the mapped fields.
    act(() => fake.setOthers([{ ...other, presence: { ...INITIAL_PRESENCE, cursor: { x: 1, y: 1 } } }]));
    expect(renders).toBe(2);
    act(() => fake.backend.updatePresence({ cursor: { x: 3, y: 3 } }));
    expect(renders).toBe(2); // own cursor moved, selection unchanged
  });
});
