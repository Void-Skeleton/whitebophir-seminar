// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-16: history durability and timestamp snapshots.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { gunzipSync } = require("node:zlib");
const { BoardData } = require("../server/board/data.mjs");
const {
  initializeHistory,
  historicalSnapshot,
  readHistory,
} = require("../server/board/history.mjs");
const { getBoardSession } = require("../server/board/session.mjs");
const {
  decodeArchive,
  prepareArchiveImport,
} = require("../server/board/archive.mjs");
const { createConfig } = require("./test_helpers.js");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const runProcess = promisify(execFile);

/** @param {import("node:test").TestContext} t */
async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wbo-history-"));
  const config = createConfig({
    HISTORY_DIR: directory,
    SAVE_INTERVAL: 3600000,
    MAX_SAVE_DELAY: 3600000,
  });
  const board = await BoardData.load("history", config);
  await initializeHistory(board);
  t.after(async () => {
    board.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    board:
      /** @type {BoardData & {history: import("../server/board/history.mjs").BoardHistory}} */ (
        board
      ),
    config,
    directory,
  };
}

/** @param {any} board @param {any} message */
async function write(board, message, socket = "socket-a") {
  const result = await getBoardSession(board).acceptPersistentMutation(
    message,
    Date.now(),
    socket,
  );
  assert.equal(result.ok, true);
  return board.history.lastAtMs;
}

/** @param {any} board @param {any} config @param {number} at @returns {Promise<any>} */
async function snapshot(board, config, at) {
  return decodeArchive(
    await historicalSnapshot(board.history, at, board.history.offset, config),
    config,
  );
}

test("history preserves partial strokes, text, transforms, copies, erasure and clear in importable snapshots", async (t) => {
  const { board, config } = await setup(t);
  const initial = board.history.startedAtMs;
  // Advance the server clock monotonically in this board without wall-clock sleeps.
  board.history.timestamp = (time = Date.now()) =>
    Math.max(board.history.lastAtMs + 1, time);
  const start = await write(board, {
    tool: 1,
    type: 1,
    id: "line",
    color: "#123456",
    size: 10,
  });
  await write(board, { tool: 1, type: 4, parent: "line", x: 100, y: 200 });
  const partial = board.history.lastAtMs;
  await write(board, { tool: 1, type: 4, parent: "line", x: 120, y: 230 });
  await board.history.finishStroke("socket-a", "line", "release");
  const ended = board.history.lastAtMs;
  await write(board, {
    tool: 5,
    type: 1,
    id: "text",
    color: "#000000",
    size: 20,
    x: 20,
    y: 30,
  });
  await write(board, { tool: 5, type: 2, id: "text", txt: "Hello 中文" });
  await write(board, {
    tool: 7,
    _children: [
      {
        type: 2,
        id: "line",
        transform: { a: 1, b: 0, c: 0, d: 1, e: 40, f: 50 },
      },
      { type: 7, id: "line", newid: "copy" },
    ],
  });
  const copied = board.history.lastAtMs;
  await write(board, { tool: 6, type: 3, id: "line" });
  const deleted = board.history.lastAtMs;
  await write(board, { tool: 11, type: 6, id: "clear", token: null });
  const cleared = board.history.lastAtMs;
  assert.deepEqual((await snapshot(board, config, initial)).items, []);
  assert.deepEqual((await snapshot(board, config, start)).items, []);
  const emptySnapshot = await snapshot(board, config, start);
  assert.equal(emptySnapshot.replay.atMs, start);
  assert.equal(emptySnapshot.replay.seq, 1);
  assert.equal(emptySnapshot.replay.board, "history");
  assert.equal(emptySnapshot.replay.emptyPencils[0].id, "line");
  assert.equal(prepareArchiveImport(emptySnapshot, config).items.length, 0);
  assert.deepEqual(
    (await snapshot(board, config, partial)).items[0]._children,
    [{ x: 100, y: 200 }],
  );
  const complete = await snapshot(board, config, ended);
  assert.equal(complete.items[0]._children.length, 2);
  assert.equal((await snapshot(board, config, copied)).items.length, 3);
  const afterDelete = await snapshot(board, config, deleted);
  assert.deepEqual(
    afterDelete.items.map((/** @type {any} */ item) => item.id),
    ["text", "copy"],
  );
  assert.equal(afterDelete.items[0].txt, "Hello 中文");
  assert.equal(afterDelete.items[1].transform.e, 40);
  assert.equal(prepareArchiveImport(afterDelete, config).items.length, 2);
  assert.deepEqual((await snapshot(board, config, cleared)).items, []);
  const rows = gunzipSync(await fs.readFile(board.history.path))
    .toString()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const stroke = rows.find((row) => row.kind === "stroke");
  assert.equal(stroke.startAtMs, start);
  assert.equal(stroke.endAtMs, ended);
  assert.equal(stroke.reason, "release");
  await assert.rejects(snapshot(board, config, initial - 1), {
    reason: "history_before_start",
  });
});

