import { expect, type Browser, type BrowserContext, type Page, type WebSocketRoute } from "@playwright/test";

import type { E2eSnapshot } from "@/app/e2e/board/[boardId]/e2e-probe";

export type Tool = "Select" | "Text" | "Sticky note" | "Rectangle" | "Ellipse" | "Pen";

/** A fresh board per test; the in-memory sync server never sees the same id twice. */
export function newBoardId(): string {
  return `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Every sync socket goes through Playwright so a test can cut it. Chromium's offline
 * emulation (context.setOffline) blocks HTTP and fires offline/online events, but leaves an
 * already-open WebSocket connected, so on its own it doesn't take a page offline.
 */
async function syncLink(context: BrowserContext) {
  let cut = false;
  const open = new Set<WebSocketRoute>();
  await context.routeWebSocket(/^wss?:\/\/[^/]+:8787/, (ws) => {
    if (cut) return void ws.close({ code: 4000, reason: "test: offline" });
    open.add(ws);
    ws.onClose(() => open.delete(ws));
    ws.connectToServer();
  });
  return {
    async cut() {
      cut = true;
      await Promise.all([...open].map((ws) => ws.close({ code: 4000, reason: "test: offline" })));
    },
    restore() {
      cut = false;
    },
  };
}

/** Opens the board as `user` in its own browser context (own IndexedDB, own identity). */
export async function openAs(browser: Browser, boardId: string, user: string) {
  const context = await browser.newContext();
  const link = await syncLink(context);
  const page = await context.newPage();
  await page.goto(`/e2e/board/${boardId}?user=${user}`);
  await expect(
    page.getByTestId("e2e-header"),
    "test page missing: is E2E_TEST_AUTH=1 set for the Next.js dev server?",
  ).toBeVisible({ timeout: 30_000 });
  await waitConnected(page);
  return {
    context,
    page,
    /** Only the sync socket drops; the page can still load and reload. */
    cutSync: () => link.cut(),
    /** Lets the sync socket through again and nudges an immediate reconnect. */
    async restoreSync() {
      link.restore();
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
    },
    /** The whole browser goes offline, as with a lost network. */
    async goOffline() {
      await context.setOffline(true);
      await link.cut();
    },
    async goOnline() {
      link.restore();
      await context.setOffline(false); // fires "online", which reconnects at once
    },
  };
}

export async function waitConnected(page: Page) {
  await expect.poll(() => page.evaluate(() => window.__e2e?.status() ?? "loading")).toBe("connected");
}

export function snapshot(page: Page): Promise<E2eSnapshot> {
  return page.evaluate(() => window.__e2e!.snapshot());
}

/** JSON with sorted object keys: replicas may hold the same layers in a different map order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/** Waits until every page holds the same document, and returns it. */
export async function expectConverged(pages: Page[]): Promise<E2eSnapshot> {
  await expect
    .poll(async () => new Set((await Promise.all(pages.map(snapshot))).map(canonical)).size, {
      message: "all browsers should end up with the same document",
    })
    .toBe(1);
  return snapshot(pages[0]);
}

/** Inserts a layer with the toolbar and returns its id. The camera starts at (0, 0). */
export async function insert(page: Page, tool: Tool, x: number, y: number): Promise<string> {
  const before = new Set((await snapshot(page)).layerIds);
  await page.getByRole("button", { name: tool, exact: true }).click();
  await page.mouse.click(x, y);
  let id: string | undefined;
  await expect
    .poll(async () => {
      id = (await snapshot(page)).layerIds.find((l) => !before.has(l));
      return id;
    })
    .toBeDefined();
  return id!;
}

async function layerPoint(page: Page, id: string) {
  // The layer may have been created in another browser and still be on its way here.
  await expect.poll(async () => (await snapshot(page)).layers[id] !== undefined).toBe(true);
  const layer = (await snapshot(page)).layers[id];
  // Inside the layer, away from the resize handles on its edges.
  return { x: layer.x + layer.width / 2, y: layer.y + layer.height / 2 };
}

export async function select(page: Page, id: string) {
  const p = await layerPoint(page, id);
  await page.mouse.click(p.x, p.y);
}

export async function drag(page: Page, id: string, dx: number, dy: number) {
  const p = await layerPoint(page, id);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + dx, p.y + dy, { steps: 8 });
  await page.mouse.up();
}

/** Colours offered by the selection toolbar (aria-label "Color <hex>"). */
export const COLORS = {
  red: { r: 243, g: 82, b: 35, hex: "#f35223" },
  blue: { r: 39, g: 142, b: 237, hex: "#278eed" },
  green: { r: 68, g: 202, b: 99, hex: "#44ca63" },
} as const;

export async function setFill(page: Page, id: string, color: keyof typeof COLORS) {
  await select(page, id);
  await page.getByRole("button", { name: `Color ${COLORS[color].hex}` }).click();
}

export function rgb(color: keyof typeof COLORS) {
  const { r, g, b } = COLORS[color];
  return { r, g, b };
}
