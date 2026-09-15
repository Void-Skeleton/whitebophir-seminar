// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-15: v2 proof security and HTTP/CLI integration.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const {
  issueChallenge,
  verifyProof,
} = require("../server/auth/user_key_v2.mjs");
const {
  parseBoardModeratorsEnv,
} = require("../server/configuration/helpers.mjs");
const { BoardPermissions } = require("../server/auth/board_capabilities.mjs");
const { createServerApp } = require("../server/server.mjs");
const {
  createConfig,
  getTcpAddress,
  closeServer,
} = require("./test_helpers.js");
const { encodeArchive } = require("../server/board/archive.mjs");
const { getBoard } = require("../server/socket/index.mjs");
const nacl = require("../client-data/vendor/tweetnacl/nacl-fast.js");
const run = promisify(execFile);
const seed = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const privateKey = crypto.createPrivateKey({
  key: Buffer.from(`302e020100300506032b657004220420${seed}`, "hex"),
  format: "der",
  type: "pkcs8",
});
const publicKey = crypto
  .createPublicKey(privateKey)
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("hex");
const v1 = "0123456789abcdef0123456789abcdef";
const challengeInput = {
  board: "seminar",
  scope: "socket",
  publicKey,
  bodyHash: "",
  audience: "http://example.org",
};

/** @param {{challenge: string}} result */
function signChallenge(result) {
  const id = JSON.parse(result.challenge)[6];
  return `${id}.${crypto.sign(null, Buffer.from(result.challenge), privateKey).toString("hex")}`;
}

test("mixed v1 and v2 moderator entries require proof of the v2 private key", () => {
  const config = createConfig({
    BOARD_MODERATORS: parseBoardModeratorsEnv("WBO_BOARD_MODERATORS", {
      WBO_BOARD_MODERATORS: `seminar:${v1},${publicKey.toUpperCase()} seminar:${"ab".repeat(32)}`,
    }),
  });
  const permissions = (/** @type {any} */ userInfo, boardName = "seminar") =>
    BoardPermissions.forBoard({ config, boardName, userInfo });
  assert.equal(permissions({ userSecret: v1 }).canBan(), true);
  assert.equal(permissions({ userSecret: publicKey }).canBan(), false);
  assert.equal(permissions({ publicKey }).canBan(), false);
  assert.equal(permissions({ verifiedPublicKey: publicKey }).canBan(), true);
  assert.equal(
    permissions({ verifiedPublicKey: publicKey }, "another").canBan(),
    false,
  );
  for (const invalid of ["a".repeat(63), "a".repeat(65), "z".repeat(64)])
    assert.throws(() =>
      parseBoardModeratorsEnv("WBO_BOARD_MODERATORS", {
        WBO_BOARD_MODERATORS: `seminar:${invalid}`,
      }),
    );
});

test("browser signer matches Node Ed25519 and SHA-512 without Web Crypto", () => {
  const pair = nacl.sign.keyPair.fromSeed(Buffer.from(seed, "hex"));
  assert.equal(Buffer.from(pair.publicKey).toString("hex"), publicKey);
  for (const message of [Buffer.alloc(0), Buffer.from("WBO 你好 challenge")]) {
    assert.deepEqual(
      Buffer.from(nacl.sign.detached(message, pair.secretKey)),
      crypto.sign(null, message, privateKey),
    );
    assert.deepEqual(
      Buffer.from(nacl.hash(message)),
      crypto.createHash("sha512").update(message).digest(),
    );
  }
});

test("proofs expire, cannot be replayed, and are bound to board and operation", () => {
  const config = {};
  const make = () =>
    signChallenge(issueChallenge(config, challengeInput, "ip", 1000));
  const proof = make();
  assert.equal(
    verifyProof(config, proof, "seminar", "socket", 1001).publicKey,
    publicKey,
  );
  assert.throws(() => verifyProof(config, proof, "seminar", "socket", 1002));
  assert.throws(() => verifyProof(config, make(), "seminar", "socket", 61000));
  assert.throws(() => verifyProof(config, make(), "other", "socket", 1001));
  assert.throws(() =>
    verifyProof(config, make(), "seminar", "GET:/archive/seminar", 1001),
  );
  const invalid = make();
  assert.throws(() =>
    verifyProof(
      config,
      `${invalid.slice(0, 65)}${"0".repeat(128)}`,
      "seminar",
      "socket",
      1001,
    ),
  );
  assert.throws(() => verifyProof(config, invalid, "seminar", "socket", 1001));
  for (const malformed of [null, {}, [], 1, "", "a".repeat(10000)])
    assert.throws(() => verifyProof(config, malformed, "seminar", "socket"));
});

test("pending challenges are bounded per IP and expire without evicting valid proofs", () => {
  const config = {};
  for (let index = 0; index < 32; index++)
    issueChallenge(config, challengeInput, "ip", 1000);
  assert.throws(() => issueChallenge(config, challengeInput, "ip", 1001), {
    statusCode: 429,
  });
  const independent = signChallenge(
    issueChallenge(config, challengeInput, "other", 1001),
  );
  assert.equal(
    verifyProof(config, independent, "seminar", "socket", 1002).publicKey,
    publicKey,
  );
  assert.ok(issueChallenge(config, challengeInput, "ip", 61000));
});

