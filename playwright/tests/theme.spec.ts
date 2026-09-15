// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-16: shared dark mode and rendered colors.
import { createBoardPage, expect, test } from "../fixtures/test";
import { THEME_SVG_RESOURCES } from "../../client-data/js/board_theme.js";

const secret = "12".repeat(16);
test.use({
  serverOptions: { env: { WBO_BOARD_MODERATORS: `theme:${secret}` } },
});

test("moderator themes synchronize, persist and keep grids white while strokes retain their colors", async ({
  page,
  boardPage,
  browser,
  context,
  server,
}) => {
  await context.addCookies([
    { name: "wbo-user-secret-v1", value: secret, url: server.serverUrl },
  ]);
  await server.writeBoard(server.dataPath, "theme", {
    r1: {
      id: "r1",
      tool: "rectangle",
      x: 100,
      y: 100,
      x2: 300,
      y2: 300,
      color: "#ffcccc",
      size: 30,
    },
    far: {
      id: "far",
      tool: "rectangle",
      x: 100000,
      y: 100000,
      x2: 100200,
      y2: 100200,
      color: "#000000",
      size: 30,
    },
  });
  await boardPage.gotoBoard("theme", { lang: "en" });
  const peerContext = await browser.newContext();
  try {
    const peer = await peerContext.newPage();
    const peerBoard = createBoardPage(peer, server);
    await peerBoard.gotoBoard("theme", { lang: "en" });
    await expect(peer.locator("#boardThemeToggle")).toBeHidden();
    await page.locator("#chunkSettingsToggle").click();
    await page.locator("#chunk-width").fill("4000");
    await page.locator("#chunk-height").fill("3000");
    await page.locator(".chunk-settings-dialog button[type=submit]").click();
    await expect(page.locator(".chunk-settings-dialog")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Board dark mode", exact: true })
      .click();
    for (const viewer of [page, peer]) {
      await expect(viewer.locator("#canvas")).toHaveAttribute(
        "data-wbo-theme",
        "dark",
      );
      await expect(viewer.locator("body")).toHaveCSS(
        "background-color",
        "rgb(32, 32, 32)",
      );
      await expect(viewer.locator("#activityChunkGrid path")).toHaveCSS(
        "stroke",
        "rgb(255, 255, 255)",
      );
      await expect(viewer.locator("#r1")).toHaveAttribute("stroke", "#ffcccc");
      await expect(viewer.locator("#chooseColor")).toHaveValue("#ffffff");
      await expect(viewer.locator("#stylePreviewDot")).toHaveAttribute(
        "fill",
        "#ffffff",
      );
    }
    // Check actual screen pixels too: a large board must not lose nearby ink
    // through filter-surface bounds or downsampling.
    const inkScreenshot = await page.locator("#r1").screenshot();
    const ink = await page.evaluate(async (png) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Missing context");
      ctx.drawImage(img, 0, 0);
      return Array.from(ctx.getImageData(15, 50, 1, 1).data);
    }, inkScreenshot.toString("base64"));
    expect(ink).toEqual([77, 32, 32, 255]);
    await boardPage.waitForToolBooted("grid");
    await boardPage.tool("grid").click();
    await expect(page.locator("#grid path")).toHaveCSS(
      "stroke",
      "rgb(255, 255, 255)",
    );
    await expect(page.locator("#smallGrid path")).toHaveCSS(
      "stroke",
      "rgb(255, 255, 255)",
    );
    await boardPage.tool("grid").click();
    await expect(page.locator("#dots circle")).toHaveCSS(
      "fill",
      "rgb(255, 255, 255)",
    );
    await peerBoard.selectTool("pencil");
    await peer.mouse.move(420, 300);
    await peer.mouse.down();
    await peer.mouse.move(500, 360);
    await expect(peer.locator(".wbo-pencil-live-overlay")).toHaveCSS(
      "filter",
      /wbo-dark-colors/,
    );
    await peer.mouse.up();
    await expect(page.locator("#drawingArea path")).toHaveCount(1);
    await expect(page.locator("#drawingArea path")).toHaveAttribute(
      "stroke",
      "#000000",
    );
    await peerBoard.gotoBoard("theme", { lang: "en" });
    await expect(peer.locator("#canvas")).toHaveAttribute(
      "data-wbo-theme",
      "dark",
    );
    await peerBoard.selectTool("text");
    await peer.mouse.click(450, 450);
    await expect(peer.locator("#textToolInput")).toHaveCSS(
      "caret-color",
      "rgb(255, 255, 255)",
    );
    await page.locator("#boardThemeToggle").click();
    await expect(peer.locator("#canvas")).toHaveAttribute(
      "data-wbo-theme",
      "light",
    );
    await expect(peer.locator("#drawingArea")).toHaveCSS("filter", "none");
    await expect(peer.locator("#textToolInput")).toHaveCSS(
      "caret-color",
      "rgb(0, 0, 0)",
    );
    await expect(peer.locator("#r1")).toHaveAttribute("stroke", "#ffcccc");
    await expect(page.locator("#dots circle")).toHaveCSS(
      "fill",
      "rgb(128, 128, 128)",
    );
    await expect(page.locator("#activityChunkGrid path")).toHaveCSS(
      "stroke",
      "rgb(71, 85, 105)",
    );
  } finally {
    await peerContext.close();
  }
});

test("the SVG color transform renders exact endpoints, same-hue reds, and translucent strokes", async ({
  page,
  boardPage,
}) => {
  await boardPage.gotoBoard("colors");
  const pixels = await page.evaluate(async (resources) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="100" data-wbo-theme="dark">${resources}<g id="drawingArea"><rect width="100" height="100" fill="#000000"/><rect x="100" width="100" height="100" fill="#ffffff"/><rect x="200" width="100" height="100" fill="#ffcccc"/><rect x="300" width="100" height="100" fill="#ff0000"/><rect x="400" width="100" height="100" fill="#000000" opacity="0.5"/></g></svg>`;
    const img = new Image();
    img.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 500;
    canvas.height = 100;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Missing canvas context");
    ctx.drawImage(img, 0, 0);
    return [50, 150, 250, 350, 450].map((x) =>
      Array.from(ctx.getImageData(x, 50, 1, 1).data),
    );
  }, THEME_SVG_RESOURCES);
  expect(pixels.slice(0, 4)).toEqual([
    [255, 255, 255, 255],
    [32, 32, 32, 255],
    [77, 32, 32, 255],
    [255, 32, 32, 255],
  ]);
  // Half-opacity white over the dark background, within integer compositing precision.
  expect(
    pixels[4]?.slice(0, 3).every((value) => Math.abs(value - 144) <= 1),
  ).toBe(true);
});

test("single horizontal strokes and distant content do not disappear in dark mode", async ({
  page,
  boardPage,
}) => {
  await boardPage.gotoBoard("line-colors");
  const pixels = await page.evaluate(async (resources) => {
    const results = [];
    for (const far of [
      "",
      '<path d="M 1000000 1000000 l 10 10" stroke="#000000"/>',
    ]) {
      const img = new Image();
      img.src = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" data-wbo-theme="dark">${resources}<g id="drawingArea"><path d="M 10 50 l 80 0" stroke="#000000" stroke-width="20"/>${far}</g></svg>`)}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 100;
      canvas.height = 100;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Missing context");
      ctx.drawImage(img, 0, 0);
      results.push(Array.from(ctx.getImageData(50, 50, 1, 1).data));
    }
    return results;
  }, THEME_SVG_RESOURCES);
  expect(pixels).toEqual([
    [255, 255, 255, 255],
    [255, 255, 255, 255],
  ]);
});
