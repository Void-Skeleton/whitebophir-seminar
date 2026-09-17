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
    const point =
      app.chunks.mode === "chunk" ? app.chunks.focusedPoint : state.point;
    const x = Math.floor(point.x / state.width) * state.width;
    const y = Math.floor(point.y / state.height) * state.height;
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

async function settledScroll(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.WBOApp.viewportState.controller.isFollowCameraMoving(),
      ),
    )
    .toBe(false);
  return page.evaluate(() => ({ x: scrollX, y: scrollY }));
}

test("personal wheel controls persist across boards without changing other users", async ({
  page,
  boardPage,
  browser,
  server,
}) => {
  await boardPage.gotoBoard("personal-wheel", { lang: "zh-CN" });
  const toggle = page.getByRole("combobox", {
    name: "滚轮操作（仅对自己生效）",
  });
  await expect(toggle).toHaveValue("zoom");
  await expect(page.locator("#chunkSettingsToggle")).toBeHidden();
  await toggle.selectOption("navigate");
  await boardPage.selectTool("hand");
  await page.evaluate(() => {
    const viewport = window.WBOApp.viewportState.controller;
    viewport.setScale(0.2);
    viewport.panTo(400, 600);
  });
  await page.mouse.move(500, 400);
  await page.mouse.wheel(0, 120);
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(664);
  await settledScroll(page);
  await page.keyboard.press("ArrowDown");
  expect(await settledScroll(page)).toEqual({ x: 400, y: 728 });
  await page.mouse.wheel(0, -120);
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(664);
  await settledScroll(page);
  expect(await page.evaluate(() => window.WBOApp.viewportState.scale)).toBe(
    0.2,
  );

  await page.keyboard.down("Control");
  await page.mouse.wheel(0, 120);
  await page.keyboard.up("Control");
  await expect
    .poll(() => page.evaluate(() => window.WBOApp.viewportState.scale))
    .toBeLessThan(0.2);
  const zoomed = await page.evaluate(() => ({
    scale: window.WBOApp.viewportState.scale,
    top: scrollY,
  }));
  await page.keyboard.down("Shift");
  await page.mouse.wheel(0, 300);
  await page.keyboard.up("Shift");
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(zoomed.top + 300);
  expect(await page.evaluate(() => window.WBOApp.viewportState.scale)).toBe(
    zoomed.scale,
  );

  const size = await page.evaluate(() => window.WBOApp.preferences.getSize());
  await page.keyboard.down("s");
  await page.mouse.wheel(0, -10);
  await page.keyboard.up("s");
  await expect
    .poll(() => page.evaluate(() => window.WBOApp.preferences.getSize()))
    .toBe(size + 5);
  expect(await page.evaluate(() => scrollY)).toBe(zoomed.top + 300);

  const peerContext = await browser.newContext();
  try {
    const peer = await peerContext.newPage();
    await createBoardPage(peer, server).gotoBoard("personal-wheel");
    await expect(peer.locator("#wheelMode")).toHaveValue("zoom");
    await expect(peer.locator("#chunkViewMode")).toHaveValue("free");
  } finally {
    await peerContext.close();
  }
  await page.reload();
  await boardPage.waitForSocketConnected();
  await expect(toggle).toHaveValue("navigate");
  await boardPage.gotoBoard("personal-wheel-other", { lang: "zh-TW" });
  await expect(
    page.getByRole("combobox", { name: "滾輪操作（僅對自己生效）" }),
  ).toHaveValue("navigate");
  await page.locator("#wheelMode").selectOption("zoom");
  await page.reload();
  await boardPage.waitForSocketConnected();
  await expect(page.locator("#wheelMode")).toHaveValue("zoom");
});

