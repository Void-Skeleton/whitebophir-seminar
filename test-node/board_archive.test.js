// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-14: archive round trips and hostile input.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const { gzipSync } = require("node:zlib");
const jsonwebtoken = require("jsonwebtoken");
const { banBoardUser } = require("../server/socket/bans.mjs");
const {
  setTemporaryModerator,
} = require("../server/socket/temporary_moderators.mjs");
const {
  createConfig,
  getTcpAddress,
  closeServer,
} = require("./test_helpers.js");
const {
  applyArchiveImport,
  encodeArchive,
  decodeArchive,
  itemsFromSvg,
  prepareArchiveImport,
} = require("../server/board/archive.mjs");
const {
  serializeStoredSvgItem,
} = require("../server/persistence/stored_svg_item_codec.mjs");
const { BoardData } = require("../server/board/data.mjs");
const { createServerApp } = require("../server/server.mjs");
const { getBoard } = require("../server/socket/index.mjs");
const runFile = promisify(execFile);
const moderatorSecret = "0123456789abcdef0123456789abcdef";
/** @type {import("../client-data/js/board_chunks.js").ChunkSettings} */
const chunks = { width: 4000, height: 3000, margin: 800, viewMode: "latest" };

/** @type {any[]} */
const items = [
  {
    id: "r1",
    tool: "rectangle",
    color: "#123456",
    size: 10,
    opacity: 0.4,
    x: 100,
    y: 100,
    x2: 200,
    y2: 220,
  },
  {
    id: "e1",
    tool: "ellipse",
    color: "#abcdef",
    size: 12,
    x: 120,
    y: 140,
    x2: 260,
    y2: 270,
  },
  {
    id: "s1",
    tool: "straight-line",
    color: "#000000",
    size: 13,
    x: 10,
    y: 30,
    x2: 100,
    y2: 120,
  },
  {
    id: "l1",
    tool: "pencil",
    color: "#112233",
    size: 15,
    _children: [
      { x: 300, y: 310 },
      { x: 320, y: 330 },
      { x: 310, y: 300 },
    ],
    transform: { a: 1, b: 0.1, c: 0, d: 1, e: 20, f: 30 },
  },
  {
    id: "t1",
    tool: "text",
    color: "#102030",
    size: 24,
    x: 100,
    y: 300,
    txt: "你好 <script>alert(1)</script> & café\nSecond line",
  },
];
/** @param {any[]} value */
function archive(value = items) {
  return { format: "whitebophir-board", version: 1, items: value };
}
/** @param {any[]} value */
function withoutIds(value) {
  return value.map(({ id, ...item }) => {
    void id;
    return item;
  });
}

test("native gzip archives preserve every tool, order, Unicode and transforms", async () => {
  const svg = `<svg id="canvas" width="1000" height="1000"><g id="drawingArea">${items.map(serializeStoredSvgItem).join("")}</g></svg>`;
  const decodedItems = await itemsFromSvg(svg);
  assert.deepEqual(decodedItems, items);
  const compressed = await encodeArchive(decodedItems);
  assert.equal(compressed.readUInt16BE(0), 0x1f8b);
  assert.deepEqual(await decodeArchive(compressed), archive());
  const prepared = prepareArchiveImport(
    await decodeArchive(compressed),
    createConfig(),
  );
  assert.equal(prepared.items.length, items.length);
  for (let i = 0; i < items.length; i++)
    assert.notEqual(prepared.items[i]?.id, items[i]?.id);
  const board = new BoardData("native-round-trip", createConfig());
  applyArchiveImport(board, prepared);
  assert.deepEqual(
    withoutIds(
      await itemsFromSvg(
        `<svg><g id="drawingArea">${prepared.items.map(serializeStoredSvgItem).join("")}</g></svg>`,
      ),
    ),
    withoutIds(items),
  );
  assert.equal(board.authoritativeItemCount(), items.length);
  const replayed = new BoardData("native-replay", createConfig());
  for (const mutation of prepared.mutations) {
    assert.deepEqual(replayed.processMessage(mutation), { ok: true });
  }
  for (const item of prepared.items) {
    assert.equal(
      serializeStoredSvgItem(board.get(item.id)),
      serializeStoredSvgItem(replayed.get(item.id)),
    );
  }
  replayed.dispose();
  board.dispose();
});

test("archive validation rejects malformed containers and oversized decompression", async () => {
  for (const data of [
    Buffer.from("not gzip"),
    gzipSync("{"),
    gzipSync(Buffer.from([0xff])),
  ]) {
    await assert.rejects(decodeArchive(data), { reason: "invalid_archive" });
  }
  await assert.rejects(
    decodeArchive(gzipSync(Buffer.alloc(1025)), {
      MAX_ARCHIVE_BYTES: 1024,
      MAX_ARCHIVE_JSON_BYTES: 1024,
    }),
    { reason: "invalid_archive" },
  );
  for (const value of [
    null,
    [],
    {},
    { ...archive(), version: 2 },
    { ...archive(), items: {} },
  ]) {
    assert.throws(() => prepareArchiveImport(value, createConfig()));
  }
});

