// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-15: presentation geometry, permissions and storage.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const jwt = require("jsonwebtoken");
const {
  setTemporaryModerator,
} = require("../server/socket/temporary_moderators.mjs");
const {
  DEFAULT_CHUNKS,
  validateChunkSettings,
  chunkRect,
} = require("../client-data/js/board_chunks.js");
const { BoardData } = require("../server/board/data.mjs");
const { getBoardSession } = require("../server/board/session.mjs");
const { chunkState, parseStoredChunks } = require("../server/board/chunks.mjs");
const { createServerApp } = require("../server/server.mjs");
const { getBoard } = require("../server/socket/index.mjs");
const {
  parseBoardModeratorsEnv,
} = require("../server/configuration/helpers.mjs");
const {
  createConfig,
  closeServer,
  getTcpAddress,
  createSocketScenario,
} = require("./test_helpers.js");
const {
  Rectangle,
  Pencil,
  Hand,
  Eraser,
  Clear,
} = require("../client-data/tools/index.js");
const { MutationType: M } = require("../client-data/js/mutation_type.js");
const run = promisify(execFile);
const secret = "12".repeat(16);
/** @type {import("../client-data/js/board_chunks.js").ChunkSettings} */
const settings = {
  width: 4000,
  height: 3000,
  margin: 300,
  viewMode: "latest",
};

test("chunk settings reject malformed inputs and use fixed board-space boundaries", () => {
  assert.deepEqual(validateChunkSettings(settings), settings);
  assert.deepEqual(chunkRect(settings, { x: 8000, y: 5999 }), {
    x: 8000,
    y: 3000,
    width: 4000,
    height: 3000,
  });
  for (const value of [
    null,
    [],
    true,
    {},
    { ...settings, width: "4000" },
    { ...settings, height: Infinity },
    { ...settings, margin: -1 },
    { ...settings, width: 99 },
    { ...settings, height: 100001 },
    { ...settings, margin: 1.5 },
    { ...settings, viewMode: true },
    { ...settings, viewMode: "locked" },
  ])
    assert.equal(validateChunkSettings(value), null);
  assert.equal(parseStoredChunks(undefined), undefined);
  assert.deepEqual(
    parseStoredChunks(
      JSON.stringify({
        width: 4000,
        height: 3000,
        margin: 300,
        follow: true,
        locked: true,
        revision: "legacy",
        point: { x: 0, y: 0 },
      }),
    ),
    { ...settings, revision: "legacy", point: { x: 0, y: 0 } },
  );
  assert.throws(() => parseStoredChunks("{broken"));
  assert.throws(() =>
    parseStoredChunks(
      JSON.stringify({ ...DEFAULT_CHUNKS, point: { x: NaN, y: 0 } }),
    ),
  );
});

