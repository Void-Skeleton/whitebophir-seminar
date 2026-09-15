// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-16: themes, permissions and persistence.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const {
  themeColor,
  isBoardTheme,
} = require("../client-data/js/board_theme.js");
const { BoardData } = require("../server/board/data.mjs");
const { getBoard } = require("../server/socket/index.mjs");
const { createServerApp } = require("../server/server.mjs");
const {
  prepareArchiveImport,
  applyArchiveImport,
  decodeArchive,
} = require("../server/board/archive.mjs");
const {
  setTemporaryModerator,
} = require("../server/socket/temporary_moderators.mjs");
const {
  createConfig,
  closeServer,
  getTcpAddress,
} = require("./test_helpers.js");
const run = promisify(execFile);
const secret = "12".repeat(16);

test("dark colors swap brightness while preserving hues and color separation", () => {
  assert.equal(themeColor("#000000", "dark"), "#ffffff");
  assert.equal(themeColor("#ffffff", "dark"), "#202020");
  assert.equal(themeColor("#ffcccc", "dark"), "#4d2020");
  assert.equal(themeColor("#ccffcc", "dark"), "#204d20");
  assert.equal(themeColor("#ccccff", "dark"), "#20204d");
  assert.equal(themeColor("#ff0000", "dark"), "#ff2020");
  assert.equal(themeColor("#123456", "light"), "#123456");
  assert.equal(themeColor("#ffffff", "dark", true), "#000000");
  assert.equal(themeColor("#202020", "dark", true), "#ffffff");
  for (const value of [null, true, "auto", {}, []])
    assert.equal(isBoardTheme(value), false);
});

test("theme API validates, authorizes, persists empty boards and supports the helper and backups", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wbo-theme-"));
  const config = createConfig({
    HOST: "127.0.0.1",
    PORT: 0,
    HISTORY_DIR: directory,
    AUTH_SECRET_KEY: "",
    BOARD_MODERATORS: new Map([["theme", new Set([secret])]]),
  });
  const server = await createServerApp(config, { logStarted: false });
  t.after(async () => {
    await closeServer(server);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${getTcpAddress(server).port}`;
  const headers = {
    "Content-Type": "application/json",
    "X-WBO-Theme": "1",
    Cookie: `wbo-user-secret-v1=${secret}`,
  };
  /** @param {unknown} body @param {Record<string,string>} [requestHeaders] @param {string} [name] */
  const post = (body, requestHeaders = headers, name = "theme") =>
    fetch(`${url}/theme/${name}`, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(body),
    });
  assert.deepEqual(await (await fetch(`${url}/theme/theme`)).json(), {
    theme: "light",
  });
  assert.equal(
    (await post({ theme: "dark" }, { ...headers, Cookie: "" })).status,
    403,
  );
  assert.equal((await post({ theme: "dark" }, headers, "other")).status, 403);
  for (const input of [
    null,
    [],
    true,
    "dark",
    {},
    { theme: true },
    { theme: "auto" },
    { theme: "dark", readonly: false },
  ])
    assert.equal((await post(input)).status, 400);
  assert.equal(
    (await post({ theme: "dark" }, { ...headers, "X-WBO-Theme": "" })).status,
    400,
  );
  assert.equal(
    (await fetch(`${url}/theme/theme`, { method: "POST", headers, body: "{" }))
      .status,
    400,
  );
  assert.equal(
    (
      await fetch(`${url}/theme/theme`, {
        method: "POST",
        headers,
        body: "x".repeat(2049),
      })
    ).status,
    413,
  );
  assert.equal(
    (await fetch(`${url}/theme/theme`, { method: "DELETE" })).status,
    405,
  );
  const response = await post({ theme: "dark" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const loaded = await BoardData.load("theme", config);
  assert.equal(loaded.metadata.theme, "dark");
  assert.equal(loaded.authoritativeItemCount(), 0);
  loaded.dispose();
  const svg = await (await fetch(`${url}/preview/theme`)).text();
  assert.match(svg, /data-wbo-theme="dark"/);
  assert.match(svg, /id="wbo-dark-colors"/);
  const darkPage = await fetch(`${url}/boards/theme`);
  const html = await darkPage.text();
  assert.match(html, /<html[^>]*data-board-theme="dark"/);
  const darkSvg = await fetch(`${url}/boards/theme.svg`);
  const svgEtag = darkSvg.headers.get("etag");
  const pageEtag = darkPage.headers.get("etag");
  assert.ok(svgEtag);
  assert.ok(pageEtag);
  await darkSvg.text();
  assert.equal(
    (
      await fetch(`${url}/boards/theme`, {
        headers: { "If-None-Match": pageEtag },
      })
    ).status,
    304,
  );
  const archive = /** @type {any} */ (
    await decodeArchive(
      Buffer.from(await (await fetch(`${url}/archive/theme`)).arrayBuffer()),
    )
  );
  assert.equal(archive.theme, "dark");
  const destination = await getBoard("destination", config);
  applyArchiveImport(destination, prepareArchiveImport(archive, config));
  assert.equal(destination.metadata.theme, "dark");
  await destination.save();
  const restored = await BoardData.load("destination", config);
  assert.equal(restored.metadata.theme, "dark");
  restored.dispose();
  delete archive.theme;
  applyArchiveImport(destination, prepareArchiveImport(archive, config));
  assert.equal(destination.metadata.theme, "dark");
  for (const value of [null, 1, {}, "invalid"])
    assert.throws(
      () => prepareArchiveImport({ ...archive, theme: value }, config),
      { reason: "invalid_archive_theme" },
    );
  const result = await run("python3", [
    path.resolve(__dirname, "../scripts/seminar_helper.py"),
    "theme",
    "--server",
    url,
    "--board",
    "theme",
    "--user-secret",
    secret,
    "--mode",
    "light",
  ]);
  assert.deepEqual(JSON.parse(result.stdout), { theme: "light" });
  const refreshedPage = await fetch(`${url}/boards/theme`, {
    headers: { "If-None-Match": pageEtag },
  });
  assert.equal(refreshedPage.status, 200);
  assert.match(
    await refreshedPage.text(),
    /<html[^>]*data-board-theme="light"/,
  );
  const refreshedSvg = await fetch(`${url}/boards/theme.svg`, {
    headers: { "If-None-Match": svgEtag },
  });
  assert.equal(refreshedSvg.status, 200);
  assert.match(await refreshedSvg.text(), /data-wbo-theme="light"/);
  const light = await BoardData.load("theme", config);
  assert.equal(light.metadata.theme, "light");
  light.dispose();
  const lightSvg = await (await fetch(`${url}/preview/theme`)).text();
  assert.equal((lightSvg.match(/id="wbo-dark-colors"/g) || []).length, 1);
  for (let i = 0; i < 8; i++)
    assert.equal((await post({ theme: "dark" })).status, 200);
  assert.equal((await post({ theme: "light" })).status, 429);
  setTemporaryModerator("temporary", secret, Date.now() + 60000);
  assert.equal(
    (await post({ theme: "dark" }, headers, "temporary")).status,
    200,
  );
  setTemporaryModerator("temporary", secret, null);
  assert.equal(
    (await post({ theme: "light" }, headers, "temporary")).status,
    403,
  );
});
