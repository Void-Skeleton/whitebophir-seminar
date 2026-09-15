// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-15: real HTTP display-name entry and moderation.
import type { Page } from "@playwright/test";
import { createServer, request } from "node:http";
import type { Socket } from "node:net";
import { createBoardPage, expect, test as base } from "../fixtures/test";

// WBO_BASE_PATH describes a reverse proxy that strips the public prefix.
const test = base.extend<{ nameProxy: undefined }>({
  nameProxy: [
    async ({ server }, use) => {
      const backend = new URL(server.serverUrl);
      const sockets = new Set<Socket>();
      const proxy = createServer((incoming, response) => {
        const outgoing = request(
          {
            hostname: backend.hostname,
            port: backend.port,
            path: incoming.url?.replace(/^\/wbo/, "") || "/",
            method: incoming.method,
            headers: incoming.headers,
          },
          (upstream) => {
            response.writeHead(upstream.statusCode || 502, upstream.headers);
            upstream.pipe(response);
          },
        );
        outgoing.on("error", () => {
          response.writeHead(502);
          response.end();
        });
        incoming.pipe(outgoing);
      });
      proxy.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      proxy.on("upgrade", (incoming, client, head) => {
        const outgoing = request({
          hostname: backend.hostname,
          port: backend.port,
          path: incoming.url?.replace(/^\/wbo/, "") || "/",
          headers: incoming.headers,
        });
        outgoing.on("upgrade", (response, upstream, upstreamHead) => {
          client.write(
            `HTTP/1.1 101 Switching Protocols\r\n${response.rawHeaders.reduce((text, value, i) => text + (i % 2 ? `${value}\r\n` : `${value}: `), "")}\r\n`,
          );
          if (head.length) upstream.write(head);
          if (upstreamHead.length) client.write(upstreamHead);
          client.pipe(upstream).pipe(client);
          client.on("close", () => upstream.destroy());
          upstream.on("error", () => client.destroy());
        });
        outgoing.on("error", () => client.destroy());
        outgoing.end();
      });
      await new Promise<void>((resolve) => proxy.listen(0, "0.0.0.0", resolve));
      const address = proxy.address();
      if (!address || typeof address === "string")
        throw new Error("Missing proxy address");
      server.serverUrl = `http://0.0.0.0:${address.port}/wbo`;
      try {
        await use(undefined);
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
      }
    },
    { auto: true },
  ],
});

const moderatorSecret = "12".repeat(16);
test.use({
  launchOptions: { args: ["--no-proxy-server"] },
  serverOptions: {
    useJWT: false,
    env: {
      WBO_BASE_PATH: "/wbo",
      WBO_BOARD_MODERATORS: `names:${moderatorSecret}`,
    },
  },
});

async function ownName(page: Page) {
  return page.evaluate(
    () =>
      window.WBOApp.presence.users.get(
        window.WBOApp.connection.socket?.id || "",
      )?.name,
  );
}

async function saveName(page: Page, name: string) {
  await page.locator("#user-name-input").fill(name);
  await page.locator(".user-name-dialog button[type=submit]").click();
  await expect(page.locator(".user-name-dialog")).toHaveCount(0);
}

test("first entry prompts with the generated name and remembers a different name for each board", async ({
  page,
  boardPage,
  context,
  server,
}) => {
  await boardPage.gotoBoard("讨论", {
    lang: "zh-CN",
    chooseDefaultName: false,
  });
  await boardPage.waitForSocketConnected(false);
  await expect(page.locator(".user-name-dialog .wbo-dialog-title")).toHaveText(
    "设置你在此白板上的名称",
  );
  const generated = await ownName(page);
  await expect(page.locator("#user-name-input")).toHaveValue(generated || "");
  expect(await page.evaluate(() => isSecureContext)).toBe(false);
  await saveName(page, "张三");
  await expect.poll(() => ownName(page)).toBe("张三");
  const cookie = (await context.cookies(page.url())).find(
    (cookie) => cookie.name === "wbo-board-name-v1",
  );
  expect(cookie?.value).toBe(encodeURIComponent("张三"));
  expect(cookie?.path).toBe(`/wbo/boards/${encodeURIComponent("讨论")}`);
  expect(cookie?.secure).toBe(false);
  await page.reload();
  await boardPage.waitForSocketConnected(false);
  await expect.poll(() => ownName(page)).toBe("张三");
  await expect(page.locator(".user-name-dialog")).toHaveCount(0);

  await boardPage.gotoBoard("other", { chooseDefaultName: false });
  await boardPage.waitForSocketConnected(false);
  await expect(page.locator("#user-name-input")).toBeVisible();
  await page.locator(".user-name-dialog button[type=button]").click();
  await expect
    .poll(() => page.evaluate(() => window.WBOApp.presence.names.resolved))
    .toBe(true);
  const other = await ownName(page);
  expect(other).not.toBe("张三");
  await boardPage.gotoBoard("讨论");
  await boardPage.waitForSocketConnected(false);
  await expect.poll(() => ownName(page)).toBe("张三");
  await boardPage.gotoBoard("讨论", { query: { name: "李四" } });
  await boardPage.waitForSocketConnected(false);
  await expect.poll(() => ownName(page)).toBe("李四");
  expect(new URL(page.url()).searchParams.has("name")).toBe(false);
  expect(
    (await context.cookies(`${server.serverUrl}/boards/other`)).find(
      (cookie) => cookie.name === "wbo-board-name-v1",
    )?.value,
  ).toBe(encodeURIComponent(other || ""));
});

