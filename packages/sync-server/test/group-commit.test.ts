import { describe, expect, it } from "vitest";
import type { PersistBatch } from "@boardbuddy/sync-core";
import { GroupCommitPersister } from "../src/group-commit";
import type { BoardBatch, MultiBoardPersister } from "../src/persister";

const batch = (n: number): PersistBatch => ({ entries: [], cseqs: { c: n } });

/**
 * Records each transaction; one fails if it contains a board listed in `bad`. While `gate`
 * is set, transactions wait on it, which keeps one "running".
 */
class FakeStore implements MultiBoardPersister {
  readonly transactions: string[][] = [];
  gate: Promise<void> | null = null;

  constructor(private readonly bad = new Set<string>()) {}

  async load() {
    return { entries: [], cseqs: {} };
  }

  async write(boardId: string, b: PersistBatch) {
    await this.writeMany([{ boardId, batch: b }]);
  }

  async writeMany(items: readonly BoardBatch[]) {
    this.transactions.push(items.map((i) => `${i.boardId}:${i.batch.cseqs.c}`));
    await this.gate;
    if (items.some((i) => this.bad.has(i.boardId))) throw new Error("bad batch");
  }

  async close() {}
}

describe("GroupCommitPersister", () => {
  it("writes issued together go out in one transaction", async () => {
    const store = new FakeStore();
    const db = new GroupCommitPersister(store);
    await Promise.all([db.write("a", batch(1)), db.write("b", batch(1)), db.write("c", batch(1))]);
    expect(store.transactions).toEqual([["a:1", "b:1", "c:1"]]);
  });

  it("writes arriving during a transaction wait and share the next one", async () => {
    const store = new FakeStore();
    const db = new GroupCommitPersister(store);
    let open!: () => void;
    store.gate = new Promise((r) => (open = r));
    const first = db.write("a", batch(1));
    await new Promise((r) => setTimeout(r, 5)); // the first transaction is now running
    const later = [db.write("b", batch(1)), db.write("c", batch(1))];
    store.gate = null;
    open();
    await Promise.all([first, ...later]);
    expect(store.transactions).toEqual([["a:1"], ["b:1", "c:1"]]);
  });

  it("runs at most `concurrency` transactions at once; the rest wait and combine", async () => {
    const store = new FakeStore();
    let running = 0;
    let peak = 0;
    const writeMany = store.writeMany.bind(store);
    store.writeMany = async (items) => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 10));
      await writeMany(items);
      running--;
    };
    const db = new GroupCommitPersister(store, { concurrency: 2 });
    await Promise.all(["a", "b"].map((b) => db.write(b, batch(1))));
    store.transactions.length = 0;

    // Two transactions start one tick apart; everything after that waits for a free slot.
    const writes = [db.write("a", batch(2))];
    await new Promise((r) => setImmediate(r));
    writes.push(db.write("b", batch(2)));
    await new Promise((r) => setImmediate(r));
    writes.push(...["c", "d", "e"].map((b) => db.write(b, batch(1))));
    await Promise.all(writes);
    expect(peak).toBe(2);
    expect(store.transactions).toEqual([["a:2"], ["b:2"], ["c:1", "d:1", "e:1"]]);
  });

  it("keeps a board's batches in order, one per transaction", async () => {
    const store = new FakeStore();
    const db = new GroupCommitPersister(store);
    await Promise.all([db.write("a", batch(1)), db.write("a", batch(2)), db.write("b", batch(1))]);
    expect(store.transactions).toEqual([["a:1", "b:1"], ["a:2"]]);
  });

  it("a failing batch fails only its own write", async () => {
    const store = new FakeStore(new Set(["bad"]));
    const db = new GroupCommitPersister(store);
    const results = await Promise.allSettled([db.write("a", batch(1)), db.write("bad", batch(1)), db.write("b", batch(1))]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(store.transactions).toEqual([["a:1", "bad:1", "b:1"], ["a:1"], ["bad:1"], ["b:1"]]);
  });

  it("caps boards per transaction", async () => {
    const store = new FakeStore();
    const db = new GroupCommitPersister(store, { maxBoardsPerTransaction: 2 });
    await Promise.all(["a", "b", "c", "d", "e"].map((b) => db.write(b, batch(1))));
    expect(store.transactions.map((t) => t.length)).toEqual([2, 2, 1]);
  });
});