test("archives restore chunk settings, omit source activity and preserve settings in older backups", async (t) => {
  const config = createConfig();
  const board = new BoardData("archive-chunks", config);
  t.after(() => board.dispose());
  board.metadata = {
    readonly: true,
    chunks: {
      ...chunks,
      width: 2000,
      revision: "destination",
      point: { x: 0, y: 0 },
    },
  };
  const sourceChunks = {
    ...chunks,
    revision: "source",
    point: { x: 9999, y: 9999 },
  };
  const decoded = await decodeArchive(
    await encodeArchive([], config, sourceChunks),
  );
  assert.deepEqual(decoded, { ...archive([]), chunks });
  applyArchiveImport(board, prepareArchiveImport(decoded, config));
  const restored = board.metadata.chunks;
  assert.ok(restored);
  assert.deepEqual(restored, {
    ...chunks,
    revision: restored.revision,
    point: board.activityPoint,
  });
  assert.ok(restored.revision);
  assert.notEqual(restored.revision, "destination");
  assert.notEqual(restored.revision, "source");
  assert.equal(board.metadata.readonly, true);
  applyArchiveImport(board, prepareArchiveImport(archive(), config));
  assert.deepEqual(board.metadata.chunks, {
    ...restored,
    point: board.activityPoint,
  });
});

test("archive validation rejects invalid chunk settings before importing objects", () => {
  for (const value of [
    null,
    [],
    {},
    { ...chunks, width: 99 },
    { ...chunks, height: 100001 },
    { ...chunks, margin: -1 },
    { ...chunks, margin: 0.5 },
    { ...chunks, width: "4000" },
    { ...chunks, viewMode: "locked" },
    { ...chunks, revision: "spoofed" },
    { ...chunks, readonly: false },
  ]) {
    assert.throws(
      () =>
        prepareArchiveImport({ ...archive(), chunks: value }, createConfig()),
      { reason: "invalid_archive_chunks" },
    );
  }
});

test("archive items cannot inject tools, duplicate IDs, SVG or invalid geometry", () => {
  const rect = items[0];
  const invalid = [
    [null],
    [rect, rect],
    [{ ...rect, id: "" }],
    [{ ...rect, tool: "__proto__" }],
    [{ ...rect, tool: "clear" }],
    [{ ...rect, onclick: "alert(1)" }],
    [{ ...rect, color: "url(https://example.com)" }],
    [{ ...rect, size: -1 }],
    [{ ...rect, x: Infinity }],
    [{ ...rect, txt: "unexpected" }],
    [{ ...items[3], _children: [null] }],
    [{ ...items[3], _children: [] }],
    [{ ...items[4], txt: {} }],
    [{ ...rect, transform: { a: 1 } }],
  ];
  for (const bad of invalid)
    assert.throws(() => prepareArchiveImport(archive(bad), createConfig()));
  assert.throws(() =>
    prepareArchiveImport(
      archive(),
      createConfig({ BLOCKED_TOOLS: ["pencil"] }),
    ),
  );
  assert.throws(() =>
    prepareArchiveImport(archive(), createConfig({ MAX_CHILDREN: 2 })),
  );
});

