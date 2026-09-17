import { createBoardPage, expect, test } from "../fixtures/test";
import type { Page } from "@playwright/test";

async function drained(page: Page) {
  await expect
    .poll(() => page.evaluate(() => window.WBOApp.writes.bufferedWrites.length))
    .toBe(0);
}
async function settled(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.WBOApp.viewportState.controller.isFollowCameraMoving(),
      ),
    )
    .toBe(false);
  return page.evaluate(() => ({ x: scrollX, y: scrollY }));
}

test("middle-button dragging pans with Pencil selected and Shift arrows move five times farther", async ({
  boardPage,
  page,
}) => {
  await boardPage.gotoBoard("navigation-shortcuts");
  await boardPage.selectTool("pencil");
  await page.evaluate(() =>
    window.WBOApp.viewportState.controller.panTo(800, 800),
  );
  const initial = await settled(page);
  await page.mouse.move(450, 350);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(300, 250, { steps: 5 });
  await page.mouse.up({ button: "middle" });
  expect(await settled(page)).toEqual({
    x: initial.x + 150,
    y: initial.y + 100,
  });
  await expect(page.locator("#drawingArea > *")).toHaveCount(0);
  await boardPage.expectCurrentTool("pencil");
  const start = await settled(page);
  await page.keyboard.press("ArrowRight");
  expect((await settled(page)).x).toBe(start.x + 64);
  await page.keyboard.press("Shift+ArrowRight");
  expect((await settled(page)).x).toBe(start.x + 384);
  await page.keyboard.press("Shift+ArrowLeft");
  expect((await settled(page)).x).toBe(start.x + 64);
});

test("focused views require a second middle press and Shift arrows move five chunks", async ({
  boardPage,
  page,
}) => {
  await boardPage.gotoBoard("focused-shortcuts");
  await page.evaluate(() => {
    const chunks = window.WBOApp.chunks;
    chunks.receive({
      ...chunks.state,
      width: 4000,
      height: 3000,
      margin: 800,
      revision: "test",
      viewMode: "chunk",
    });
    chunks.setMode("chunk");
  });
  await settled(page);
  await page.keyboard.press("Shift+ArrowRight");
  await settled(page);
  expect(await page.evaluate(() => window.WBOApp.chunks.focusedPoint.x)).toBe(
    20000,
  );
  for (const mode of ["chunk", "latest"] as const) {
    await page.evaluate((mode) => window.WBOApp.chunks.setMode(mode), mode);
    const before = await settled(page);
    await page.mouse.move(450, 350);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(400, 300);
    await page.mouse.up({ button: "middle" });
    expect(await settled(page)).toEqual(before);
    expect(await page.evaluate(() => window.WBOApp.chunks.mode)).toBe(mode);
    await expect(page.locator("#boardStatusIndicator")).toContainText("middle");
    await page.mouse.down({ button: "middle" });
    expect(await page.evaluate(() => window.WBOApp.chunks.mode)).toBe("free");
    const freeStart = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
    await page.mouse.move(300, 200);
    await page.mouse.up({ button: "middle" });
    expect(await settled(page)).toEqual({
      x: freeStart.x + 100,
      y: freeStart.y + 100,
    });
  }
  await expect(page.locator("#drawingArea > *")).toHaveCount(0);
});

test("Ctrl+Z/Y undo and redo whole personal gestures for every participant", async ({
  boardPage,
  page,
  browser,
  server,
}) => {
  await boardPage.gotoBoard("undo-shortcuts");
  const peer = await browser.newPage();
  try {
    await createBoardPage(peer, server).gotoBoard("undo-shortcuts");
    await boardPage.selectTool("pencil");
    await page.mouse.move(250, 250);
    await page.mouse.down();
    await page.mouse.move(400, 350, { steps: 12 });
    await page.mouse.up();
    await drained(page);
    await expect(peer.locator("#drawingArea path")).toHaveCount(1);
    const pencilId = await page.locator("#drawingArea path").getAttribute("id");
    const original = await page.locator(`#${pencilId}`).getAttribute("d");
    await peer.evaluate(() =>
      window.WBOApp.writes.drawAndSend({
        tool: 3,
        type: 1,
        id: "peer-rect",
        x: 100,
        y: 100,
        x2: 300,
        y2: 300,
        color: "#123456",
        size: 10,
      }),
    );
    await drained(peer);
    await page.keyboard.press("Control+z");
    await expect(page.locator(`#${pencilId}`)).toHaveCount(0);
    await expect(peer.locator(`#${pencilId}`)).toHaveCount(0);
    await expect(peer.locator("#peer-rect")).toHaveCount(1);
    await page.keyboard.press("Control+y");
    await expect(page.locator(`#${pencilId}`)).toHaveAttribute(
      "d",
      original || "",
    );
    await expect(peer.locator(`#${pencilId}`)).toHaveAttribute(
      "d",
      original || "",
    );
    await boardPage.selectTool("rectangle");
    await page.mouse.move(250, 250);
    await page.mouse.down();
    await page.mouse.move(350, 330, { steps: 8 });
    await page.mouse.up();
    await drained(page);
    await expect(peer.locator("#drawingArea rect")).toHaveCount(2);
    await page.keyboard.press("Control+z");
    await expect(peer.locator("#drawingArea rect")).toHaveCount(1);
    await page.keyboard.press("Control+y");
    await expect(peer.locator("#drawingArea rect")).toHaveCount(2);
    await peer.reload();
    await expect
      .poll(() => peer.evaluate(() => window.WBOApp?.replay?.awaitingSnapshot))
      .toBe(false);
    await expect(peer.locator(`#${pencilId}`)).toHaveCount(1);
  } finally {
    await peer.close();
  }
});

test("undo closes a held pencil stroke, rapid shortcuts stay ordered, and input fields keep native undo", async ({
  boardPage,
  page,
}) => {
  await boardPage.gotoBoard("undo-active");
  await boardPage.selectTool("pencil");
  await page.mouse.move(300, 250);
  await page.mouse.down();
  await page.mouse.move(400, 300, { steps: 8 });
  await page.keyboard.press("Control+z");
  await page.mouse.move(450, 350);
  await page.mouse.up();
  await expect(page.locator("#drawingArea path")).toHaveCount(0);
  await page.keyboard.press("Control+y");
  await expect(page.locator("#drawingArea path")).toHaveCount(1);
  await boardPage.expectCurrentTool("pencil");
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+y");
  await page.keyboard.press("Control+z");
  await expect
    .poll(() => page.evaluate(() => window.WBOApp.writes.pendingUndo))
    .toBe(null);
  await expect(page.locator("#drawingArea path")).toHaveCount(0);
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.id = "test-native-undo";
    document.body.append(input);
    input.focus();
  });
  await page.keyboard.type("hello");
  await page.keyboard.press("Control+z");
  await expect(page.locator("#test-native-undo")).toHaveValue("");
  await page.keyboard.press("Control+y");
  await expect(page.locator("#test-native-undo")).toHaveValue("hello");
  await expect(page.locator("#drawingArea path")).toHaveCount(0);
});