test("history recovers accepted unsaved edits and settings and truncates only an incomplete tail", async (t) => {
  const { board, config } = await setup(t);
  await write(board, {
    tool: 1,
    type: 1,
    id: "line",
    color: "#123456",
    size: 10,
  });
  await write(board, { tool: 1, type: 4, parent: "line", x: 20, y: 30 });
  board.metadata = { readonly: false, theme: "dark" };
  await board.history.commit([], "", board.metadata);
  const offset = board.history.offset;
  await fs.appendFile(board.history.path, Buffer.from([31, 139, 8, 4, 0]));
  board.dispose(); // No SVG save: simulate process loss after journal acceptance.
  const recovered = await BoardData.load("history", config);
  t.after(() => recovered.dispose());
  await initializeHistory(recovered);
  assert.ok(recovered.history);
  assert.equal(recovered.getSeq(), 2);
  assert.equal(recovered.metadata.theme, "dark");
  assert.equal(recovered.get("line")?._children.length, 1);
  const members = [];
  for await (const member of readHistory(recovered.history.path))
    members.push(member);
  assert.equal(members[3]?.offset, offset);
  const interrupted = members
    .flatMap((member) => member.records)
    .find((row) => row.kind === "stroke");
  assert.equal(interrupted?.reason, "interrupted");
  assert.equal(recovered.history.strokes.size, 0);
  assert.equal((await recovered.save()).status, "saved");
  const reloaded = await BoardData.load("history", config);
  t.after(() => reloaded.dispose());
  await initializeHistory(reloaded);
  assert.ok(reloaded.history);
  assert.equal(reloaded.getSeq(), 2);
  assert.equal(
    (await snapshot(reloaded, config, reloaded.history.lastAtMs)).items[0]
      ._children.length,
    1,
  );
});

test("history rejects corruption and never publishes a mutation after a journal write failure", async (t) => {
  const { board, directory } = await setup(t);
  await fs.rename(board.history.path, `${board.history.path}.saved`);
  await fs.mkdir(board.history.path);
  await assert.rejects(
    getBoardSession(board).acceptPersistentMutation({
      tool: 3,
      type: 1,
      id: "rect",
      color: "#000000",
      size: 10,
      x: 0,
      y: 0,
      x2: 100,
      y2: 100,
    }),
  );
  assert.equal(board.disposed, true);
  const result = await getBoardSession(board).acceptPersistentMutation({
    tool: 11,
    type: 6,
    id: "clear",
    token: null,
  });
  assert.equal(result.ok, false);
  const source = await fs.readFile(`${board.history.path}.saved`);
  source[source.length - 8] = (source[source.length - 8] || 0) ^ 1; // Complete member with invalid CRC: do not truncate it.
  const corrupt = path.join(directory, "corrupt.gz");
  await fs.writeFile(corrupt, source);
  await assert.rejects(async () => {
    for await (const _member of readHistory(corrupt, Infinity, true)) {
    }
  });
  assert.equal((await fs.stat(corrupt)).size, source.length);
});

test("synchronized history survives SIGKILL before any SVG save", async (t) => {
  const { board, config, directory } = await setup(t);
  board.dispose();
  const childCode = `
    const { BoardData } = require('./server/board/data.mjs');
    const { initializeHistory } = require('./server/board/history.mjs');
    const { getBoardSession } = require('./server/board/session.mjs');
    const { createConfig } = require('./test-node/test_helpers.js');
    (async () => {
      const config = createConfig({ HISTORY_DIR: process.argv[1], SAVE_INTERVAL: 3600000, MAX_SAVE_DELAY: 3600000 });
      const board = await BoardData.load('history', config);
      await initializeHistory(board);
      const session = getBoardSession(board);
      await session.acceptPersistentMutation({ tool: 1, type: 1, id: 'crashed-stroke', color: '#123456', size: 10 }, Date.now(), 'killed-socket');
      await session.acceptPersistentMutation({ tool: 1, type: 4, parent: 'crashed-stroke', x: 100, y: 200 }, Date.now(), 'killed-socket');
      process.kill(process.pid, 'SIGKILL');
    })().catch((error) => { console.error(error); process.exit(1); });
  `;
  await assert.rejects(
    runProcess(process.execPath, ["-e", childCode, directory]),
    { signal: "SIGKILL" },
  );
  await assert.rejects(fs.stat(board.file), { code: "ENOENT" });
  const recovered = await BoardData.load("history", config);
  t.after(() => recovered.dispose());
  await initializeHistory(recovered);
  assert.ok(recovered.history);
  assert.equal(recovered.getSeq(), 2);
  const archive = await snapshot(recovered, config, recovered.history.lastAtMs);
  assert.deepEqual(archive.items[0]._children, [{ x: 100, y: 200 }]);
  const members = [];
  for await (const member of readHistory(recovered.history.path))
    members.push(member);
  const closed = members
    .flatMap((member) => member.records)
    .find((record) => record.kind === "stroke");
  assert.equal(closed?.reason, "interrupted");
});

test("restart recovery preserves previously accepted edits when admission limits decrease", async (t) => {
  const { board, config } = await setup(t);
  await write(board, {
    tool: 1,
    type: 1,
    id: "line",
    color: "#123456",
    size: 10,
  });
  await write(board, { tool: 1, type: 4, parent: "line", x: 100, y: 100 });
  await write(board, { tool: 1, type: 4, parent: "line", x: 200, y: 200 });
  board.dispose();
  const recovered = await BoardData.load("history", {
    ...config,
    MAX_CHILDREN: 1,
    MAX_BOARD_SIZE: 100,
  });
  t.after(() => recovered.dispose());
  await initializeHistory(recovered);
  assert.equal(recovered.getSeq(), 3);
  assert.deepEqual(recovered.get("line")?._children, [
    { x: 100, y: 100 },
    { x: 200, y: 200 },
  ]);
  assert.equal(recovered.maxChildren, 1);
  assert.equal(recovered.maxBoardSize, 100);
});