test("wheel navigation respects chunk focus and requires a separate gesture to leave latest focus", async ({
  page,
  context,
  server,
  boardPage,
}) => {
  await page.clock.install();
  await context.addCookies([
    { name: "wbo-user-secret-v1", value: secret, url: server.serverUrl },
  ]);
  await boardPage.gotoBoard("chunks");
  await configureChunks(page);
  await page.locator("#wheelMode").selectOption("navigate");
  await page.locator("#chunkViewMode").selectOption("latest");
  await settledScroll(page);
  await page.clock.pauseAt(new Date());
  const board = page.locator("#board");
  const down = () =>
    board.dispatchEvent("wheel", { deltaY: 120, cancelable: true });
  await down();
  await expect(page.locator("#boardStatusNotice")).toContainText(
    "scroll in the same direction",
  );
  await expect(page.locator("#chunkViewMode")).toHaveValue("latest");
  // A stream of wheel events, including momentum, acts like key auto-repeat.
  for (let i = 0; i < 4; i++) {
    await page.clock.runFor(150);
    await down();
    await expect(page.locator("#chunkViewMode")).toHaveValue("latest");
  }
  await page.clock.runFor(2100);
  await down();
  await expect(page.locator("#chunkViewMode")).toHaveValue("latest");
  await page.clock.runFor(200);
  await down();
  await expect(page.locator("#chunkViewMode")).toHaveValue("chunk");
  expect(await page.evaluate(() => window.WBOApp.chunks.focusedPoint)).toEqual({
    x: 0,
    y: 3000,
  });
  expect(
    await page.evaluate(() =>
      window.WBOApp.viewportState.controller.isFollowCameraMoving(),
    ),
  ).toBe(true);
  const before = await page.evaluate(() => scrollY);
  await page.clock.runFor(100);
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(before);
  expect(
    await page.evaluate(() =>
      window.WBOApp.viewportState.controller.isFollowCameraMoving(),
    ),
  ).toBe(true);
  await page.clock.runFor(200);
  expect((await camera(page)).fits).toBe(true);
  await board.dispatchEvent("wheel", {
    deltaY: -1,
    deltaMode: 1,
    cancelable: true,
  });
  await page.clock.runFor(300);
  expect(await page.evaluate(() => window.WBOApp.chunks.focusedPoint)).toEqual({
    x: 0,
    y: 0,
  });
  expect((await camera(page)).fits).toBe(true);
});

test("wheel navigation interrupts a held pencil and leaves text input alone", async ({
  page,
  boardPage,
}) => {
  await boardPage.gotoBoard("wheel-pencil");
  await page.locator("#wheelMode").selectOption("navigate");
  await page.evaluate(() =>
    window.WBOApp.viewportState.controller.setScale(0.5),
  );
  await boardPage.selectTool("pencil");
  await page.mouse.move(500, 300);
  await page.mouse.down();
  const livePath = page.locator(".wbo-pencil-live-path[d]:not([d=''])");
  await expect(livePath).toHaveCount(1);
  await expect
    .poll(() => page.evaluate(() => window.WBOApp.replay.authoritativeSeq))
    .toBe(2);
  await page.mouse.wheel(0, 120);
  await expect(livePath).toHaveCount(0);
  await settledScroll(page);
  await page.mouse.move(520, 320);
  await page.mouse.up();
  await expect(livePath).toHaveCount(0);
  expect(await page.evaluate(() => window.WBOApp.replay.authoritativeSeq)).toBe(
    2,
  );
  const inputResult = await page.evaluate(() => {
    const input = document.createElement("textarea");
    document.getElementById("board")?.append(input);
    const before = scrollY;
    const event = new WheelEvent("wheel", {
      deltaY: 120,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);
    input.remove();
    return {
      prevented: event.defaultPrevented,
      before,
      after: scrollY,
      moving: window.WBOApp.viewportState.controller.isFollowCameraMoving(),
    };
  });
  expect(inputResult.prevented).toBe(false);
  expect(inputResult.after).toBe(inputResult.before);
  expect(inputResult.moving).toBe(false);
  await page.mouse.down();
  await expect(livePath).toHaveCount(1);
  await page.mouse.up();
});

test("Ctrl+Arrow pans one chunk at the current zoom, easing and accumulating repeated keys", async ({
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
  await page.evaluate(() => {
    const viewport = window.WBOApp.viewportState.controller;
    viewport.setScale(0.2);
    viewport.panTo(1000, 900);
  });
  const before = await page.evaluate(() => ({
    point: window.WBOApp.chunks.state.point,
    seq: window.WBOApp.replay.authoritativeSeq,
  }));
  const positions = await page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const positions = [scrollX];
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "ArrowRight",
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
        const sample = () => {
          positions.push(scrollX);
          if (!window.WBOApp.viewportState.controller.isFollowCameraMoving())
            resolve(positions);
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
  );
  expect(positions.some((x) => x > 1000 && x < 1800)).toBe(true);
  expect(await settledScroll(page)).toEqual({ x: 1800, y: 900 });
  for (const [key, x, y] of [
    ["ArrowDown", 1800, 1500],
    ["ArrowLeft", 1000, 1500],
    ["ArrowUp", 1000, 900],
  ] as const) {
    await page.keyboard.press(`Control+${key}`);
    expect(await settledScroll(page)).toEqual({ x, y });
  }
  await page.evaluate(() => {
    for (const repeat of [false, true])
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          ctrlKey: true,
          repeat,
          bubbles: true,
          cancelable: true,
        }),
      );
  });
  expect(await settledScroll(page)).toEqual({ x: 2600, y: 900 });
  expect(await page.evaluate(() => window.WBOApp.viewportState.scale)).toBe(
    0.2,
  );
  expect(
    await page.evaluate(() => ({
      point: window.WBOApp.chunks.state.point,
      seq: window.WBOApp.replay.authoritativeSeq,
    })),
  ).toEqual(before);
  // A manual pan cancels an in-flight shortcut rather than fighting its frames.
  await page.evaluate(() => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    window.WBOApp.viewportState.controller.panTo(0, 0);
  });
  expect(await settledScroll(page)).toEqual({ x: 0, y: 0 });
  await page.keyboard.press("Control+ArrowLeft");
  await page.keyboard.press("Control+ArrowUp");
  expect(await settledScroll(page)).toEqual({ x: 0, y: 0 });
  await page.keyboard.press("ArrowRight");
  expect(await settledScroll(page)).toEqual({ x: 64, y: 0 });
  await page.keyboard.press("ArrowDown");
  expect(await settledScroll(page)).toEqual({ x: 64, y: 64 });
});

