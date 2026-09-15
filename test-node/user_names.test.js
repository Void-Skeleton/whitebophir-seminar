// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-15: name validation, authorization and CLI URLs.
const assert = require("node:assert/strict");
const test = require("node:test");
const { execFileSync } = require("node:child_process");
const { normalizeUserName } = require("../client-data/js/user_name.js");
const { setUserName: rename } = require("../server/socket/user_names.mjs");
const { getBoardUser } = require("../server/socket/presence.mjs");
const { createSocketScenario } = require("./test_helpers.js");
const {
  setTemporaryModerator,
} = require("../server/socket/temporary_moderators.mjs");
const { banBoardUser } = require("../server/socket/bans.mjs");

/**
 * @param {import("./test_helpers.js").TestSocket} socket
 * @param {string} board
 * @param {unknown} message
 * @param {import("../types/server-runtime.d.ts").ServerConfig} config
 * @param {number} [now]
 */
function setUserName(socket, board, message, config, now) {
  return rename(
    /** @type {import("../types/server-runtime.d.ts").AppSocket} */ (
      /** @type {unknown} */ (socket)
    ),
    board,
    message,
    config,
    now,
  );
}

test("display names normalize Unicode and reject malformed or oversized values", () => {
  assert.equal(normalizeUserName("  张三 🖊️  "), "张三 🖊️");
  assert.equal(normalizeUserName("Jose\u0301"), "José");
  assert.equal(normalizeUserName("__proto__"), "__proto__");
  assert.equal(
    normalizeUserName("<img src=x onerror=alert(1)>"),
    "<img src=x onerror=alert(1)>",
  );
  assert.equal(normalizeUserName("a".repeat(64)), "a".repeat(64));
  for (const value of [
    undefined,
    null,
    {},
    [],
    1,
    "",
    "  ",
    "a".repeat(65),
    "name\n",
    "\u0000name",
    "\u007f",
    "\u202eevil",
    "\ud800",
    "\udfff",
    "\u2066name",
  ]) {
    assert.equal(normalizeUserName(value), null);
  }
});

test("entry and subsequent names preserve the authenticated user identity", async () => {
  await createSocketScenario(
    { boardName: "names" },
    async ({ connect, invoke, sockets }) => {
      const user = await connect({
        id: "user",
        headers: { cookie: `wbo-user-secret-v1=${"ab".repeat(16)}` },
        query: { name: "张三" },
      });
      const original = getBoardUser("names", "user");
      assert.equal(original?.name, "张三");
      assert.equal(original?.nameChosen, true);
      const userId = original?.userId;
      const result = await new Promise((resolve) => {
        void invoke(user, "set_user_name", { name: "New name" }, resolve);
      });
      assert.deepEqual(result, { ok: true, name: "New name" });
      assert.equal(original?.name, "New name");
      assert.equal(original?.userId, userId);
      assert.equal(original?.canBan, false);
      const reconnect = await connect({
        id: "another-tab",
        headers: { cookie: `wbo-user-secret-v1=${"ab".repeat(16)}` },
        query: { name: "Stale cookie" },
      });
      assert.equal(
        getBoardUser("names", reconnect.socket.id)?.name,
        "New name",
      );
      assert.equal(
        setUserName(
          user.socket,
          "names",
          { name: "New name", socketId: "gone" },
          sockets.__config,
        ).ok,
        false,
      );
    },
  );
});

test("moderators rename all matching tabs on one board, while ordinary users only rename themselves", async () => {
  const secret = "12".repeat(16);
  await createSocketScenario(
    {
      boardName: "names",
      config: { BOARD_MODERATORS: new Map([["names", new Set([secret])]]) },
    },
    async ({ connect, sockets }) => {
      const moderator = await connect({
        id: "mod",
        headers: { cookie: `wbo-user-secret-v1=${secret}` },
      });
      const targetOptions = {
        headers: { cookie: `wbo-user-secret-v1=${"34".repeat(16)}` },
        query: { name: "Original" },
      };
      const target = await connect({ ...targetOptions, id: "target" });
      await connect({ ...targetOptions, id: "target-tab" });
      await connect({
        ...targetOptions,
        id: "other-board",
        query: { board: "other", name: "Other name" },
      });
      const other = await connect({
        id: "other",
        headers: { cookie: `wbo-user-secret-v1=${"56".repeat(16)}` },
      });
      assert.deepEqual(
        setUserName(
          other.socket,
          "names",
          { name: "Spoof", socketId: "target" },
          sockets.__config,
        ),
        { ok: false, error: "user_name_forbidden" },
      );
      assert.deepEqual(
        setUserName(
          moderator.socket,
          "names",
          { name: "主持人指定", socketId: "target" },
          sockets.__config,
        ),
        { ok: true, name: "主持人指定" },
      );
      assert.equal(getBoardUser("names", "target")?.name, "主持人指定");
      assert.equal(getBoardUser("names", "target-tab")?.name, "主持人指定");
      assert.equal(getBoardUser("other", "other-board")?.name, "Other name");
      assert.deepEqual(
        setUserName(
          moderator.socket,
          "names",
          { name: "Cross board", socketId: "other-board" },
          sockets.__config,
        ),
        { ok: false, error: "user_name_unavailable" },
      );
      assert.deepEqual(
        setUserName(
          target.socket,
          "names",
          { name: "My choice" },
          sockets.__config,
        ),
        { ok: true, name: "My choice" },
      );
      assert.equal(getBoardUser("names", "target-tab")?.name, "My choice");
    },
  );
});

