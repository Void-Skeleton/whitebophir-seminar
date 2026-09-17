import { createBoardPage, expect, test } from "../fixtures/test";

for (const theme of ["light", "dark"] as const) {
  test(`pen strokes paint locally before release after canvas growth in ${theme} mode`, async ({
    page,
    context,
    boardPage,
    server,
  }) => {
    await boardPage.gotoBoard(`pen-preview-${theme}`);
    await boardPage.selectTool("pencil");
    const peer = await context.newPage();
    await createBoardPage(peer, server).gotoBoard(`pen-preview-${theme}`);
    await page.evaluate((theme) => {
      const app = window.WBOApp;
      app.theme.receive({ theme });
      app.preferences.setColor("#000000");
      app.preferences.setSize(100);
      // Keep Pencil selected while navigation grows the board beyond the
      // dimensions it had when the local preview was first installed.
      app.viewportState.controller.ensureBoardExtentForPoint(100000, 100000);
      app.viewportState.controller.setScale(0.1);
      app.viewportState.controller.panTo(9000, 9000);
    }, theme);
    const pen = await context.newCDPSession(page);
    await pen.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 220,
      y: 220,
      button: "left",
      buttons: 1,
      clickCount: 1,
      pointerType: "pen",
      force: 0.7,
    });
    for (const coordinate of [240, 260, 280, 300]) {
      await pen.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: coordinate,
        y: coordinate,
        button: "left",
        buttons: 1,
        pointerType: "pen",
        force: 0.7,
      });
      await page.evaluate(() => new Promise(requestAnimationFrame));
    }
    await expect(peer.locator("#drawingArea path[d]:not([d=''])")).toHaveCount(
      1,
    );
    await expect(page.locator("#drawingArea path")).toHaveCount(0);
    await expect(page.locator(".wbo-pencil-live-path")).toHaveAttribute(
      "d",
      /C/,
    );
    const screenshot = await page.screenshot({
      clip: { x: 250, y: 250, width: 20, height: 20 },
    });
    const pixel = await page.evaluate(async (png) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 20;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Missing 2D context");
      ctx.drawImage(image, 0, 0);
      return Array.from(ctx.getImageData(10, 10, 1, 1).data);
    }, screenshot.toString("base64"));
    expect(pixel).toEqual(
      theme === "dark" ? [255, 255, 255, 255] : [0, 0, 0, 255],
    );
    await pen.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: 300,
      y: 300,
      button: "left",
      buttons: 0,
      clickCount: 1,
      pointerType: "pen",
    });
    await expect(page.locator("#drawingArea path")).toHaveCount(1);
    await peer.close();
  });
}
