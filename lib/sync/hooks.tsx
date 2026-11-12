"use client";

import {
  createContext,
  useCallback,
  useLayoutEffect,
  useContext,
  useRef,
  useSyncExternalStore,
  type DependencyList,
  type ReactNode,
} from "react";
import type {
  HistoryApi,
  MutableStorage,
  Presence,
  StorageView,
  SyncBackend,
  SyncStatus,
  User,
} from "./types";

/**
 * Backend-neutral hooks with the same names and shapes as the Liveblocks hooks the
 * canvas used before, so switching a board's backend needs no component changes.
 */

const SyncContext = createContext<SyncBackend | null>(null);

export function SyncBackendProvider({ backend, children }: { backend: SyncBackend; children: ReactNode }) {
  return <SyncContext.Provider value={backend}>{children}</SyncContext.Provider>;
}

export function useSyncBackend(): SyncBackend {
  const backend = useContext(SyncContext);
  if (!backend) throw new Error("Sync hooks must be used inside <Room>");
  return backend;
}

type Equality<T> = (a: T, b: T) => boolean;

/** Shallow equality for arrays and plain objects (same role as Liveblocks' `shallow`). */
export function shallow(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k) => Object.prototype.hasOwnProperty.call(b, k) && Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/**
 * useSyncExternalStore with a selector. The result keeps its identity while `isEqual`
 * says it is unchanged, so components only re-render when their slice changes.
 */
function useSelector<S, T>(
  subscribe: (listener: () => void) => () => void,
  getState: () => S,
  selector: (state: S) => T,
  isEqual: Equality<T> = Object.is,
): T {
  const cache = useRef<{ state: S; value: T } | null>(null);
  const getSnapshot = () => {
    const state = getState();
    const cached = cache.current;
    if (cached && cached.state === state) {
      // Same state, maybe a new selector closure: recompute but keep the old value if equal.
      const value = selector(state);
      if (isEqual(cached.value, value)) return cached.value;
      cache.current = { state, value };
      return value;
    }
    const value = selector(state);
    if (cached && isEqual(cached.value, value)) {
      cache.current = { state, value: cached.value };
      return cached.value;
    }
    cache.current = { state, value };
    return value;
  };
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

type SubscribeMethod = "subscribeStorage" | "subscribePresence" | "subscribeHistory" | "subscribeStatus";

/** Stable subscribe function, so useSyncExternalStore doesn't resubscribe on every render. */
function useSubscribe(backend: SyncBackend, method: SubscribeMethod) {
  return useCallback((listener: () => void) => backend[method](listener), [backend, method]);
}

// ---- storage --------------------------------------------------------------------------

export function useStorage<T>(selector: (root: StorageView) => T, isEqual?: Equality<T>): T {
  const backend = useSyncBackend();
  return useSelector(useSubscribe(backend, "subscribeStorage"), () => backend.getStorage(), selector, isEqual);
}

export type MutationContext = {
  storage: MutableStorage;
  self: User;
  setMyPresence: (patch: Partial<Presence>, options?: { addToHistory?: boolean }) => void;
};

/**
 * Returns a stable callback that runs `fn` as one batch. It always calls the latest `fn`
 * (latest-ref pattern), so `deps` only exists for Liveblocks API compatibility: the result
 * is never stale, and memoised children don't re-render when deps change.
 */
export function useMutation<A extends unknown[], R>(
  fn: (context: MutationContext, ...args: A) => R,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  deps: DependencyList,
): (...args: A) => R {
  const backend = useSyncBackend();
  const latest = useRef(fn);
  useLayoutEffect(() => {
    latest.current = fn;
  });
  return useCallback(
    (...args: A) =>
      backend.mutate((storage) =>
        latest.current(
          {
            storage,
            self: backend.getSelf(),
            setMyPresence: (patch, options) => backend.updatePresence(patch, options),
          },
          ...args,
        ),
      ),
    [backend],
  );
}

// ---- presence -------------------------------------------------------------------------

export function useSelf(): User;
export function useSelf<T>(selector: (me: User) => T, isEqual?: Equality<T>): T;
export function useSelf<T>(selector?: (me: User) => T, isEqual?: Equality<T>): T | User {
  const backend = useSyncBackend();
  return useSelector(
    useSubscribe(backend, "subscribePresence"),
    () => backend.getSelf(),
    selector ?? ((me: User) => me as unknown as T),
    isEqual,
  );
}

export function useOthers(): readonly User[] {
  const backend = useSyncBackend();
  return useSelector(useSubscribe(backend, "subscribePresence"), () => backend.getOthers(), (others) => others);
}

const itemsEqual =
  <T,>(isEqual: Equality<T>): Equality<readonly (readonly [number, T])[]> =>
  (a, b) =>
    a.length === b.length && a.every(([id, v], i) => id === b[i]![0] && isEqual(v, b[i]![1]));

export function useOthersMapped<T>(
  selector: (other: User) => T,
  isEqual: Equality<T> = Object.is,
): readonly (readonly [connectionId: number, data: T])[] {
  const backend = useSyncBackend();
  return useSelector(
    useSubscribe(backend, "subscribePresence"),
    () => backend.getOthers(),
    (others) => others.map((o) => [o.connectionId, selector(o)] as const),
    itemsEqual(isEqual),
  );
}

export function useOthersConnectionIds(): readonly number[] {
  const backend = useSyncBackend();
  return useSelector(
    useSubscribe(backend, "subscribePresence"),
    () => backend.getOthers(),
    (others) => others.map((o) => o.connectionId),
    shallow,
  );
}

export function useOther<T>(connectionId: number, selector: (other: User) => T, isEqual?: Equality<T>): T {
  const backend = useSyncBackend();
  return useSelector(
    useSubscribe(backend, "subscribePresence"),
    () => backend.getOthers(),
    (others) => {
      const other = others.find((o) => o.connectionId === connectionId);
      // The user may leave between the id list render and this one.
      return other ? selector(other) : (undefined as T);
    },
    isEqual,
  );
}

// ---- history and status ---------------------------------------------------------------

export function useHistory(): HistoryApi {
  return useSyncBackend().history;
}

export function useCanUndo(): boolean {
  const backend = useSyncBackend();
  return useSelector(useSubscribe(backend, "subscribeHistory"), () => backend.canUndo(), (v) => v);
}

export function useCanRedo(): boolean {
  const backend = useSyncBackend();
  return useSelector(useSubscribe(backend, "subscribeHistory"), () => backend.canRedo(), (v) => v);
}

export function useStatus(): SyncStatus {
  const backend = useSyncBackend();
  return useSelector(useSubscribe(backend, "subscribeStatus"), () => backend.getStatus(), (v) => v);
}
