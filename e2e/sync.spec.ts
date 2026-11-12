import { expect, test } from "@playwright/test";

import { drag, expectConverged, insert, newBoardId, openAs, rgb, setFill, snapshot } from "./helpers";

// Two users in separate browser contexts on the real canvas, synced through BuddySync.

const RECONNECTING = "Reconnecting… your changes will sync when you're back online";

test("edits appear live for the other user", async ({ browser }) => {
  const boardId = newBoardId();
  const alice = await openAs(browser, boardId, "alice");
  const bob = await openAs(browser, boardId, "bob");

  const rect = await insert(alice.page, "Rectangle", 400, 300);
  const start = (await snapshot(alice.page)).layers[rect];
  await setFill(bob.page, rect, "blue");
  await drag(alice.page, rect, 150, 80);

  const doc = await expectConverged([alice.page, bob.page]);
  expect(doc.layerIds).toEqual([rect]);
  expect(doc.layers[rect]).toMatchObject({ x: start.x + 150, y: start.y + 80, fill: rgb("blue") });

  // Presence: each sees the other in the participants list.
  await expect(bob.page.getByText("alice")).toBeVisible();
});

test("offline edits merge with concurrent edits on reconnect", async ({ browser }) => {
  const boardId = newBoardId();
  const alice = await openAs(browser, boardId, "alice");
  const bob = await openAs(browser, boardId, "bob");

  const rect = await insert(alice.page, "Rectangle", 400, 300);
  const start = (await expectConverged([alice.page, bob.page])).layers[rect];

  await alice.goOffline();
  await expect(alice.page.getByText(RECONNECTING)).toBeVisible();

  // Same layer, different fields: alice recolours it offline while bob moves it.
  await setFill(alice.page, rect, "red");
  const ellipse = await insert(alice.page, "Ellipse", 800, 300);
  await drag(bob.page, rect, 0, 200);

  // Bob hasn't seen anything from alice yet.
  await expect.poll(async () => (await snapshot(bob.page)).layerIds).toEqual([rect]);

  await alice.goOnline();
  await expect(alice.page.getByText(RECONNECTING)).toBeHidden();

  const doc = await expectConverged([alice.page, bob.page]);
  expect(doc.layerIds).toEqual([rect, ellipse]);
  expect(doc.layers[rect]).toMatchObject({ x: start.x, y: start.y + 200, fill: rgb("red") });
});

test("unsent edits survive a reload and sync afterwards", async ({ browser }) => {
  const boardId = newBoardId();
  const alice = await openAs(browser, boardId, "alice");
  const bob = await openAs(browser, boardId, "bob");

  await alice.cutSync();
  await expect(alice.page.getByText(RECONNECTING)).toBeVisible();
  const note = await insert(alice.page, "Sticky note", 600, 300);

  // Reload straight away: the edit now exists only in IndexedDB.
  await alice.page.reload();
  await expect(alice.page.getByTestId("e2e-header")).toBeVisible();
  await expect
    .poll(async () => (await alice.page.evaluate(() => window.__e2e?.snapshot().layerIds)) ?? [], {
      message: "the reloaded page shows the unsent note before it can reach the server",
    })
    .toEqual([note]);
  expect((await snapshot(bob.page)).layerIds).toEqual([]);

  await alice.restoreSync();
  const doc = await expectConverged([alice.page, bob.page]);
  expect(doc.layerIds).toEqual([note]);
});