test("chunk focus stays on its selected chunk through editing, resize and reload", async ({
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
  await page.locator("#chunkViewMode").selectOption("chunk");
  await boardPage.selectTool("hand");
  await settledScroll(page);
  const before = await page.evaluate(() => window.WBOApp.chunks.focusedPoint);
  await page.keyboard.press("ArrowRight");
  await settledScroll(page);
  await page.keyboard.press("Control+ArrowDown");
  await settledScroll(page);
  const point = await page.evaluate(() => window.WBOApp.chunks.focusedPoint);
  expect(point).toEqual({
    x: Math.floor(before.x / 4000) * 4000 + 4000,
    y: Math.floor(before.y / 3000) * 3000 + 3000,
  });
  expect((await camera(page)).centerErrorX).toBeLessThan(2);
  expect((await camera(page)).centerErrorY).toBeLessThan(2);
  const scale = (await camera(page)).scale;
  await page.evaluate(() => {
    window.WBOApp.viewportState.controller.panBy(300, 300);
    window.WBOApp.viewportState.controller.setScale(1);
  });
  expect((await camera(page)).scale).toBe(scale);
  await rectangle(page, "outside-focus", 60100, 50100);
  await expect
    .poll(() => page.evaluate(() => window.WBOApp.chunks.state.point.x))
    .toBe(60200);
  expect(await page.evaluate(() => window.WBOApp.chunks.focusedPoint)).toEqual(
    point,
  );
  await page.setViewportSize({ width: 700, height: 500 });
  // Resizing the browser can return before its resize event starts the camera.
  await expect
    .poll(async () => {
      const view = await camera(page);
      return view.centerErrorX < 2 && view.centerErrorY < 2 && view.fits;
    })
    .toBe(true);
  await page.reload();
  await boardPage.waitForSocketConnected();
  await expect(page.locator("#chunkViewMode")).toHaveValue("chunk");
  expect(await page.evaluate(() => window.WBOApp.chunks.focusedPoint)).toEqual(
    point,
  );
});

test("leaving latest-edit focus requires a matching fresh press within two seconds", async ({
  page,
  context,
  server,
  boardPage,
}) => {
  await page.clock.install();
  await context.addCookies([
    { name: "wbo-user-secret-v1", value: secret, url: server.serverUrl },
  ]);
  await boardPage.gotoBoard("chunks");
  await configureChunks(page);
  await rectangle(page, "latest-point", 12100, 9100);
  await expect
    .poll(() => page.evaluate(() => window.WBOApp.chunks.state.point.x))
    .toBe(12200);
  await page.locator("#chunkViewMode").selectOption("latest");
  await boardPage.selectTool("hand");
  const before = await settledScroll(page);
  await page.keyboard.press("ArrowRight");
  expect(await settledScroll(page)).toEqual(before);
  await expect(page.locator("#boardStatusNotice")).toContainText("2 seconds");
  await page.clock.fastForward(2100);
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#chunkViewMode")).toHaveValue("latest");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#chunkViewMode")).toHaveValue("latest");
  await page.keyboard.press("Control+ArrowDown");
  await expect(page.locator("#chunkViewMode")).toHaveValue("latest");
  await page.keyboard.press("Control+ArrowDown");
  await expect(page.locator("#chunkViewMode")).toHaveValue("chunk");
  await settledScroll(page);
  expect(await page.evaluate(() => window.WBOApp.chunks.focusedPoint)).toEqual({
    x: 12000,
    y: 12000,
  });
  await page.locator("#chunkViewMode").selectOption("latest");
  await boardPage.selectTool("hand");
  await settledScroll(page);
  await page.keyboard.down("ArrowRight");
  await page.keyboard.down("ArrowRight");
  await expect(page.locator("#chunkViewMode")).toHaveValue("latest");
  await page.keyboard.up("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#chunkViewMode")).toHaveValue("chunk");
});