test("accepted create, transform, copy, erase and stroke endpoints track canonical activity without hydration", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wbo-chunks-"));
  const board = new BoardData(
    "activity",
    createConfig({ HISTORY_DIR: directory }),
  );
  t.after(async () => {
    board.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const session = getBoardSession(board);
  /** @param {any} message */
  const apply = async (message) => {
    const result = await session.acceptPersistentMutation(message);
    assert.equal(result.ok, true);
    return result.ok ? result.entry.activityPoint : null;
  };
  assert.deepEqual(
    await apply({
      tool: Rectangle.id,
      type: M.CREATE,
      id: "r1",
      x: 100,
      y: 100,
      x2: 300,
      y2: 300,
      color: "#123456",
      size: 10,
    }),
    { x: 200, y: 200 },
  );
  assert.deepEqual(
    await apply({
      tool: Hand.id,
      type: M.UPDATE,
      id: "r1",
      transform: { a: 1, b: 0, c: 0, d: 1, e: 5000, f: 6000 },
    }),
    { x: 5200, y: 6200 },
  );
  assert.deepEqual(
    await apply({ tool: Hand.id, type: M.COPY, id: "r1", newid: "r2" }),
    { x: 5200, y: 6200 },
  );
  assert.deepEqual(await apply({ tool: Eraser.id, type: M.DELETE, id: "r2" }), {
    x: 5200,
    y: 6200,
  });
  await apply({
    tool: Pencil.id,
    type: M.CREATE,
    id: "l1",
    x: 100,
    y: 100,
    color: "#123456",
    size: 10,
  });
  assert.deepEqual(
    await apply({
      tool: Pencil.id,
      type: M.APPEND,
      parent: "l1",
      x: 12000,
      y: 5000,
    }),
    { x: 12000, y: 5000 },
  );
  const failed = await session.acceptPersistentMutation({
    tool: Hand.id,
    type: M.UPDATE,
    id: "missing",
    transform: { a: 1, b: 0, c: 0, d: 1, e: 1, f: 1 },
  });
  assert.equal(failed.ok, false);
  assert.deepEqual(board.activityPoint, { x: 12000, y: 5000 });
  board.metadata = {
    ...board.metadata,
    chunks: { ...settings, revision: "test", point: board.activityPoint },
  };
  await board.save();
  const loaded = await BoardData.load("activity", board.config);
  t.after(() => loaded.dispose());
  assert.deepEqual(chunkState(loaded), chunkState(board));
  const stroke = loaded.itemsById.get("l1");
  assert.equal(stroke?.payload.kind, "children");
  const payload = JSON.stringify(stroke?.payload);
  const moved = await getBoardSession(loaded).acceptPersistentMutation({
    tool: Hand.id,
    type: M.UPDATE,
    id: "l1",
    transform: { a: 1, b: 0, c: 0, d: 1, e: 1000, f: 1000 },
  });
  assert.equal(moved.ok, true);
  assert.equal(JSON.stringify(loaded.itemsById.get("l1")?.payload), payload);
  assert.deepEqual(loaded.activityPoint, { x: 13000, y: 6000 });
  await apply({ tool: Clear.id, type: M.CLEAR });
  assert.deepEqual(board.activityPoint, { x: 0, y: 0 });
});

test("HTTP settings require moderator permission, survive an empty-board save, and bind v2 proofs to the body", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "wbo-chunks-http-"),
  );
  const keys = crypto.generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("hex");
  const config = createConfig({
    HOST: "127.0.0.1",
    PORT: 0,
    HISTORY_DIR: directory,
    AUTH_SECRET_KEY: "",
    BOARD_MODERATORS: parseBoardModeratorsEnv("WBO_BOARD_MODERATORS", {
      WBO_BOARD_MODERATORS: `seminar:${secret} cli:${secret} key:${publicKey}`,
    }),
  });
  const server = await createServerApp(config, { logStarted: false });
  t.after(async () => {
    await closeServer(server);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${getTcpAddress(server).port}`;
  const headers = {
    "Content-Type": "application/json",
    "X-WBO-Chunks": "1",
    Cookie: `wbo-user-secret-v1=${secret}`,
  };
  /** @param {unknown} body @param {Record<string,string>} [requestHeaders] @param {string} [board] */
  const post = (body, requestHeaders = headers, board = "seminar") =>
    fetch(`${url}/chunks/${board}`, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(body),
    });
  assert.equal((await post(settings, { ...headers, Cookie: "" })).status, 403);
  assert.equal((await post(settings, headers, "other")).status, 403);
  for (const input of [
    [],
    null,
    { ...settings, width: "4000" },
    { ...settings, point: { x: 9000, y: 9000 } },
    { ...settings, revision: "spoof" },
    { ...settings, toString: 1 },
    { ...settings, locked: true },
    { ...settings, follow: true },
  ])
    assert.equal((await post(input)).status, 400);
  assert.equal(
    (await post(settings, { ...headers, "X-WBO-Chunks": "" })).status,
    400,
  );
  assert.equal(
    (
      await fetch(`${url}/chunks/seminar`, {
        method: "POST",
        headers,
        body: "x".repeat(2049),
      })
    ).status,
    413,
  );
  const response = await post(settings);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const state = await response.json();
  assert.equal(state.viewMode, "latest");
  assert.ok(state.revision);
  const loaded = await BoardData.load("seminar", config);
  assert.deepEqual(chunkState(loaded), state);
  loaded.dispose();
  for (let i = 0; i < 9; i++) assert.equal((await post(settings)).status, 200);
  assert.equal((await post(settings)).status, 429);
  assert.equal(
    (await fetch(`${url}/chunks/seminar`, { method: "DELETE" })).status,
    405,
  );
  const cli = await run("python3", [
    "scripts/seminar_helper.py",
    "chunks",
    "--server",
    url,
    "--board",
    "cli",
    "--user-secret",
    secret,
    "--width",
    "6000",
    "--height",
    "5000",
    "--margin",
    "200",
    "--view-mode",
    "chunk",
  ]);
  assert.equal(JSON.parse(cli.stdout).width, 6000);
  assert.equal(
    (await getBoard("cli", config)).metadata.chunks?.viewMode,
    "chunk",
  );
  const body = JSON.stringify(settings);
  const challenge = await fetch(`${url}/auth/v2/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      board: "key",
      scope: "POST:/chunks/key",
      publicKey,
      bodyHash: crypto.createHash("sha512").update(body).digest("hex"),
    }),
  }).then((r) => r.json());
  const proof = `${JSON.parse(challenge.challenge)[6]}.${crypto.sign(null, Buffer.from(challenge.challenge), keys.privateKey).toString("hex")}`;
  const signed = { ...headers, Cookie: "", "X-WBO-Auth-V2": proof };
  assert.equal(
    (await post({ ...settings, width: 5000 }, signed, "key")).status,
    403,
  );
  assert.equal((await post(settings, signed, "key")).status, 403);
  const keyFile = path.join(directory, "key.json");
  await fs.writeFile(
    keyFile,
    JSON.stringify({
      format: "whitebophir-ed25519",
      version: 1,
      publicKey,
      privateKey: keys.privateKey
        .export({ format: "der", type: "pkcs8" })
        .subarray(-32)
        .toString("hex"),
    }),
    { mode: 0o600 },
  );
  const signedCli = await run("python3", [
    "scripts/seminar_helper.py",
    "chunks",
    "--server",
    url,
    "--board",
    "key",
    "--private-key-file",
    keyFile,
    "--view-mode",
    "latest",
  ]);
  assert.equal(JSON.parse(signedCli.stdout).viewMode, "latest");
});