test("invalid name messages are rejected without mutation and rename floods are bounded", async () => {
  await createSocketScenario(
    { boardName: "names" },
    async ({ connect, sockets, invoke }) => {
      const user = await connect({ id: "user", query: { name: "Original" } });
      let now = 10000;
      for (const message of [
        null,
        [],
        3,
        "name",
        {},
        { name: {} },
        { name: "\n" },
        { name: "x", socketId: {} },
        { name: "x", socketId: "" },
      ]) {
        assert.equal(
          setUserName(user.socket, "names", message, sockets.__config, now).ok,
          false,
        );
        now += 11000;
        assert.equal(getBoardUser("names", "user")?.name, "Original");
      }
      for (let i = 0; i < 10; i++)
        assert.equal(
          setUserName(
            user.socket,
            "names",
            { name: `Name ${i}` },
            sockets.__config,
            now,
          ).ok,
          true,
        );
      assert.deepEqual(
        setUserName(
          user.socket,
          "names",
          { name: "Overflow" },
          sockets.__config,
          now,
        ),
        { ok: false, error: "user_name_rate_limited" },
      );
      assert.equal(getBoardUser("names", "user")?.name, "Name 9");
      assert.equal(
        setUserName(
          user.socket,
          "names",
          { name: "Later" },
          sockets.__config,
          now + 10000,
        ).ok,
        true,
      );
      await invoke(user, "set_user_name", null, "not a callback");
    },
  );
});

test("malformed handshake names do not join the board", async () => {
  await createSocketScenario({ boardName: "names" }, async ({ connect }) => {
    for (const name of [[], {}, "", "a".repeat(65), "\ud800", "name\n"]) {
      const user = await connect({ query: { name } });
      assert.equal(user.socket.disconnected, true);
      assert.equal(getBoardUser("names", user.socket.id), undefined);
    }
  });
});

test("rename authorization follows temporary grants and self-renaming remains available during edit bans", async () => {
  await createSocketScenario(
    { boardName: "names" },
    async ({ connect, sockets }) => {
      const secret = "78".repeat(16);
      const moderator = await connect({
        id: "temporary",
        headers: { cookie: `wbo-user-secret-v1=${secret}` },
      });
      const target = await connect({
        id: "target",
        headers: { cookie: `wbo-user-secret-v1=${"90".repeat(16)}` },
        query: { name: "Target" },
      });
      setTemporaryModerator("names", secret, Date.now() + 60000);
      assert.equal(
        setUserName(
          moderator.socket,
          "names",
          { name: "Renamed", socketId: "target" },
          sockets.__config,
        ).ok,
        true,
      );
      setTemporaryModerator("names", secret, null);
      assert.deepEqual(
        setUserName(
          moderator.socket,
          "names",
          { name: "Forbidden", socketId: "target" },
          sockets.__config,
        ),
        { ok: false, error: "user_name_forbidden" },
      );
      banBoardUser("names", "90".repeat(16), "127.0.0.1", Date.now());
      assert.equal(
        setUserName(
          target.socket,
          "names",
          { name: "Self name" },
          sockets.__config,
        ).ok,
        true,
      );
    },
  );
});

test("Python join-url safely encodes names and optional board tokens under a base path", () => {
  const command = [
    "scripts/seminar_helper.py",
    "join-url",
    "--server",
    "http://example.test/wbo",
    "--board",
    "讨论",
    "--name",
    "张三 & + #",
    "--token",
    "token-value",
  ];
  const url = new URL(
    execFileSync("python3", command, { encoding: "utf8" }).trim(),
  );
  assert.equal(url.pathname, `/wbo/boards/${encodeURIComponent("讨论")}`);
  assert.equal(url.searchParams.get("name"), "张三 & + #");
  assert.equal(url.searchParams.get("token"), "token-value");
  for (const name of ["bad\nname", "\ufeff", "\u0344".repeat(64)]) {
    assert.throws(() =>
      execFileSync(
        "python3",
        [
          "scripts/seminar_helper.py",
          "join-url",
          "--board",
          "test",
          "--name",
          name,
        ],
        { stdio: "pipe" },
      ),
    );
  }
});
