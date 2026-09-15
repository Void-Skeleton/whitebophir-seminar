// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-15: real HTTP presentation controls and viewport.
import type { Page } from "@playwright/test";
import { gunzipSync } from "node:zlib";
import { createBoardPage, expect, test } from "../fixtures/test";

const secret = "12".repeat(16);
test.use({
  serverOptions: { env: { WBO_BOARD_MODERATORS: `chunks:${secret}` } },
});

async function camera(page: Page) {
  return page.evaluate(() => {
    const app = window.WBOApp;
    const state = app.chunks.state;
    const x = Math.floor(state.point.x / state.width) * state.width;
    const y = Math.floor(state.point.y / state.height) * state.height;
    const rect = app.viewportState.controller.boardRectToViewportRect({
      x,
      y,
      width: state.width,
      height: state.height,
    });
    const menu = document.getElementById("menu");
    if (!menu) throw new Error("Missing menu");
    const left = menu.getBoundingClientRect().right + 8;
    return {
      centerErrorX: Math.abs(
        (rect.left + rect.right) / 2 - (left + innerWidth) / 2,
      ),
      centerErrorY: Math.abs((rect.top + rect.bottom) / 2 - innerHeight / 2),
      fits:
        rect.left >= left &&
        rect.top >= 0 &&
        rect.right <= innerWidth &&
        rect.bottom <= innerHeight,
      scale: app.viewportState.scale,
    };
  });
}

async function rectangle(page: Page, id: string, x: number, y: number) {
  await page.evaluate(
    ({ id, x, y }) =>
      window.WBOApp.writes.drawAndSend({
        tool: 3,
        type: 1,
        id,
        x,
        y,
        x2: x + 200,
        y2: y + 200,
        color: "#123456",
        size: 10,
      }),
    { id, x, y },
  );
  await expect
    .poll(() => page.evaluate((id) => !!document.getElementById(id), id))
    .toBe(true);
}

async function configureChunks(page: Page) {
  await page.locator("#chunkSettingsToggle").click();
  await page.locator("#chunk-width").fill("4000");
  await page.locator("#chunk-height").fill("3000");
  await page.locator("#chunk-margin").fill("800");
  await page.locator(".chunk-settings-dialog button[type=submit]").click();
  await expect(page.locator(".chunk-settings-dialog")).toHaveCount(0);
}

test("the grid button emphasizes configured chunk borders in grid and dot modes", async ({
  page,
  context,
  server,
  boardPage,
}) => {
  await context.addCookies([
    { name: "wbo-user-secret-v1", value: secret, url: server.serverUrl },
  ]);
  await boardPage.gotoBoard("chunks");
  // The grid can be enabled before a moderator configures chunks.
  await boardPage.waitForToolBooted("grid");
  await boardPage.tool("grid").click();
  await configureChunks(page);
  const border = page.locator("#activityChunkGrid path");
  await expect(border).toHaveAttribute("stroke-width", "8");
  await expect(page.locator("#activityChunkGrid")).toHaveAttribute(
    "width",
    "4000",
  );
  await boardPage.waitForToolBooted("grid");
  await boardPage.tool("grid").click();
  await expect(page.locator("#gridContainer")).toHaveAttribute(
    "fill",
    "url(#dots)",
  );
  await expect(border).toHaveAttribute("stroke-width", "8");
  await boardPage.waitForToolBooted("grid");
  await boardPage.tool("grid").click();
  await expect(border).toHaveAttribute("stroke-width", "1");
});