test("homepage names reach named, public and random boards", async ({
  page,
  server,
  boardPage,
}) => {
  for (const entry of ["named", "public", "random"]) {
    await page.goto(`${server.serverUrl}/?lang=en`);
    await page.locator("#user-name").fill(`Guest ${entry}`);
    if (entry === "named") {
      await page.locator("#board").fill("Named Board");
      await page.locator("#named-board-form input[type=submit]").click();
    } else {
      await page
        .locator(
          entry === "public"
            ? 'a[href="boards/anonymous"]'
            : 'a[href="random"]',
        )
        .click();
    }
    await page.waitForURL(/\/boards\//);
    await boardPage.waitForSocketConnected(false);
    await expect.poll(() => ownName(page)).toBe(`Guest ${entry}`);
    await expect(page.locator(".user-name-dialog")).toHaveCount(0);
  }
});

test("self and moderator rename controls update all matching tabs without changing identity or other boards", async ({
  page,
  boardPage,
  context,
  browser,
  server,
}) => {
  await context.addCookies([
    {
      name: "wbo-user-secret-v1",
      value: moderatorSecret,
      url: server.serverUrl,
    },
  ]);
  await boardPage.gotoBoard("names", { query: { name: "Host" } });
  await boardPage.waitForSocketConnected();
  const guestContext = await browser.newContext();
  try {
    const guest = await guestContext.newPage();
    const secondTab = await guestContext.newPage();
    const otherBoard = await guestContext.newPage();
    const guestBoard = createBoardPage(guest, server);
    const secondBoard = createBoardPage(secondTab, server);
    await guestBoard.gotoBoard("names", { query: { name: "Guest" } });
    await guestBoard.waitForSocketConnected();
    await secondBoard.gotoBoard("names");
    await secondBoard.waitForSocketConnected();
    const differentBoard = createBoardPage(otherBoard, server);
    await differentBoard.gotoBoard("other", {
      query: { name: "Other board name" },
    });
    await differentBoard.waitForSocketConnected();
    const guestId = await guest.evaluate(
      () => window.WBOApp.connection.socket?.id || "",
    );
    const stableId = await guest.evaluate(
      () =>
        window.WBOApp.presence.users.get(
          window.WBOApp.connection.socket?.id || "",
        )?.userId,
    );
    await boardPage.connectedUsersToggle.click();
    const row = page.locator(
      `.connected-user-row[data-socket-id="${guestId}"]`,
    );
    await row.hover();
    await row.locator(".connected-user-rename").click();
    await saveName(page, "主持人指定");
    await expect.poll(() => ownName(guest)).toBe("主持人指定");
    await expect.poll(() => ownName(secondTab)).toBe("主持人指定");
    expect(await ownName(otherBoard)).toBe("Other board name");
    expect(
      await guest.evaluate(
        () =>
          window.WBOApp.presence.users.get(
            window.WBOApp.connection.socket?.id || "",
          )?.userId,
      ),
    ).toBe(stableId);
    await guest.reload();
    await guestBoard.waitForSocketConnected();
    expect(await ownName(guest)).toBe("主持人指定");
    await guestBoard.connectedUsersToggle.click();
    const self = guest.locator(".connected-user-row-self");
    await self.hover();
    await self.locator(".connected-user-rename").click();
    await saveName(guest, "My own name");
    await expect.poll(() => ownName(secondTab)).toBe("My own name");

    const hostId = await page.evaluate(
      () => window.WBOApp.connection.socket?.id || "",
    );
    const result = await guest.evaluate(
      (socketId) =>
        new Promise((resolve) => {
          window.WBOApp.connection.socket?.emit(
            "set_user_name",
            { socketId, name: "Spoof" },
            resolve,
          );
        }),
      hostId,
    );
    expect(result).toEqual({ ok: false, error: "user_name_forbidden" });
    expect(await ownName(page)).toBe("Host");
    await expect(
      guest.locator(
        `.connected-user-row[data-socket-id="${hostId}"] .connected-user-rename`,
      ),
    ).toBeHidden();
  } finally {
    await guestContext.close();
  }
});

test("name validation is visible and HTML-like names remain plain text", async ({
  page,
  boardPage,
}) => {
  await boardPage.gotoBoard("names", { chooseDefaultName: false });
  await boardPage.waitForSocketConnected(false);
  await page.locator("#user-name-input").fill("   ");
  await page.locator(".user-name-dialog button[type=submit]").click();
  await expect(page.locator("#user-name-error")).toContainText("1–64");
  const name = '<img src=x onerror="window.nameInjected=true">';
  await saveName(page, name);
  await boardPage.connectedUsersToggle.click();
  await expect(
    page.locator(".connected-user-row-self .connected-user-name-text"),
  ).toContainText(name);
  expect(await page.evaluate(() => "nameInjected" in window)).toBe(false);
  await expect(page.locator(".connected-user-name-text img")).toHaveCount(0);
});
