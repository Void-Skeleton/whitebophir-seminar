// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-15: real insecure-origin Ed25519 authentication.
import { createPrivateKey, createPublicKey } from "node:crypto";
import { createBoardPage, expect, test } from "../fixtures/test";
import { TOKENS } from "../helpers/tokens";

const seed = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const secondSeed = "01".repeat(32);
const legacySecret = "0123456789abcdef0123456789abcdef";
function publicKeyFor(privateSeed: string) {
  const key = createPrivateKey({
    key: Buffer.from(`302e020100300506032b657004220420${privateSeed}`, "hex"),
    format: "der",
    type: "pkcs8",
  });
  return createPublicKey(key)
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("hex");
}
const publicKey = publicKeyFor(seed);

test.use({
  launchOptions: {
    args: ["--no-proxy-server"],
  },
  serverOptions: {
    useJWT: true,
    token: "",
    env: {
      WBO_BOARD_MODERATORS: `v2-board:${legacySecret},${publicKey},${publicKeyFor(secondSeed)}`,
    },
  },
});

test.beforeEach(async ({ server, context }) => {
  const url = new URL(server.serverUrl);
  url.hostname = "0.0.0.0";
  server.serverUrl = url.href.replace(/\/$/, "");
  await context.addCookies([
    {
      name: "wbo-user-secret-v2-public",
      value: publicKey,
      url: server.serverUrl,
    },
  ]);
});

