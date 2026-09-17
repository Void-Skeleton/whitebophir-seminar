const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { BoardData } = require("../server/board/data.mjs");
const {
  initializeHistory,
  historicalSnapshot,
} = require("../server/board/history.mjs");
const { getBoardSession } = require("../server/board/session.mjs");
const { reverseEdit } = require("../server/socket/edit_history.mjs");
const {
  normalizeIncomingMessage,
} = require("../server/socket/message_validation.mjs");
const { decodeArchive } = require("../server/board/archive.mjs");
const { validateRestore } = require("../server/board/restore.mjs");
const { createConfig, createSocket } = require("./test_helpers.js");

/** @param {import("node:test").TestContext} t */
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wbo-undo-"));
  const config = createConfig({
    HISTORY_DIR: dir,
    SAVE_INTERVAL: 3600000,
    MAX_SAVE_DELAY: 3600000,
  });
  const board = await BoardData.load("undo", config);
  await initializeHistory(board);
  const alice = createSocket({ id: "alice" }).socket;
  const bob = createSocket({ id: "bob" }).socket;
  Object.assign(alice, { connected: true });
  Object.assign(bob, { connected: true });
  t.after(async () => {
    board.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return {
    board,
    config,
    alice,
    bob,
    /** @param {any} message @param {string} group @param {any} [socket] */
    write: (message, group, socket = alice) =>
      getBoardSession(board).acceptPersistentMutation(
        message,
        Date.now(),
        socket.id,
        { owner: socket.id, group },
      ),
    /** @param {boolean} [redo] @param {any} [socket] */
    reverse: (redo = false, socket = alice) =>
      reverseEdit(socket, board, redo, config),
  };
}
/** @param {string} id */
function rect(id) {
  return {
    tool: 3,
    type: 1,
    id,
    x: 10,
    y: 20,
    x2: 100,
    y2: 110,
    color: "#000000",
    size: 10,
  };
}

test("one undo removes a whole stroke, redo survives SVG saves and journal recovery", async (t) => {
  const { board, config, write, reverse } = await setup(t);
  await write(
    { tool: 1, type: 1, id: "line", color: "#123456", size: 10 },
    "stroke",
  );
  for (let i = 0; i < 20; i++)
    await write(
      { tool: 1, type: 4, parent: "line", x: 10 + i, y: 20 + i },
      "stroke",
    );
  await board.history?.finishStroke("alice", "line", "release");
  await board.save();
  assert.equal((await reverse()).ok, true);
  assert.equal(board.get("line"), undefined);
  assert.equal((await reverse(true)).ok, true);
  assert.equal(board.get("line")?._children.length, 20);
  assert.equal(board.get("line")?.color, "#123456");
  await board.save();
  const reloaded = await BoardData.load("undo", config);
  await initializeHistory(reloaded);
  t.after(() => reloaded.dispose());
  assert.equal(reloaded.authoritativeItemCount(), 1);
  assert.ok(board.history);
  const archive = /** @type {any} */ (
    await decodeArchive(
      await historicalSnapshot(
        board.history,
        board.history.lastAtMs,
        board.history.offset,
        config,
      ),
      config,
    )
  );
  assert.equal(archive.items[0]._children.length, 20);
});

test("personal undo leaves other users' edits intact and refuses conflicting edits", async (t) => {
  const { board, bob, write, reverse } = await setup(t);
  await write(rect("alice-rect"), "a");
  await write(rect("bob-rect"), "b", bob);
  assert.equal((await reverse()).ok, true);
  assert.ok(board.get("bob-rect"));
  assert.equal(board.get("alice-rect"), undefined);
  assert.equal((await reverse(true)).ok, true);
  await write(
    { tool: 3, type: 2, id: "alice-rect", x2: 200, y2: 220 },
    "peer-change",
    bob,
  );
  assert.equal((await reverse()).error, "undo_conflict");
  assert.equal(board.get("alice-rect")?.x2, 200);
});

test("erasure restores stored pencil geometry at its original layer", async (t) => {
  const { board, config, write, reverse } = await setup(t);
  await write(
    { tool: 1, type: 1, id: "line", color: "#000000", size: 10 },
    "stroke",
  );
  await write({ tool: 1, type: 4, parent: "line", x: 20, y: 30 }, "stroke");
  await write(rect("overlap"), "shape");
  await board.save();
  await write({ tool: 6, type: 3, id: "line" }, "erase");
  await board.save();
  assert.equal((await reverse()).ok, true);
  assert.deepEqual(board.get("line")?._children, [{ x: 20, y: 30 }]);
  assert.deepEqual(board.paintOrder, ["line", "overlap"]);
  await board.save();
  const reloaded = await BoardData.load("undo", config);
  t.after(() => reloaded.dispose());
  assert.deepEqual(reloaded.paintOrder, ["line", "overlap"]);
});

test("moves, text edits and copies undo as individual actions; new edits discard redo", async (t) => {
  const { board, write, reverse } = await setup(t);
  await write(rect("rectangle"), "create");
  await write(
    {
      tool: 7,
      _children: [
        {
          type: 2,
          id: "rectangle",
          transform: { a: 1, b: 0, c: 0, d: 1, e: 30, f: 40 },
        },
      ],
    },
    "move",
  );
  assert.equal((await reverse()).ok, true);
  assert.equal(board.get("rectangle")?.transform, undefined);
  assert.equal((await reverse(true)).ok, true);
  assert.equal(board.get("rectangle")?.transform.e, 30);
  await write(
    { tool: 7, _children: [{ type: 7, id: "rectangle", newid: "copy" }] },
    "copy",
  );
  assert.equal((await reverse()).ok, true);
  assert.equal(board.get("copy"), undefined);
  await write(
    { tool: 5, type: 1, id: "text", color: "#000000", size: 20, x: 10, y: 20 },
    "text-create",
  );
  await write({ tool: 5, type: 2, id: "text", txt: "first" }, "text-create");
  await board.save();
  await write({ tool: 5, type: 2, id: "text", txt: "second" }, "text-edit");
  assert.equal((await reverse()).ok, true);
  assert.equal(board.get("text")?.txt, "first");
  await write(rect("new"), "new-edit");
  assert.equal((await reverse(true)).error, "redo_empty");
});

test("undo respects current editing access and rejects forged restoration messages", async (t) => {
  const { board, config, write, reverse } = await setup(t);
  await write(rect("rectangle"), "create");
  board.metadata.readonly = true;
  assert.equal((await reverse()).ok, false);
  assert.ok(board.get("rectangle"));
  const forged = {
    tool: 7,
    type: 8,
    items: [{ id: "rectangle", item: null, order: 0 }],
  };
  assert.equal(normalizeIncomingMessage(config, forged).ok, false);
  assert.throws(() =>
    validateRestore(
      { ...forged, items: [{ id: "bad", order: -1, item: null }] },
      config,
    ),
  );
});

test("rejected edits do not consume undo or discard redo", async (t) => {
  const { board, write, reverse } = await setup(t);
  await write(rect("rectangle"), "create");
  await reverse();
  const result = await write(
    { tool: 3, type: 2, id: "missing", x2: 10, y2: 20 },
    "rejected",
  );
  assert.equal(result.ok, false);
  assert.equal((await reverse(true)).ok, true);
  assert.ok(board.get("rectangle"));
});

test("a multi-object eraser gesture restores all objects without undoing other edits", async (t) => {
  const { board, bob, write, reverse } = await setup(t);
  await write(rect("first"), "create1");
  await write(rect("second"), "create2");
  await write({ tool: 6, type: 3, id: "first" }, "erase");
  await write(rect("peer"), "peer", bob);
  await write({ tool: 6, type: 3, id: "second" }, "erase");
  assert.equal((await reverse()).ok, true);
  assert.ok(board.get("first"));
  assert.ok(board.get("second"));
  assert.ok(board.get("peer"));
});