test("following holds the camera during a pencil stroke in another chunk and then eases to it", async ({
  page,
  context,
  server,
  boardPage,
}) => {
  await context.addCookies([
    { name: "wbo-user-secret-v1", value: secret, url: server.serverUrl },
  ]);
  await boardPage.gotoBoard("chunks");
  await configureChunks(page);
  await page.locator("#chunkFollowToggle").click();
  await expect
    .poll(async () => (await camera(page)).centerErrorX)
    .toBeLessThan(2);
  await boardPage.selectTool("pencil");
  const start = await page.evaluate(() => {
    const viewport = window.WBOApp.viewportState.controller;
    return {
      ...viewport.boardRectToViewportRect({
        x: 4100,
        y: 1500,
        width: 0,
        height: 0,
      }),
      scrollX,
      scrollY,
      scale: viewport.getScale(),
    };
  });
  await page.mouse.move(start.left, start.top);
  await page.mouse.down();
  await expect
    .poll(() => page.evaluate(() => window.WBOApp.chunks.state.point.x))
    .toBeGreaterThan(4000);
  expect(await page.evaluate(() => ({ x: scrollX, y: scrollY }))).toEqual({
    x: start.scrollX,
    y: start.scrollY,
  });
  await page.mouse.move(start.left + 12, start.top + 6);
  await expect
    .poll(() => page.evaluate(() => window.WBOApp.chunks.state.point.x))
    .toBeGreaterThan(4105);
  expect(await page.evaluate(() => ({ x: scrollX, y: scrollY }))).toEqual({
    x: start.scrollX,
    y: start.scrollY,
  });
  await page.mouse.up();
  await expect
    .poll(async () => (await camera(page)).centerErrorX)
    .toBeLessThan(2);
  const response = await page.request.get(`${server.serverUrl}/archive/chunks`);
  expect(response.ok()).toBe(true);
  const archive = JSON.parse(gunzipSync(await response.body()).toString());
  const points = archive.items.find(
    (item: { tool: string }) => item.tool === "pencil",
  )._children as { x: number; y: number }[];
  expect(points.length).toBeGreaterThan(1);
  expect(
    Math.max(...points.map((p) => p.x)) - Math.min(...points.map((p) => p.x)),
  ).toBeLessThan(200);
  expect(
    Math.max(...points.map((p) => p.y)) - Math.min(...points.map((p) => p.y)),
  ).toBeLessThan(200);
});

test("chunk transitions ease through intermediate positions and block pencil input until settled", async ({
  page,
  context,
  server,
  boardPage,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await context.addCookies([
    { name: "wbo-user-secret-v1", value: secret, url: server.serverUrl },
  ]);
  await boardPage.gotoBoard("chunks");
  await configureChunks(page);
  await page.locator("#chunkFollowToggle").click();
  await boardPage.selectTool("pencil");
  const samples = await page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const app = window.WBOApp;
        const initial = scrollX;
        const positions: number[] = [];
        let pressed = false;
        const pointer = (type: string, buttons: number) =>
          document.getElementById("board")?.dispatchEvent(
            new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              clientX: 500,
              clientY: 300,
              button: 0,
              buttons,
            }),
          );
        const observe = () => {
          positions.push(scrollX);
          if (app.viewportState.controller.isFollowCameraMoving()) {
            // Dispatch within the animation frame so this reliably tests movement,
            // even when browser automation is delayed by a busy test runner.
            if (!pressed) {
              pointer("mousedown", 1);
              pressed = true;
            }
            pointer("mousemove", 1);
          }
          if (app.chunks.state.point.x > 20000) {
            const rect = app.viewportState.controller.boardRectToViewportRect({
              x: 20000,
              y: 0,
              width: 4000,
              height: 3000,
            });
            const menu = document.getElementById("menu");
            if (!menu) throw new Error("Missing menu");
            const expected =
              (menu.getBoundingClientRect().right + 8 + innerWidth) / 2;
            if (
              !app.viewportState.controller.isFollowCameraMoving() &&
              Math.abs((rect.left + rect.right) / 2 - expected) < 1
            ) {
              pointer("mousemove", 1);
              pointer("mouseup", 0);
              resolve([initial, ...positions]);
              return;
            }
          }
          requestAnimationFrame(observe);
        };
        requestAnimationFrame(observe);
        app.writes.drawAndSend({
          tool: 3,
          type: 1,
          id: "smooth-rect",
          x: 20100,
          y: 100,
          x2: 20300,
          y2: 300,
          color: "#123456",
          size: 10,
        });
      }),
  );
  const first = samples[0] ?? 0;
  const last = samples[samples.length - 1] ?? 0;
  expect(last - first).toBeGreaterThan(100);
  expect(samples.some((value) => value > first + 2 && value < last - 2)).toBe(
    true,
  );
  for (let i = 1; i < samples.length; i++)
    expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1] ?? 0);

  await expect(
    page.locator(".wbo-pencil-live-path[d]:not([d=''])"),
  ).toHaveCount(0);
  await expect(page.locator("#drawingArea path")).toHaveCount(0);
  const response = await page.request.get(`${server.serverUrl}/archive/chunks`);
  expect(response.ok()).toBe(true);
  const archive = JSON.parse(gunzipSync(await response.body()).toString());
  expect(archive.items.map((item: { tool: string }) => item.tool)).toEqual([
    "rectangle",
  ]);
});