test("v2 moderators open, upload, download and reconnect on a real plain HTTP origin", async ({
  boardPage,
  page,
  context,
  server,
}) => {
  await context.addInitScript(
    (privateSeed) =>
      localStorage.setItem("wbo-user-secret-v2-private", privateSeed),
    seed,
  );
  const requests: string[] = [];
  page.on("request", (request) =>
    requests.push(
      JSON.stringify({
        url: request.url(),
        headers: request.headers(),
        body: request.postData(),
      }),
    ),
  );
  await server.writeBoard(server.dataPath, "v2-board", {
    r1: {
      id: "r1",
      tool: "rectangle",
      color: "#123456",
      size: 10,
      x: 100,
      y: 100,
      x2: 200,
      y2: 200,
    },
  });
  await boardPage.gotoBoard("v2-board", { lang: "en" });
  await boardPage.waitForSocketConnected();
  expect(
    await page.evaluate(() => ({
      secure: isSecureContext,
      subtle: typeof crypto.subtle,
    })),
  ).toEqual({ secure: false, subtle: "undefined" });
  await expect
    .poll(() => page.evaluate(() => window.WBOApp.access.canBan))
    .toBe(true);
  expect(new URL(page.url()).searchParams.has("authV2")).toBe(false);
  await expect(boardPage.tool("clear")).toBeVisible();

  await page.locator("#boardThemeToggle").click();
  await expect(page.locator("#canvas")).toHaveAttribute(
    "data-wbo-theme",
    "dark",
  );

  await boardPage.tool("download").click();
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export WBO backup", exact: true })
    .click();
  const file = await (await downloading).path();
  if (!file) throw new Error("Missing archive download");
  await boardPage.tool("download").click();
  const choosing = page.waitForEvent("filechooser");
  await page
    .getByRole("button", { name: "Import WBO backup", exact: true })
    .click();
  await (await choosing).setFiles(file);
  await expect(
    page.getByText("Backup imported.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "I understand", exact: true }).click();
  await expect(page.locator("#drawingArea > rect")).toHaveCount(2);

  const previousSocket = await page.evaluate(() => {
    const socket = window.WBOApp.connection.socket;
    const id = socket?.id;
    socket?.io?.engine?.close();
    return id;
  });
  await expect
    .poll(() => page.evaluate(() => window.WBOApp.connection.socket?.id))
    .not.toBe(previousSocket);
  await boardPage.waitForSocketConnected();
  await expect
    .poll(() => page.evaluate(() => window.WBOApp.access.canBan))
    .toBe(true);
  await expect(page.locator("#drawingArea > rect")).toHaveCount(2);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute(
    "data-board-phase",
    "ready",
  );
  await boardPage.waitForSocketConnected();
  await expect(page.locator("#drawingArea > rect")).toHaveCount(2);
  expect(requests.join("\n")).not.toContain(seed);
  await expect(page.locator("#canvas")).toHaveAttribute(
    "data-wbo-theme",
    "dark",
  );
  expect(
    (await context.cookies()).some(
      (cookie) => cookie.name === "wbo-user-secret-v2-private",
    ),
  ).toBe(false);
});

test("v2 socket proofs cannot be replayed or used with HTTP polling", async ({
  boardPage,
  page,
  context,
}) => {
  await context.addInitScript(
    (privateSeed) =>
      localStorage.setItem("wbo-user-secret-v2-private", privateSeed),
    seed,
  );
  await boardPage.gotoBoard("v2-board");
  await boardPage.waitForSocketConnected();
  const results = await page.evaluate(async () => {
    const auth = await import("/js/board_auth_v2.js");
    const originalProof = window.WBOApp.connection.socket?.auth?.v2;
    const errors: string[] = [];
    for (const transport of ["websocket", "polling"]) {
      const v2 =
        transport === "websocket"
          ? originalProof
          : await auth.createProof("v2-board", "socket");
      const result = await new Promise<string>((resolve) => {
        const socket = io.connect("", {
          path: "/socket.io",
          reconnection: false,
          reconnectionDelay: 100,
          timeout: 10000,
          autoConnect: false,
          transports: [transport],
          query: "board=v2-board&baselineSeq=0",
          auth: { v2 },
        });
        socket.on("connect_error", (error) => {
          socket.disconnect?.();
          resolve(error.message);
        });
        socket.on("connect", () => {
          socket.disconnect?.();
          resolve("unexpected_connection");
        });
        socket.connect();
      });
      errors.push(result);
    }
    return errors;
  });
  expect(results).toEqual(["auth_v2_failed", "auth_v2_failed"]);
});

test("a public-key cookie alone cannot authenticate or expose the private board", async ({
  page,
  boardPage,
}) => {
  const denied = page.waitForResponse(
    (response) =>
      response.request().isNavigationRequest() && response.status() === 403,
  );
  await page.goto(`${boardPage.server.serverUrl}/boards/v2-board?lang=en`);
  await denied;
  await page.waitForURL((url) => url.searchParams.has("authV2"));
  await expect(page.locator("#drawingArea")).toHaveCount(0);
  await boardPage.gotoBoard("v2-board", {
    lang: "en",
    token: TOKENS.globalEditor,
  });
  await boardPage.waitForSocketConnected();
  expect(await page.evaluate(() => window.WBOApp.access.canBan)).toBe(false);
  await boardPage.tool("download").click();
  await expect(
    page.getByRole("button", { name: "Import WBO backup", exact: true }),
  ).toHaveCount(0);
});

test("v1 moderators still work alongside multiple v2 public keys", async ({
  page,
  boardPage,
  context,
  server,
}) => {
  await context.addCookies([
    { name: "wbo-user-secret-v1", value: legacySecret, url: server.serverUrl },
  ]);
  await boardPage.gotoBoard("v2-board");
  await boardPage.waitForSocketConnected();
  await expect
    .poll(() => page.evaluate(() => window.WBOApp.access.canBan))
    .toBe(true);
  await context.clearCookies();
  await context.addCookies([
    {
      name: "wbo-user-secret-v2-public",
      value: publicKeyFor(secondSeed),
      url: server.serverUrl,
    },
  ]);
  await context.addInitScript(
    (privateSeed) =>
      localStorage.setItem("wbo-user-secret-v2-private", privateSeed),
    secondSeed,
  );
  await boardPage.gotoBoard("v2-board");
  await boardPage.waitForSocketConnected();
  await expect
    .poll(() => page.evaluate(() => window.WBOApp.access.canBan))
    .toBe(true);
});

const identityCases = [
  { name: "both keys missing", privateSeed: null, publicKey: null },
  { name: "private key missing", privateSeed: null, publicKey },
  { name: "public key missing", privateSeed: seed, publicKey: null },
  {
    name: "keys mismatched",
    privateSeed: seed,
    publicKey: publicKeyFor(secondSeed),
  },
  { name: "private key malformed", privateSeed: "not-a-key", publicKey },
  { name: "public key malformed", privateSeed: seed, publicKey: "not-a-key" },
  { name: "both keys empty", privateSeed: "", publicKey: "" },
  { name: "valid matching keys", privateSeed: seed, publicKey, preserve: true },
  {
    name: "valid uppercase keys",
    privateSeed: seed.toUpperCase(),
    publicKey: publicKey.toUpperCase(),
    preserve: true,
  },
];

for (const initial of identityCases) {
  test(`HTTP board startup handles ${initial.name} automatically`, async ({
    page,
    boardPage,
    context,
    server,
  }) => {
    await page.goto(server.serverUrl);
    await context.clearCookies({ name: "wbo-user-secret-v2-public" });
    if (initial.publicKey !== null)
      await context.addCookies([
        {
          name: "wbo-user-secret-v2-public",
          value: initial.publicKey,
          url: server.serverUrl,
        },
      ]);
    await page.evaluate((privateSeed) => {
      if (privateSeed !== null)
        localStorage.setItem("wbo-user-secret-v2-private", privateSeed);
    }, initial.privateSeed);

    const requests: string[] = [];
    page.on("request", (request) =>
      requests.push(
        JSON.stringify({
          url: request.url(),
          headers: request.headers(),
          body: request.postData(),
        }),
      ),
    );
    await boardPage.gotoBoard("v2-board", { token: TOKENS.globalEditor });
    await boardPage.waitForSocketConnected();
    const storedSeed = await page.evaluate(() =>
      localStorage.getItem("wbo-user-secret-v2-private"),
    );
    expect(storedSeed).toMatch(/^[0-9a-f]{64}$/i);
    if (!storedSeed) throw new Error("Missing generated private seed");
    const cookies = await context.cookies(server.serverUrl);
    const storedPublicKey = cookies.find(
      (cookie) => cookie.name === "wbo-user-secret-v2-public",
    )?.value;
    expect(storedPublicKey?.toLowerCase()).toBe(publicKeyFor(storedSeed));
    expect(
      cookies.some((cookie) => cookie.name === "wbo-user-secret-v2-private"),
    ).toBe(false);
    if (initial.preserve) {
      expect(storedSeed).toBe(initial.privateSeed);
      expect(storedPublicKey).toBe(initial.publicKey);
    } else {
      expect(storedSeed).not.toBe(initial.privateSeed);
      expect(storedSeed).not.toBe(seed);
      expect(storedSeed).not.toBe(secondSeed);
      expect(storedPublicKey).not.toBe(initial.publicKey);
    }
    expect(await page.evaluate(() => window.WBOApp.access.canBan)).toBe(
      !!initial.preserve,
    );
    expect(
      await page.evaluate(() => ({
        secure: isSecureContext,
        subtle: typeof crypto.subtle,
      })),
    ).toEqual({ secure: false, subtle: "undefined" });

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute(
      "data-board-phase",
      "ready",
    );
    await boardPage.waitForSocketConnected();
    expect(
      await page.evaluate(() =>
        localStorage.getItem("wbo-user-secret-v2-private"),
      ),
    ).toBe(storedSeed);
    const publicKeys = await page.evaluate(async () => {
      const auth = await import("/js/board_auth_v2.js");
      return Promise.all([auth.createIdentity(), auth.createIdentity()]);
    });
    expect(publicKeys).toEqual([
      storedPublicKey?.toLowerCase(),
      storedPublicKey?.toLowerCase(),
    ]);
    expect(requests.join("\n")).not.toContain(storedSeed);
  });
}

test("simultaneous tabs generate one shared identity on plain HTTP", async ({
  page,
  context,
  server,
  boardPage,
}) => {
  await context.clearCookies();
  const peers = await Promise.all([
    context.newPage(),
    context.newPage(),
    context.newPage(),
  ]);
  const seeds = await Promise.all(
    [page, ...peers].map(async (tab) => {
      const board = createBoardPage(tab, server);
      await board.gotoBoard("v2-board", { token: TOKENS.globalEditor });
      await board.waitForSocketConnected();
      return tab.evaluate(() =>
        localStorage.getItem("wbo-user-secret-v2-private"),
      );
    }),
  );
  expect(seeds[0]).toMatch(/^[0-9a-f]{64}$/);
  expect(new Set(seeds).size).toBe(1);
  await boardPage.connectedUsersToggle.click();
  await expect.poll(() => boardPage.readConnectedUsers()).toHaveLength(4);
  const rows = await boardPage.readConnectedUsers();
  expect(new Set(rows.map((row) => row.userId)).size).toBe(1);
  expect(rows.every((row) => row.reportHidden && row.friendHidden)).toBe(true);
  await Promise.all(peers.map((peer) => peer.close()));
});

test("explicit key import replaces an automatically generated identity", async ({
  page,
  boardPage,
  context,
}) => {
  await boardPage.gotoBoard("v2-board", { token: TOKENS.globalEditor });
  await boardPage.waitForSocketConnected();
  expect(await page.evaluate(() => window.WBOApp.access.canBan)).toBe(false);
  const importedPublicKey = await page.evaluate(async (privateSeed) => {
    const auth = await import("/js/board_auth_v2.js");
    const imported = await auth.setIdentity(privateSeed);
    window.WBOApp.connection.start();
    return imported;
  }, seed);
  expect(importedPublicKey).toBe(publicKey);
  await boardPage.waitForSocketConnected();
  await expect
    .poll(() => page.evaluate(() => window.WBOApp.access.canBan))
    .toBe(true);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("wbo-user-secret-v2-private"),
    ),
  ).toBe(seed);
  expect(
    (await context.cookies()).find(
      (cookie) => cookie.name === "wbo-user-secret-v2-public",
    )?.value,
  ).toBe(publicKey);
});
