// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-14: native backup UI and peer synchronization.
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { createBoardPage, expect, test } from "../fixtures/test";

const moderatorSecret = "0123456789abcdef0123456789abcdef";
const chunks = { width: 4000, height: 3000, margin: 800, viewMode: "free" };

test.use({
  serverOptions: {
    env: {
      WBO_BOARD_MODERATORS: [
        "archive-source",
        "archive-target",
        "archive-invalid",
        "archive-temporary",
      ]
        .map((board) => `${board}:${moderatorSecret}`)
        .join(" "),
    },
  },
});

test.beforeEach(async ({ context, server }) => {
  await context.addCookies([
    {
      name: "wbo-user-secret-v1",
      value: moderatorSecret,
      url: server.serverUrl,
    },
  ]);
});

test("board moderators can save and restore editable backups from the Download button", async ({
  boardPage,
  page,
  server,
  context,
}) => {
  await server.writeBoard(server.dataPath, "archive-source", {
    r1: {
      id: "r1",
      tool: "rectangle",
      color: "#123456",
      size: 10,
      opacity: 0.4,
      x: 100,
      y: 100,
      x2: 200,
      y2: 200,
    },
    l1: {
      id: "l1",
      tool: "pencil",
      color: "#112233",
      size: 10,
      _children: [
        { x: 300, y: 300 },
        { x: 350, y: 360 },
      ],
      transform: { a: 1, b: 0, c: 0, d: 1, e: 20, f: 30 },
    },
    t1: {
      id: "t1",
      tool: "text",
      color: "#000000",
      size: 24,
      x: 200,
      y: 400,
      txt: "你好 <script> & café",
    },
  });
  await boardPage.gotoBoard("archive-source", { lang: "en" });
  await expect
    .poll(() => page.evaluate(() => window.WBOApp.access.canBan))
    .toBe(true);
  await page.locator("#chunkSettingsToggle").click();
  await page.locator("#chunk-width").fill(String(chunks.width));
  await page.locator("#chunk-height").fill(String(chunks.height));
  await page.locator("#chunk-margin").fill(String(chunks.margin));
  await page.locator("#chunk-view-mode").selectOption(chunks.viewMode);
  await page.locator(".chunk-settings-dialog button[type=submit]").click();
  await expect(page.locator(".chunk-settings-dialog")).toHaveCount(0);
  const originalTransform = await page
    .locator("#drawingArea path")
    .getAttribute("transform");
  if (!originalTransform) throw new Error("Source stroke transform is missing");
  await boardPage.tool("download").click();
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export WBO backup", exact: true })
    .click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("archive-source.wbo");
  const file = await download.path();
  if (!file) throw new Error("Missing downloaded archive");
  const archive = JSON.parse(gunzipSync(await readFile(file)).toString("utf8"));
  expect(archive.items).toHaveLength(3);
  expect(archive.chunks).toEqual(chunks);

  await server.writeBoard(server.dataPath, "archive-target", {
    existing: {
      id: "existing",
      tool: "ellipse",
      color: "#aabbcc",
      size: 10,
      x: 500,
      y: 500,
      x2: 600,
      y2: 600,
    },
  });
  await boardPage.gotoBoard("archive-target", { lang: "en" });
  const peer = await context.newPage();
  const peerBoard = createBoardPage(peer, server);
  await peerBoard.gotoBoard("archive-target", { lang: "en" });
  await peerBoard.waitForSocketConnected();
  await boardPage.waitForSocketConnected();
  await boardPage.tool("download").click();
  const choosing = page.waitForEvent("filechooser");
  await page
    .getByRole("button", { name: "Import WBO backup", exact: true })
    .click();
  await (await choosing).setFiles(file);
  await expect(
    page.getByText("Backup imported.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "I understand", exact: true }).click();
  for (const viewer of [page, peer]) {
    await expect(viewer.locator("#drawingArea > *")).toHaveCount(4);
    await expect(viewer.locator("#drawingArea text")).toHaveText(
      "你好 <script> & café",
    );
    await expect(viewer.locator("#drawingArea path")).toHaveAttribute(
      "transform",
      originalTransform,
    );
    await expect(viewer.locator("#existing")).toBeAttached();
    await expect
      .poll(() => viewer.evaluate(() => window.WBOApp.chunks.state))
      .toMatchObject(chunks);
    await expect(viewer.locator("#activityChunkGrid")).toHaveAttribute(
      "width",
      "4000",
    );
    await expect(viewer.locator("#activityChunkGrid path")).toHaveAttribute(
      "stroke-width",
      "8",
    );
    await expect(viewer.locator("#gridContainer")).toHaveAttribute(
      "fill",
      "none",
    );
  }
  expect(await page.locator("#drawingArea rect").getAttribute("id")).not.toBe(
    "r1",
  );
  await boardPage.gotoBoard("archive-target", { lang: "en" });
  await expect(page.locator("#drawingArea > *")).toHaveCount(4);
  await expect
    .poll(() => page.evaluate(() => window.WBOApp.chunks.state))
    .toMatchObject(chunks);
  await expect(page.locator("#activityChunkGridContainer")).toBeVisible();
  await expect(peer.locator("#drawingArea rect")).toHaveAttribute(
    "opacity",
    "0.4",
  );
  // The imported rectangle goes through the ordinary Eraser interaction.
  await boardPage.selectTool("eraser");
  const rectangle = await page.locator("#drawingArea rect").boundingBox();
  if (!rectangle) throw new Error("Imported rectangle is missing");
  await page.mouse.click(rectangle.x + rectangle.width / 2, rectangle.y);
  await expect(peer.locator("#drawingArea rect")).toHaveCount(0);
  await peer.close();
});

test("invalid backups leave the board untouched and SVG downloads remain available", async ({
  boardPage,
  page,
}) => {
  await boardPage.gotoBoard("archive-invalid", { lang: "en" });
  await boardPage.tool("download").click();
  const choosing = page.waitForEvent("filechooser");
  await page
    .getByRole("button", { name: "Import WBO backup", exact: true })
    .click();
  await (await choosing).setFiles({
    name: "invalid.wbo",
    mimeType: "application/gzip",
    buffer: Buffer.from("not an archive"),
  });
  await expect(page.getByText(/Import failed\. Check the file/)).toBeVisible();
  await page.getByRole("button", { name: "I understand", exact: true }).click();
  await expect(page.locator("#drawingArea > *")).toHaveCount(0);
  await boardPage.tool("download").click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export SVG", exact: true }).click();
  expect((await downloading).suggestedFilename()).toBe("archive-invalid.svg");
});

test("ordinary editors can download backups but cannot upload them", async ({
  boardPage,
  page,
}) => {
  await boardPage.gotoBoard("archive-editor", { lang: "en" });
  expect(await page.evaluate(() => window.WBOApp.access.canEdit)).toBe(true);
  expect(await page.evaluate(() => window.WBOApp.access.canBan)).toBe(false);
  await boardPage.tool("download").click();
  await expect(
    page.getByRole("button", { name: "Export SVG", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Import WBO backup", exact: true }),
  ).toHaveCount(0);
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export WBO backup", exact: true })
    .click();
  const file = await (await downloading).path();
  if (!file) throw new Error("Missing downloaded archive");
  const response = await page.request.post(
    new URL("../archive/archive-editor", page.url()).href,
    {
      headers: { "Content-Type": "application/gzip", "X-WBO-Archive": "1" },
      data: await readFile(file),
    },
  );
  expect(response.status()).toBe(403);
  await expect(page.locator("#drawingArea > *")).toHaveCount(0);
});

test.describe("temporary board moderators", () => {
  test("the existing Download button follows moderator grants and revocations", async ({
    boardPage,
    page,
    browser,
    server,
  }) => {
    const targetContext = await browser.newContext();
    try {
      const targetPage = await targetContext.newPage();
      const targetBoard = createBoardPage(targetPage, server);
      await boardPage.gotoBoard("archive-temporary", {
        lang: "en",
      });
      await targetBoard.gotoBoard("archive-temporary", {
        lang: "en",
      });
      await boardPage.waitForSocketConnected();
      await targetBoard.waitForSocketConnected();
      const targetId = await targetPage.evaluate(
        () => window.WBOApp.connection.socket?.id,
      );
      if (!targetId) throw new Error("Target socket is missing");
      const importButton = targetPage.getByRole("button", {
        name: "Import WBO backup",
        exact: true,
      });
      await targetBoard.tool("download").click();
      await expect(importButton).toHaveCount(0);
      await targetPage
        .getByRole("button", { name: "Cancel", exact: true })
        .click();

      await page.evaluate(
        (socketId) =>
          window.WBOApp.connection.socket?.emit("set_temporary_moderator", {
            socketId,
            durationMs: 900000,
          }),
        targetId,
      );
      await expect
        .poll(() => targetPage.evaluate(() => window.WBOApp.access.canBan))
        .toBe(true);
      await targetBoard.tool("download").click();
      await expect(importButton).toBeVisible();
      await targetPage
        .getByRole("button", { name: "Cancel", exact: true })
        .click();

      await page.evaluate(
        (socketId) =>
          window.WBOApp.connection.socket?.emit("set_temporary_moderator", {
            socketId,
            durationMs: 0,
          }),
        targetId,
      );
      await expect
        .poll(() => targetPage.evaluate(() => window.WBOApp.access.canBan))
        .toBe(false);
      await targetBoard.tool("download").click();
      await expect(importButton).toHaveCount(0);
      await expect(
        targetPage.getByRole("button", {
          name: "Export WBO backup",
          exact: true,
        }),
      ).toBeVisible();
    } finally {
      await targetContext.close();
    }
  });
});