test("a peer's camera move finishes the pencil stroke and a held pointer cannot resume it", async ({
  page,
  context,
  server,
  boardPage,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await context.addCookies([
    { name: "wbo-user-secret-v1", value: secret, url: server.serverUrl },
  ]);
  await boardPage.gotoBoard("chunks");
  await configureChunks(page);
  await page.locator("#chunkFollowToggle").click();
  await boardPage.selectTool("pencil");
  const peer = await context.newPage();
  try {
    await createBoardPage(peer, server).gotoBoard("chunks");
    await page.mouse.move(500, 300);
    await page.mouse.down();
    await expect(
      page.locator(".wbo-pencil-live-path[d]:not([d=''])"),
    ).toHaveCount(1);
    await page.mouse.move(520, 310);
    await expect
      .poll(() => page.evaluate(() => window.WBOApp.replay.authoritativeSeq))
      .toBeGreaterThanOrEqual(3);
    const beforeResponse = await page.request.get(
      `${server.serverUrl}/archive/chunks`,
    );
    const before = JSON.parse(
      gunzipSync(await beforeResponse.body()).toString(),
    );
    await rectangle(peer, "peer-rect", 12100, 9100);
    await expect
      .poll(() => page.evaluate(() => window.WBOApp.chunks.state.point))
      .toEqual({ x: 12200, y: 9200 });
    await expect(
      page.locator(".wbo-pencil-live-path[d]:not([d=''])"),
    ).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.WBOApp.viewportState.controller.isFollowCameraMoving(),
        ),
      )
      .toBe(false);
    await expect
      .poll(async () => (await camera(page)).centerErrorX)
      .toBeLessThan(2);
    // The physical button remains down across the transition and after it.
    await page.mouse.move(540, 320);
    await page.mouse.move(560, 330);
    await page.mouse.up();
    const response = await page.request.get(
      `${server.serverUrl}/archive/chunks`,
    );
    const archive = JSON.parse(gunzipSync(await response.body()).toString());
    expect(
      archive.items.filter((item: { tool: string }) => item.tool === "pencil"),
    ).toEqual(before.items);
    expect(await page.evaluate(() => window.WBOApp.chunks.state.point)).toEqual(
      { x: 12200, y: 9200 },
    );
    // A fresh press works normally once the camera has stopped.
    await page.mouse.down();
    await expect(
      page.locator(".wbo-pencil-live-path[d]:not([d=''])"),
    ).toHaveCount(1);
    await page.mouse.move(580, 340);
    await page.mouse.up();
    await expect(page.locator("#drawingArea path")).toHaveCount(2);
    await expect
      .poll(() => page.evaluate(() => window.WBOApp.replay.authoritativeSeq))
      .toBeGreaterThanOrEqual(6);
  } finally {
    await peer.close();
  }
});