test("new sockets receive current chunk state; accepted broadcasts carry activity, cursors do not", async () => {
  await createSocketScenario(
    { boardName: "socket-chunks" },
    async ({ connect, invoke, sockets }) => {
      const user = await connect({ id: "user" });
      assert.equal(
        user.emitted.find((e) => e.event === "chunk_state")?.payload.width,
        DEFAULT_CHUNKS.width,
      );
      await invoke(user, "broadcast", {
        tool: Rectangle.id,
        type: M.CREATE,
        id: "r1",
        x: 100,
        y: 100,
        x2: 300,
        y2: 300,
        color: "#123456",
        size: 10,
      });
      const frame = user.emitted.find(
        (e) => e.event === "broadcast" && e.payload.mutation?.id === "r1",
      );
      assert.deepEqual(frame?.payload.activityPoint, { x: 200, y: 200 });
      await invoke(user, "broadcast", {
        tool: 12,
        type: M.UPDATE,
        x: 60000,
        y: 60000,
        color: "#123456",
        size: 10,
      });
      assert.deepEqual(
        (await sockets.__test.getLoadedBoard("socket-chunks")).activityPoint,
        { x: 200, y: 200 },
      );
      const reconnect = await connect({ id: "reconnected" });
      assert.deepEqual(
        reconnect.emitted.find((e) => e.event === "chunk_state")?.payload.point,
        { x: 200, y: 200 },
      );
    },
  );
});

test("chunk API honors JWT board scope, reader access, and temporary moderator revocation", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "wbo-chunks-roles-"),
  );
  const config = createConfig({
    HOST: "127.0.0.1",
    PORT: 0,
    HISTORY_DIR: directory,
    AUTH_SECRET_KEY: "chunks-auth",
  });
  const server = await createServerApp(config, { logStarted: false });
  t.after(async () => {
    setTemporaryModerator("private", secret, null);
    await closeServer(server);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${getTcpAddress(server).port}/chunks/private`;
  const reader = jwt.sign({ roles: ["reader:private"] }, "chunks-auth");
  const moderator = jwt.sign({ roles: ["moderator:private"] }, "chunks-auth");
  const wrongBoard = jwt.sign(
    { roles: ["moderator:elsewhere"] },
    "chunks-auth",
  );
  const headers = {
    "Content-Type": "application/json",
    "X-WBO-Chunks": "1",
    Cookie: `wbo-user-secret-v1=${secret}`,
  };
  /** @param {string} token */
  const update = (token) =>
    fetch(`${url}?token=${token}`, {
      method: "POST",
      headers,
      body: JSON.stringify(settings),
    });
  assert.equal((await fetch(url)).status, 403);
  assert.equal((await fetch(`${url}?token=${reader}`)).status, 200);
  assert.equal((await update(reader)).status, 403);
  assert.equal((await update(wrongBoard)).status, 403);
  const board = await getBoard("private", config);
  board.metadata = { readonly: true };
  assert.equal((await update(moderator)).status, 200);
  setTemporaryModerator("private", secret, Date.now() + 60000);
  assert.equal((await update(reader)).status, 200);
  setTemporaryModerator("private", secret, null);
  assert.equal((await update(reader)).status, 403);
});