/** @param {any} t @param {Record<string, any>} [overrides] */
async function start(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wbo-auth-v2-"));
  const config = createConfig({
    HOST: "127.0.0.1",
    PORT: 0,
    HISTORY_DIR: directory,
    AUTH_SECRET_KEY: "v2-test-auth",
    BOARD_MODERATORS: new Map([["seminar", new Set([v1, publicKey])]]),
    ...overrides,
  });
  const server = await createServerApp(config, { logStarted: false });
  t.after(async () => {
    await closeServer(server);
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    config,
    directory,
    url: `http://127.0.0.1:${getTcpAddress(server).port}`,
  };
}

/** @param {string} url @param {string} scope @param {Buffer | undefined} [body] */
async function httpProof(url, scope, body) {
  const response = await fetch(`${url}/auth/v2/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...challengeInput,
      scope,
      bodyHash: body
        ? crypto.createHash("sha512").update(body).digest("hex")
        : "",
    }),
  });
  assert.equal(response.status, 200);
  return signChallenge(await response.json());
}

test("plain HTTP rejects public-key impersonation and accepts signed board, SVG and archive requests", async (t) => {
  const { url } = await start(t);
  const headers = {
    Cookie: `wbo-user-secret-v2-public=${publicKey}; wbo-user-secret-v1=${publicKey}`,
  };
  assert.equal(
    (await fetch(`${url}/archive/seminar`, { headers })).status,
    403,
  );
  const gate = await fetch(`${url}/boards/seminar`, { headers });
  assert.equal(gate.headers.get("cache-control"), "no-store");
  const shell = await gate.text();
  assert.match(shell, /board_auth_gate.js/);
  assert.doesNotMatch(shell, /id="drawingArea"/);
  for (const target of [
    "/boards/seminar",
    "/boards/seminar.svg",
    "/archive/seminar",
  ]) {
    const proof = await httpProof(url, `GET:${target}`);
    const response = await fetch(url + target, {
      headers: { "X-WBO-Auth-V2": proof },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    await response.arrayBuffer();
    assert.equal(
      (await fetch(url + target, { headers: { "X-WBO-Auth-V2": proof } }))
        .status,
      403,
    );
  }
  const old = await fetch(`${url}/archive/seminar`, {
    headers: { Cookie: `wbo-user-secret-v1=${v1}` },
  });
  assert.equal(old.status, 200);
});

test("signed HTTP imports authenticate the exact body before modifying the board", async (t) => {
  const { config, url } = await start(t);
  const body = await encodeArchive([]);
  const proof = await httpProof(url, "POST:/archive/seminar", body);
  const response = await fetch(`${url}/archive/seminar`, {
    method: "POST",
    headers: {
      "Content-Type": "application/gzip",
      "X-WBO-Archive": "1",
      "X-WBO-Auth-V2": proof,
    },
    body: Buffer.concat([body, Buffer.from("tampered")]),
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "auth_v2_failed");
  assert.equal((await getBoard("seminar", config)).getSeq(), 0);
});

test("v2 navigation preserves public base paths, proxy origin and Unicode board names", async (t) => {
  const board = "研讨";
  const { url } = await start(t, {
    BASE_PATH: "/wbo",
    BOARD_MODERATORS: new Map([[board, new Set([publicKey])]]),
  });
  const pathname = `/boards/${encodeURIComponent(board).toLowerCase()}`;
  const headers = {
    "X-Forwarded-Host": "whiteboard.example",
    "X-Forwarded-Proto": "http",
  };
  const response = await fetch(`${url}/auth/v2/challenge`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      board,
      publicKey,
      scope: `GET:/wbo${pathname}`,
      bodyHash: "",
    }),
  });
  assert.equal(response.status, 200);
  const challenge = await response.json();
  assert.equal(
    JSON.parse(challenge.challenge)[1],
    "http://whiteboard.example/wbo",
  );
  const page = await fetch(
    `${url}${pathname}?authV2=${signChallenge(challenge)}`,
    { headers },
  );
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(await page.text(), /"canBan":true/);
});

test("malformed challenge requests fail deterministically", async (t) => {
  const { url } = await start(t);
  for (const body of [
    "{",
    "null",
    "[]",
    "{}",
    JSON.stringify({ ...challengeInput, board: "\ud800" }),
    JSON.stringify({ ...challengeInput, bodyHash: {} }),
    JSON.stringify({ ...challengeInput, scope: {} }),
    " ".repeat(2049),
  ]) {
    const response = await fetch(`${url}/auth/v2/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    assert.ok([400, 413].includes(response.status));
  }
  assert.equal((await fetch(`${url}/auth/v2/challenge`)).status, 405);
  assert.equal(
    (await fetch(`${url}/auth/v2/challenge`, { method: "POST", body: "{}" }))
      .status,
    400,
  );
});

test("Python v2 key generation and signed export/import work over HTTP", async (t) => {
  const { config, directory, url } = await start(t);
  const helper = path.resolve("scripts/seminar_helper.py");
  const generatedFile = path.join(directory, "generated-key.json");
  const generated = await run("python3", [helper, "keygen", generatedFile]);
  const generatedKey = JSON.parse(await fs.readFile(generatedFile, "utf8"));
  assert.match(generated.stdout, new RegExp(generatedKey.publicKey));
  assert.ok(!generated.stdout.includes(generatedKey.privateKey));
  assert.equal((await fs.stat(generatedFile)).mode & 0o777, 0o600);
  await assert.rejects(run("python3", [helper, "keygen", generatedFile]));
  const file = path.join(directory, "key.json");
  await fs.writeFile(
    file,
    JSON.stringify({
      format: "whitebophir-ed25519",
      version: 1,
      privateKey: seed,
      publicKey,
    }),
    { mode: 0o600 },
  );
  const archive = path.join(directory, "backup.wbo");
  const args = [
    "--server",
    url,
    "--board",
    "seminar",
    "--private-key-file",
    file,
  ];
  await run("python3", [helper, "export", archive, ...args]);
  await run("python3", [helper, "import", archive, ...args]);
  assert.equal((await getBoard("seminar", config)).getSeq(), 0);
});