test("moderators configure chunks, lock viewers on activity, and release the camera", async ({
  page,
  context,
  browser,
  server,
  boardPage,
}) => {
  await context.addCookies([
    { name: "wbo-user-secret-v1", value: secret, url: server.serverUrl },
  ]);
  await boardPage.gotoBoard("chunks");
  const viewerContext = await browser.newContext();
  const viewer = await viewerContext.newPage();
  const viewerBoard = createBoardPage(viewer, server);
  try {
    await viewerBoard.gotoBoard("chunks");
    await expect(viewer.locator("#chunkSettingsToggle")).toBeHidden();
    await page.locator("#chunkSettingsToggle").click();
    await page.locator("#chunk-width").fill("4000");
    await page.locator("#chunk-height").fill("3000");
    await page.locator("#chunk-margin").fill("300");
    await page.locator("#chunk-follow").check();
    await page.locator("#chunk-locked").check();
    await page.locator(".chunk-settings-dialog button[type=submit]").click();
    await expect(page.locator(".chunk-settings-dialog")).toHaveCount(0);
    await expect(viewer.locator("#chunkFollowToggle")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(viewer.locator("#chunkFollowToggle")).toBeDisabled();
    await expect(page.locator("#chunkFollowToggle")).toBeEnabled();
    await expect
      .poll(async () => (await camera(viewer)).centerErrorX)
      .toBeLessThan(2);
    await expect
      .poll(async () => (await camera(viewer)).centerErrorY)
      .toBeLessThan(2);
    expect((await camera(viewer)).fits).toBe(true);
    await rectangle(page, "r1", 12000, 9000);
    await expect
      .poll(() => viewer.evaluate(() => window.WBOApp.chunks.state.point))
      .toEqual({ x: 12100, y: 9100 });
    await expect
      .poll(async () => (await camera(viewer)).centerErrorX)
      .toBeLessThan(2);
    await expect
      .poll(async () => (await camera(viewer)).centerErrorY)
      .toBeLessThan(2);
    const before = await camera(viewer);
    await viewer.mouse.move(600, 400);
    await viewer.mouse.wheel(0, -300);
    await viewer.evaluate(() => {
      window.WBOApp.viewportState.controller.panBy(300, 300);
      window.WBOApp.viewportState.controller.setScale(1);
      window.scrollTo(0, 0);
    });
    await expect
      .poll(async () => (await camera(viewer)).centerErrorX)
      .toBeLessThan(2);
    expect((await camera(viewer)).scale).toBe(before.scale);
    await viewer.setViewportSize({ width: 700, height: 500 });
    await expect
      .poll(async () => (await camera(viewer)).centerErrorY)
      .toBeLessThan(2);
    expect((await camera(viewer)).fits).toBe(true);
    await viewer.reload();
    await viewerBoard.waitForSocketConnected();
    await expect(viewer.locator("#chunkFollowToggle")).toBeDisabled();
    await expect
      .poll(async () => (await camera(viewer)).centerErrorX)
      .toBeLessThan(2);
    await page.locator("#chunkSettingsToggle").click();
    await page.locator("#chunk-follow").uncheck();
    await page.locator("#chunk-locked").uncheck();
    await page.locator(".chunk-settings-dialog button[type=submit]").click();
    await expect(page.locator(".chunk-settings-dialog")).toHaveCount(0);
    await expect(viewer.locator("#chunkFollowToggle")).toBeEnabled();
    await expect(viewer.locator("#chunkFollowToggle")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await viewer.locator("#chunkFollowToggle").click();
    await expect
      .poll(async () => (await camera(viewer)).centerErrorX)
      .toBeLessThan(2);
    await viewer.reload();
    await viewerBoard.waitForSocketConnected();
    await expect(viewer.locator("#chunkFollowToggle")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await viewer.locator("#chunkFollowToggle").click();
    await viewer.evaluate(() =>
      window.WBOApp.viewportState.controller.panTo(100, 200),
    );
    await expect
      .poll(() => viewer.evaluate(() => ({ x: scrollX, y: scrollY })))
      .toEqual({ x: 100, y: 200 });
  } finally {
    await viewerContext.close();
  }
});

test("personal following ignores cursor movement and rejected edits and keeps drawing coordinates correct", async ({
  page,
  boardPage,
}) => {
  await boardPage.gotoBoard("personal-chunks", { lang: "zh-CN" });
  await expect(page.locator("#chunkFollowToggle")).toHaveText("跟随最新编辑");
  await page.locator("#chunkFollowToggle").click();
  await rectangle(page, "r1", 20100, 14100);
  await expect
    .poll(() => page.evaluate(() => window.WBOApp.chunks.state.point))
    .toEqual({ x: 20200, y: 14200 });
  const state = await page.evaluate(() => ({
    point: window.WBOApp.chunks.state.point,
    seq: window.WBOApp.replay.authoritativeSeq,
  }));
  const rejection = page.evaluate(
    () =>
      new Promise((resolve) => {
        const socket = window.WBOApp.connection.socket;
        if (!socket) throw new Error("Missing socket");
        socket.once("mutation_rejected", resolve);
        socket.emit("broadcast", {
          tool: 3,
          type: 2,
          id: "missing",
          x: 100,
          y: 100,
          x2: 200,
          y2: 200,
        });
      }),
  );
  await rejection;
  expect(await page.evaluate(() => window.WBOApp.chunks.state.point)).toEqual(
    state.point,
  );
  await page.evaluate(() =>
    window.WBOApp.connection.socket?.emit("broadcast", {
      tool: 12,
      type: 2,
      x: 100,
      y: 100,
    }),
  );
  await expect(page.locator("#activityChunkGridContainer")).toBeVisible();
  // Convert in one frame: the camera may still be easing between browser calls.
  const point = await page.evaluate(() => {
    const { left, top } =
      window.WBOApp.viewportState.controller.boardRectToViewportRect({
        x: 22000,
        y: 16000,
        width: 0,
        height: 0,
      });
    return {
      x: window.WBOApp.coordinates.pageCoordinateToBoard(scrollX + left),
      y: window.WBOApp.coordinates.pageCoordinateToBoard(scrollY + top),
    };
  });
  expect(point.x).toBeCloseTo(22000, 0);
  expect(point.y).toBeCloseTo(16000, 0);
  await expect
    .poll(async () => (await camera(page)).centerErrorY)
    .toBeLessThan(2);
});