test("chunk shortcuts require configuration and leave form and text editing alone", async ({
  page,
  context,
  server,
  boardPage,
}) => {
  await context.addCookies([
    { name: "wbo-user-secret-v1", value: secret, url: server.serverUrl },
  ]);
  await boardPage.gotoBoard("chunks");
  expect(
    await page.evaluate(() => {
      const event = new KeyboardEvent("keydown", {
        key: "ArrowRight",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      document.body.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(false);
  await configureChunks(page);
  await page.locator("#chunkSettingsToggle").click();
  await page.locator("#chunk-width").focus();
  const before = await settledScroll(page);
  await page.keyboard.press("Control+ArrowRight");
  expect(await settledScroll(page)).toEqual(before);
  await page.keyboard.press("Escape");
  expect(
    await page.evaluate(() => {
      const editor = document.createElement("div");
      editor.contentEditable = "true";
      document.body.append(editor);
      const event = new KeyboardEvent("keydown", {
        key: "ArrowDown",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(event);
      editor.remove();
      return event.defaultPrevented;
    }),
  ).toBe(false);
  await page.keyboard.press("Control+Shift+ArrowRight");
  expect(await settledScroll(page)).toEqual(before);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await page.evaluate(() => {
      const start = scrollX;
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      return {
        moving: window.WBOApp.viewportState.controller.isFollowCameraMoving(),
        delta: scrollX - start,
        scale: window.WBOApp.viewportState.scale,
      };
    }),
  ).toEqual({ moving: false, delta: 400, scale: 0.1 });
});

test("chunk navigation pauses personal following and interrupts a held pencil stroke", async ({
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
  await page.locator("#chunkViewMode").selectOption("latest");
  await boardPage.selectTool("pencil");
  await page.mouse.move(500, 300);
  await page.mouse.down();
  await expect(
    page.locator(".wbo-pencil-live-path[d]:not([d=''])"),
  ).toHaveCount(1);
  await expect
    .poll(() => page.evaluate(() => window.WBOApp.replay.authoritativeSeq))
    .toBe(2);
  await page.keyboard.press("Control+ArrowRight");
  await expect(page.locator("#chunkViewMode")).toHaveValue("latest");
  await page.keyboard.press("Control+ArrowRight");
  await expect(page.locator("#chunkViewMode")).toHaveValue("chunk");
  await expect(
    page.locator(".wbo-pencil-live-path[d]:not([d=''])"),
  ).toHaveCount(0);
  await settledScroll(page);
  await page.mouse.move(520, 310);
  await page.mouse.up();
  const response = await page.request.get(`${server.serverUrl}/archive/chunks`);
  expect(response.ok()).toBe(true);
  const archive = JSON.parse(gunzipSync(await response.body()).toString());
  expect(archive.items).toHaveLength(1);
  expect(archive.items[0]._children).toHaveLength(1);
  expect(await page.evaluate(() => window.WBOApp.replay.authoritativeSeq)).toBe(
    2,
  );
  // Fresh presses work after movement, including with following already off.
  await page.mouse.down();
  await expect(
    page.locator(".wbo-pencil-live-path[d]:not([d=''])"),
  ).toHaveCount(1);
  await page.keyboard.press("Control+ArrowDown");
  await expect(
    page.locator(".wbo-pencil-live-path[d]:not([d=''])"),
  ).toHaveCount(0);
  await settledScroll(page);
  await page.mouse.up();
  await expect(page.locator("#drawingArea path")).toHaveCount(2);
});

test("saved chunk borders remain highlighted with the grid off, on, or dotted", async ({
  page,
  context,
  server,
  boardPage,
  browser,
}) => {
  await context.addCookies([
    { name: "wbo-user-secret-v1", value: secret, url: server.serverUrl },
  ]);
  await boardPage.gotoBoard("chunks");
  await boardPage.waitForToolBooted("grid");
  await expect(page.locator("#gridContainer")).toHaveAttribute("fill", "none");
  await configureChunks(page);
  const border = page.locator("#activityChunkGrid path");
  await expect(page.locator("#chunkViewMode")).toHaveValue("free");
  await expect(page.locator("#activityChunkGridContainer")).toBeVisible();
  await expect(border).toHaveAttribute("stroke-width", "8");
  await expect(border).toHaveAttribute("stroke", "#475569");
  await expect(page.locator("#activityChunkGrid")).toHaveAttribute(
    "width",
    "4000",
  );
  await boardPage.waitForToolBooted("grid");
  await boardPage.tool("grid").click();
  await expect(page.locator("#gridContainer")).toHaveAttribute(
    "fill",
    "url(#grid)",
  );
  await expect(border).toHaveAttribute("stroke-width", "8");
  await boardPage.tool("grid").click();
  await expect(page.locator("#gridContainer")).toHaveAttribute(
    "fill",
    "url(#dots)",
  );
  await expect(border).toHaveAttribute("stroke-width", "8");
  await boardPage.waitForToolBooted("grid");
  await boardPage.tool("grid").click();
  await expect(page.locator("#gridContainer")).toHaveAttribute("fill", "none");
  await expect(border).toHaveAttribute("stroke-width", "8");

  // A new browser has no local settings and must recover them from board data.
  const freshContext = await browser.newContext();
  try {
    const freshPage = await freshContext.newPage();
    await createBoardPage(freshPage, server).gotoBoard("chunks");
    await expect(freshPage.locator("#chunkViewMode")).toHaveValue("free");
    await expect(freshPage.locator("#gridContainer")).toHaveAttribute(
      "fill",
      "none",
    );
    await expect(
      freshPage.locator("#activityChunkGridContainer"),
    ).toBeVisible();
    await expect(freshPage.locator("#activityChunkGrid")).toHaveAttribute(
      "width",
      "4000",
    );
    await expect(freshPage.locator("#activityChunkGrid")).toHaveAttribute(
      "height",
      "3000",
    );
    await expect(freshPage.locator("#activityChunkGrid path")).toHaveAttribute(
      "stroke-width",
      "8",
    );
  } finally {
    await freshContext.close();
  }
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
  await page.locator("#chunkViewMode").selectOption("latest");
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
  await page.locator("#chunkViewMode").selectOption("latest");
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

test("a viewer eases to a remote edit through intermediate camera positions", async ({
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
  await configureChunks(page);
  const viewerContext = await browser.newContext({
    viewport: { width: 800, height: 600 },
    reducedMotion: "no-preference",
  });
  try {
    const viewer = await viewerContext.newPage();
    await createBoardPage(viewer, server).gotoBoard("chunks");
    await viewer.locator("#chunkViewMode").selectOption("latest");
    await settledScroll(viewer);
    const samplesPromise = viewer.evaluate(
      () =>
        new Promise<number[]>((resolve) => {
          const app = window.WBOApp;
          const positions = [scrollX];
          const sample = () => {
            positions.push(scrollX);
            if (
              app.chunks.state.point.x > 20000 &&
              !app.viewportState.controller.isFollowCameraMoving()
            )
              resolve(positions);
            else requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        }),
    );
    await rectangle(page, "remote-smooth-rect", 20100, 100);
    const samples = await samplesPromise;
    const first = samples[0] ?? 0;
    const last = samples[samples.length - 1] ?? 0;
    expect(last - first).toBeGreaterThan(100);
    expect(
      samples.filter((x) => x > first + 2 && x < last - 2).length,
    ).toBeGreaterThan(2);
    expect((await camera(viewer)).centerErrorX).toBeLessThan(2);
  } finally {
    await viewerContext.close();
  }
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
  await page.locator("#chunkViewMode").selectOption("latest");
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

test("moderators apply view modes once and users can override them", async ({
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
    await page.locator("#chunk-view-mode").selectOption("latest");
    await page.locator(".chunk-settings-dialog button[type=submit]").click();
    await expect(page.locator(".chunk-settings-dialog")).toHaveCount(0);
    await expect(viewer.locator("#chunkViewMode")).toHaveValue("latest");
    await expect(viewer.locator("#chunkViewMode")).toBeEnabled();
    await expect(page.locator("#chunkViewMode")).toHaveValue("free");
    await rectangle(page, "r1", 12000, 9000);
    await expect
      .poll(() => viewer.evaluate(() => window.WBOApp.chunks.state.point))
      .toEqual({ x: 12100, y: 9100 });
    await settledScroll(viewer);
    expect((await camera(viewer)).centerErrorX).toBeLessThan(2);
    expect((await camera(viewer)).fits).toBe(true);
    await viewer.keyboard.press("Control+ArrowRight");
    await expect(viewer.locator("#boardStatusNotice")).toContainText(
      "2 seconds",
    );
    await viewer.keyboard.press("Control+ArrowRight");
    await expect(viewer.locator("#chunkViewMode")).toHaveValue("chunk");
    await settledScroll(viewer);
    const point = await viewer.evaluate(
      () => window.WBOApp.chunks.focusedPoint,
    );
    expect(point).toEqual({ x: 16000, y: 9000 });
    await viewer.reload();
    await viewerBoard.waitForSocketConnected();
    await expect(viewer.locator("#chunkViewMode")).toHaveValue("chunk");
    expect(
      await viewer.evaluate(() => window.WBOApp.chunks.focusedPoint),
    ).toEqual(point);
    // A new moderator revision applies once again, without changing their own mode.
    await page.locator("#chunkSettingsToggle").click();
    await page.locator("#chunk-view-mode").selectOption("free");
    await page.locator(".chunk-settings-dialog button[type=submit]").click();
    await expect(viewer.locator("#chunkViewMode")).toHaveValue("free");
    await viewer.locator("#chunkViewMode").selectOption("latest");
    await page.locator("#chunkSettingsToggle").click();
    await page.locator("#chunk-view-mode").selectOption("chunk");
    await page.locator(".chunk-settings-dialog button[type=submit]").click();
    await expect(viewer.locator("#chunkViewMode")).toHaveValue("chunk");
    await viewer.locator("#chunkViewMode").selectOption("free");
    await viewer.reload();
    await viewerBoard.waitForSocketConnected();
    await expect(viewer.locator("#chunkViewMode")).toHaveValue("free");
  } finally {
    await viewerContext.close();
  }
});

test("personal following ignores cursor movement and rejected edits and keeps drawing coordinates correct", async ({
  page,
  boardPage,
}) => {
  await boardPage.gotoBoard("personal-chunks", { lang: "zh-CN" });
  await expect(page.locator("#chunkViewMode option[value=latest]")).toHaveText(
    "聚焦最新编辑分块",
  );
  await page.locator("#chunkViewMode").selectOption("latest");
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
