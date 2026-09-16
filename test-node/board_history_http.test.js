// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-16: moderator history API and helper integration.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { gunzipSync } = require("node:zlib");
const { generateKeyPairSync } = require("node:crypto");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const {
  createConfig,
  closeServer,
  getTcpAddress,
} = require("./test_helpers.js");
const { createServerApp } = require("../server/server.mjs");
const { getBoard } = require("../server/socket/index.mjs");
const { getBoardSession } = require("../server/board/session.mjs");
const { prepareArchiveImport } = require("../server/board/archive.mjs");
const {
  setTemporaryModerator,
} = require("../server/socket/temporary_moderators.mjs");
const run = promisify(execFile);
const secret = "12".repeat(16);
const headers = { Cookie: `wbo-user-secret-v1=${secret}` };

/** @param {import("node:test").TestContext} t */
async function start(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "wbo-history-http-"),
  );
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey
    .export({ type: "spki", format: "der" })
    .subarray(-32)
    .toString("hex");
  const privateKey = pair.privateKey
    .export({ type: "pkcs8", format: "der" })
    .subarray(-32)
    .toString("hex");
  const config = createConfig({
    HOST: "127.0.0.1",
    PORT: 0,
    AUTH_SECRET_KEY: "",
    HISTORY_DIR: directory,
    BOARD_MODERATORS: new Map([["recording", new Set([secret, publicKey])]]),
  });
  const server = await createServerApp(config, { logStarted: false });
  t.after(async () => {
    await closeServer(server);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${getTcpAddress(server).port}`;
  const keyfile = path.join(directory, "key.json");
  await fs.writeFile(
    keyfile,
    JSON.stringify({
      format: "whitebophir-ed25519",
      version: 1,
      publicKey,
      privateKey,
    }),
    { mode: 0o600 },
  );
  return { url, directory, config, keyfile };
}

test("history endpoints reject unauthorized and malformed requests and restore settings and imports at their timestamps", async (t) => {
  const { url, config } = await start(t);
  const endpoint = `${url}/history/recording`;
  assert.equal((await fetch(endpoint)).status, 403);
  assert.equal(
    (await fetch(endpoint, { method: "POST", headers })).status,
    405,
  );
  const info = await (await fetch(endpoint, { headers })).json();
  const board = await getBoard("recording", config);
  for (const query of [
    "?at=-1",
    "?at=NaN",
    "?at=1.5",
    "?at=9999999999999999999",
    "?at=0&at=1",
    "?from=0",
    "?from=2&to=1",
    "?at=0&from=0&to=0",
    "?unknown=1",
    `?at=${Date.now() + 100000}`,
  ]) {
    assert.equal(
      (await fetch(endpoint + query, { headers })).status,
      400,
      query,
    );
  }
  assert.equal(
    (await fetch(`${endpoint}?at=${info.availableFrom - 1}`, { headers }))
      .status,
    416,
  );
  const edit = await getBoardSession(board).acceptPersistentMutation({
    tool: 3,
    type: 1,
    id: "r1",
    x: 100,
    y: 100,
    x2: 200,
    y2: 200,
    color: "#123456",
    size: 10,
  });
  assert.equal(edit.ok, true);
  const changed = await fetch(`${url}/theme/recording`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      "X-WBO-Theme": "1",
    },
    body: JSON.stringify({ theme: "dark" }),
  });
  assert.equal(changed.status, 200);
  const through = await (await fetch(endpoint, { headers })).json();
  const downloaded = await fetch(`${endpoint}?at=${through.now}`, { headers });
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get("cache-control"), "no-store");
  const archive = JSON.parse(
    gunzipSync(Buffer.from(await downloaded.arrayBuffer())).toString(),
  );
  assert.equal(archive.theme, "dark");
  assert.equal(archive.items.length, 1);
  assert.equal(prepareArchiveImport(archive, config).items.length, 1);
  const uploaded = await fetch(`${url}/archive/recording`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/gzip",
      "X-WBO-Archive": "1",
    },
    body: await (
      await fetch(`${endpoint}?at=${through.now}`, { headers })
    ).arrayBuffer(),
  });
  assert.equal(uploaded.status, 200);
  const latest = await (await fetch(endpoint, { headers })).json();
  const log = await fetch(
    `${endpoint}?from=${info.availableFrom}&to=${latest.now}`,
    { headers },
  );
  const records = gunzipSync(Buffer.from(await log.arrayBuffer()))
    .toString()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(records[0].format, "whitebophir-history");
  assert.equal(records.filter((row) => row.kind === "mutation").length, 2);
  assert.equal(records.filter((row) => row.kind === "settings").length, 2);
  assert.ok(!JSON.stringify(records).includes(secret));
  const temporary = "34".repeat(16);
  setTemporaryModerator("recording", temporary, Date.now() + 10000);
  const temporaryHeaders = { Cookie: `wbo-user-secret-v1=${temporary}` };
  assert.equal(
    (await fetch(endpoint, { headers: temporaryHeaders })).status,
    200,
  );
  setTemporaryModerator("recording", temporary, null);
  assert.equal(
    (await fetch(endpoint, { headers: temporaryHeaders })).status,
    403,
  );
});

test("Python helper downloads gzip logs and importable historical snapshots with v2 over HTTP", async (t) => {
  const { url, directory, config, keyfile } = await start(t);
  const board = await getBoard("recording", config);
  await getBoardSession(board).acceptPersistentMutation({
    tool: 3,
    type: 1,
    id: "rect",
    x: 10,
    y: 20,
    x2: 30,
    y2: 40,
    color: "#000000",
    size: 10,
  });
  const base = ["scripts/seminar_helper.py"];
  const args = [
    "--server",
    url,
    "--board",
    "recording",
    "--private-key-file",
    keyfile,
  ];
  const info = JSON.parse(
    (await run("python3", [...base, "history-info", ...args])).stdout,
  );
  const output = path.join(directory, "historical.wbo");
  await run("python3", [
    ...base,
    "export",
    output,
    "--at",
    new Date(info.now).toISOString(),
    ...args,
  ]);
  const snapshot = JSON.parse(gunzipSync(await fs.readFile(output)).toString());
  assert.equal(snapshot.items[0].id, "rect");
  const log = path.join(directory, "history.jsonl.gz");
  await run("python3", [
    ...base,
    "history",
    log,
    "--from",
    String(info.availableFrom),
    "--to",
    String(info.now),
    ...args,
  ]);
  assert.match(
    gunzipSync(await fs.readFile(log)).toString(),
    /"kind":"mutation"/,
  );
  await assert.rejects(
    run("python3", [
      ...base,
      "export",
      output,
      "--at",
      String(info.now),
      ...args,
    ]),
    /already exists/,
  );
  await assert.rejects(
    run("python3", [
      ...base,
      "export",
      path.join(directory, "invalid.wbo"),
      "--at",
      "2026-09-16T10:00:00",
      ...args,
    ]),
    /timezone/,
  );
});
