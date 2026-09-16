// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-16: moderator history downloads and stroke timing.
import { gunzipSync } from "node:zlib";
import fs from "node:fs/promises";
import { createBoardPage, expect, test } from "../fixtures/test";

const secret = "12".repeat(16);
test.use({
  serverOptions: { env: { WBO_BOARD_MODERATORS: `history:${secret}` } },
});

test("moderators download timestamped strokes and historical WBO snapshots from the existing Download dialog", async ({
  page,
  context,
  server,
  boardPage,
  browser,
}) => {
  await context.addCookies([
    { name: "wbo-user-secret-v1", value: secret, url: server.serverUrl },
  ]);
  await boardPage.gotoBoard("history", { lang: "zh-CN" });
  await boardPage.selectTool("pencil");
  await page.mouse.move(350, 300);
  await page.mouse.down();
  await page.mouse.move(430, 350, { steps: 5 });
  await page.mouse.up();
  const endpoint = `${server.serverUrl}/history/history`;
  let rows: any[] = [];
  await expect
    .poll(async () => {
      const info = await (await page.request.get(endpoint)).json();
      const result = await page.request.get(
        `${endpoint}?from=${info.availableFrom}&to=${info.now}`,
      );
      rows = gunzipSync(await result.body())
        .toString()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      return rows.filter((row) => row.kind === "stroke").length;
    })
    .toBe(1);
  const stroke = rows.find((row) => row.kind === "stroke");
  expect(stroke.reason).toBe("release");
  expect(stroke.endAtMs).toBeGreaterThanOrEqual(stroke.startAtMs);
  const info = await (await page.request.get(endpoint)).json();
  // A peer cannot close this user's stroke or create arbitrary log entries.
  await page.evaluate(() =>
    window.WBOApp.connection.socket?.emit("stroke_end", { id: "not-owned" }),
  );
  await boardPage.waitForToolBooted("download");
  await boardPage.tool("download").click();
  await page.getByRole("button", { name: "下载历史白板", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "下载历史白板" }),
  ).toBeVisible();
  await page.locator('input[name="at"]').fill(
    await page.evaluate((time) => {
      const date = new Date(time);
      return new Date(time - date.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, -1);
    }, info.now),
  );
  const downloadingSnapshot = page.waitForEvent("download");
  await page.locator("dialog button[type=submit]").click();
  const snapshotDownload = await downloadingSnapshot;
  expect(snapshotDownload.suggestedFilename()).toMatch(/\.wbo$/);
  const snapshotPath = await snapshotDownload.path();
  if (!snapshotPath) throw new Error("No downloaded snapshot");
  const snapshot = JSON.parse(
    gunzipSync(await fs.readFile(snapshotPath)).toString(),
  );
  expect(snapshot.format).toBe("whitebophir-board");
  expect(snapshot.items).toHaveLength(1);
  expect(snapshot.items[0]._children.length).toBeGreaterThan(1);
  await boardPage.tool("download").click();
  await page.getByRole("button", { name: "下载修改日志", exact: true }).click();
  const downloadingLog = page.waitForEvent("download");
  await page.locator("dialog button[type=submit]").click();
  const logDownload = await downloadingLog;
  expect(logDownload.suggestedFilename()).toMatch(/\.jsonl\.gz$/);
  const logPath = await logDownload.path();
  if (!logPath) throw new Error("No downloaded log");
  expect(gunzipSync(await fs.readFile(logPath)).toString()).toContain(
    '"reason":"release"',
  );
  const otherContext = await browser.newContext();
  try {
    const otherPage = await otherContext.newPage();
    const other = createBoardPage(otherPage, server);
    await other.gotoBoard("history", { lang: "zh-TW" });
    await other.waitForToolBooted("download");
    await other.tool("download").click();
    await expect(
      otherPage.getByRole("button", { name: "下載歷史白板" }),
    ).toHaveCount(0);
    await expect(
      otherPage.getByRole("button", { name: "下載修改紀錄" }),
    ).toHaveCount(0);
    expect((await otherPage.request.get(endpoint)).status()).toBe(403);
  } finally {
    await otherContext.close();
  }
});