/** @param {any} t @param {Record<string, any>} [overrides] @param {string[]} [moderatedBoards] */
async function start(t, overrides = {}, moderatedBoards = []) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "wbo-archive-test-"),
  );
  const config = createConfig({
    HOST: "127.0.0.1",
    PORT: 0,
    AUTH_SECRET_KEY: "",
    HISTORY_DIR: directory,
    BOARD_MODERATORS: new Map(
      moderatedBoards.map((board) => [board, new Set([moderatorSecret])]),
    ),
    ...overrides,
  });
  const server = await createServerApp(config, { logStarted: false });
  t.after(async () => {
    await closeServer(server);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${getTcpAddress(server).port}`;
  return { config, directory, url };
}
/** @param {string} url @param {Buffer} body @param {Record<string, string>} [headers] */
function upload(url, body, headers = {}) {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/gzip",
      "X-WBO-Archive": "1",
      Cookie: `wbo-user-secret-v1=${moderatorSecret}`,
      ...headers,
    },
    body: new Uint8Array(body).buffer,
  });
}

test("HTTP imports append atomically, save immediately on export and survive reload", async (t) => {
  const { config, url } = await start(t, {}, ["destination"]);
  const board = await getBoard("destination", config);
  const seed = prepareArchiveImport(archive([items[0]]), config);
  applyArchiveImport(board, seed);
  const response = await upload(
    `${url}/archive/destination`,
    await encodeArchive(items, config, chunks),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).imported, 5);
  const download = await fetch(`${url}/archive/destination`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("cache-control"), "no-store");
  const exported = /** @type {any} */ (
    await decodeArchive(Buffer.from(await download.arrayBuffer()))
  );
  assert.deepEqual(exported.chunks, chunks);
  assert.deepEqual(
    withoutIds(exported.items),
    withoutIds([items[0], ...items]),
  );
  assert.equal(
    new Set(exported.items.map((/** @type {any} */ item) => item.id)).size,
    6,
  );
  const reloaded = await BoardData.load("destination", config);
  assert.equal(reloaded.authoritativeItemCount(), 6);
  assert.equal(reloaded.getSeq(), board.getSeq());
  assert.deepEqual(reloaded.metadata.chunks, board.metadata.chunks);
  reloaded.dispose();
  const repeat = await upload(
    `${url}/archive/destination`,
    await encodeArchive(items),
  );
  assert.equal(repeat.status, 429);
});

test("settings-only archives persist even on empty boards", async (t) => {
  const { config, url } = await start(t, {}, ["empty-chunks"]);
  const response = await upload(
    `${url}/archive/empty-chunks`,
    await encodeArchive([], config, chunks),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { imported: 0, seq: 0 });
  const downloaded = await fetch(`${url}/archive/empty-chunks`);
  assert.equal(downloaded.status, 200);
  assert.deepEqual(
    await decodeArchive(Buffer.from(await downloaded.arrayBuffer())),
    { ...archive([]), chunks },
  );
  const reloaded = await BoardData.load("empty-chunks", config);
  t.after(() => reloaded.dispose());
  assert.equal(reloaded.authoritativeItemCount(), 0);
  assert.deepEqual(
    reloaded.metadata.chunks,
    (await getBoard("empty-chunks", config)).metadata.chunks,
  );
});

test("invalid imported geometry leaves existing content and sequence untouched", async (t) => {
  const { config, url } = await start(t, {}, ["invalid"]);
  const board = await getBoard("invalid", config);
  const data = await encodeArchive(
    [
      items[0],
      {
        ...items[0],
        id: "r2",
        transform: { a: 1, b: 0, c: 0, d: 1, e: 10000000, f: 0 },
      },
    ],
    config,
    chunks,
  );
  const response = await upload(`${url}/archive/invalid`, data);
  assert.equal(response.status, 400);
  assert.equal(board.authoritativeItemCount(), 0);
  assert.equal(board.getSeq(), 0);
  assert.equal(board.metadata.chunks, undefined);
});

test("imports reject read-only boards, cross-origin form bodies and unsupported methods", async (t) => {
  const { config, url } = await start(t, {}, ["readonly-moderated"]);
  const board = await getBoard("readonly", config);
  board.metadata.readonly = true;
  const data = await encodeArchive(items);
  assert.equal((await upload(`${url}/archive/readonly`, data)).status, 403);
  const moderated = await getBoard("readonly-moderated", config);
  moderated.metadata.readonly = true;
  assert.equal(
    (await upload(`${url}/archive/readonly-moderated`, data)).status,
    200,
  );
  assert.equal(
    (
      await upload(`${url}/archive/writable`, data, {
        "Content-Type": "text/plain",
      })
    ).status,
    400,
  );
  assert.equal(
    (await fetch(`${url}/archive/writable`, { method: "OPTIONS" })).status,
    405,
  );
});

test("only board moderators can import, retaining their Turnstile bypass", async (t) => {
  const { config, url } = await start(
    t,
    { TURNSTILE_SECRET_KEY: "test-secret" },
    ["anonymous"],
  );
  const data = await encodeArchive([items[0]]);
  const denied = await upload(`${url}/archive/anonymous`, data, { Cookie: "" });
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: "write_blocked" });
  assert.equal((await getBoard("anonymous", config)).getSeq(), 0);
  assert.equal((await upload(`${url}/archive/other-board`, data)).status, 403);
  assert.equal((await upload(`${url}/archive/anonymous`, data)).status, 200);
});

test("temporary moderators can import until their grant is revoked", async (t) => {
  const { config, url } = await start(t);
  const boardName = "temporary-archive";
  setTemporaryModerator(boardName, moderatorSecret, Date.now() + 60000);
  t.after(() => setTemporaryModerator(boardName, moderatorSecret, null));
  const data = await encodeArchive([items[0]]);
  assert.equal((await upload(`${url}/archive/${boardName}`, data)).status, 200);
  const board = await getBoard(boardName, config);
  const seq = board.getSeq();
  setTemporaryModerator(boardName, moderatorSecret, null);
  assert.equal((await upload(`${url}/archive/${boardName}`, data)).status, 403);
  assert.equal(board.getSeq(), seq);
});

test("archive capacity checks preserve existing objects and chunk settings", async (t) => {
  const { config, url } = await start(t, { MAX_ITEM_COUNT: 1 }, ["full"]);
  const board = await getBoard("full", config);
  const seed = prepareArchiveImport({ ...archive([items[0]]), chunks }, config);
  applyArchiveImport(board, seed);
  const originalChunks = board.metadata.chunks;
  const response = await upload(
    `${url}/archive/full`,
    await encodeArchive([items[1]], config, { ...chunks, width: 2000 }),
  );
  assert.equal(response.status, 409);
  assert.equal(board.authoritativeItemCount(), 1);
  assert.ok(board.itemsById.has(seed.items[0]?.id || ""));
  assert.equal(board.metadata.chunks, originalChunks);
});

test("archive routes enforce board JWT scope and deny editor imports", async (t) => {
  const { config, url } = await start(t, { AUTH_SECRET_KEY: "archive-auth" });
  const token = jsonwebtoken.sign(
    { roles: ["editor:allowed"] },
    "archive-auth",
  );
  const data = await encodeArchive([items[0]]);
  assert.equal((await fetch(`${url}/archive/allowed`)).status, 403);
  assert.equal(
    (await upload(`${url}/archive/other?token=${token}`, data)).status,
    403,
  );
  assert.equal(
    (await fetch(`${url}/archive/allowed?token=${token}`)).status,
    200,
  );
  assert.equal(
    (await upload(`${url}/archive/allowed?token=${token}`, data)).status,
    403,
  );
  banBoardUser(
    "allowed",
    "0123456789abcdef0123456789abcdef",
    "127.0.0.1",
    Date.now(),
  );
  assert.equal(
    (await upload(`${url}/archive/allowed?token=${token}`, data)).status,
    403,
  );
  assert.equal((await getBoard("allowed", config)).getSeq(), 0);
  const moderatorToken = jsonwebtoken.sign(
    { roles: ["moderator:allowed"] },
    "archive-auth",
  );
  assert.equal(
    (await upload(`${url}/archive/other?token=${moderatorToken}`, data)).status,
    403,
  );
  assert.equal(
    (await upload(`${url}/archive/allowed?token=${moderatorToken}`, data))
      .status,
    200,
  );
});

test("configured compressed limits reject uploads without modifying the board", async (t) => {
  const { config, url } = await start(t, { MAX_ARCHIVE_BYTES: 16 }, [
    "size-limit",
  ]);
  const response = await upload(
    `${url}/archive/size-limit`,
    await encodeArchive(items),
  );
  assert.equal(response.status, 413);
  assert.equal((await getBoard("size-limit", config)).getSeq(), 0);
});

test("archive configuration and modified-source links reach the browser", async (t) => {
  const { url } = await start(t, {
    MAX_ARCHIVE_BYTES: 128 * 1024 * 1024,
    SOURCE_URL: "https://example.org/modified-wbo-source",
  });
  const home = await (await fetch(`${url}/`)).text();
  assert.match(home, /href="https:\/\/example\.org\/modified-wbo-source"/);
  const page = await (await fetch(`${url}/boards/settings`)).text();
  const configText = page.match(/id="configuration">([^<]*)<\/script>/)?.[1];
  assert.ok(configText);
  const config = JSON.parse(configText);
  assert.equal(config.MAX_ARCHIVE_BYTES, 128 * 1024 * 1024);
  assert.equal(config.SOURCE_URL, "https://example.org/modified-wbo-source");
});

test("Python helper exports and imports the same native archive", async (t) => {
  const { config, directory, url } = await start(t, {}, ["cli-target"]);
  const board = await getBoard("cli-source", config);
  const seed = prepareArchiveImport({ ...archive(), chunks }, config);
  applyArchiveImport(board, seed);
  const file = path.join(directory, "backup.wbo");
  const helper = path.resolve(__dirname, "../scripts/seminar_helper.py");
  await runFile("python3", [
    helper,
    "export",
    file,
    "--server",
    url,
    "--board",
    "cli-source",
  ]);
  await runFile("python3", [
    helper,
    "import",
    file,
    "--server",
    url,
    "--board",
    "cli-target",
    "--user-secret",
    moderatorSecret,
  ]);
  assert.equal(
    (await getBoard("cli-target", config)).authoritativeItemCount(),
    5,
  );
  const targetChunks = (await getBoard("cli-target", config)).metadata.chunks;
  assert.ok(targetChunks);
  assert.deepEqual(targetChunks, {
    ...chunks,
    revision: targetChunks.revision,
    point: board.activityPoint,
  });
  await assert.rejects(
    runFile("python3", [
      helper,
      "export",
      file,
      "--server",
      url,
      "--board",
      "cli-source",
    ]),
  );
});
