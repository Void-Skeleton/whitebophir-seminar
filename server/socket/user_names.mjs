// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-15: authorized, board-scoped display-name changes.
import { normalizeUserName } from "../../client-data/js/user_name.js";
import { consumeFixedWindowRateLimit } from "../../client-data/js/rate_limit_common.js";
import { canBanOnBoard } from "./policy.mjs";
import {
  getBoardUser,
  getBoardUserMap,
  emitUserUpdatedToBoard,
} from "./presence.mjs";

/** @import { AppSocket, ServerConfig } from "../../types/server-runtime.d.ts" */
/** @type {WeakMap<AppSocket, {windowStart: number, count: number, lastSeen: number}>} */
const limits = new WeakMap();

/**
 * @param {AppSocket} socket
 * @param {string} boardName
 * @param {unknown} message
 * @param {ServerConfig} config
 * @param {number} [now]
 * @returns {import("../../types/app-runtime.d.ts").UserNameAck}
 */
export function setUserName(
  socket,
  boardName,
  message,
  config,
  now = Date.now(),
) {
  const rate = consumeFixedWindowRateLimit(limits.get(socket), 1, 10000, now);
  limits.set(socket, rate);
  if (rate.count > 10) return { ok: false, error: "user_name_rate_limited" };
  if (!message || typeof message !== "object" || Array.isArray(message))
    return { ok: false, error: "user_name_invalid" };
  const payload = /** @type {{name?: unknown, socketId?: unknown}} */ (message);
  const name = normalizeUserName(payload.name);
  if (
    !name ||
    (payload.socketId !== undefined &&
      (typeof payload.socketId !== "string" ||
        !payload.socketId ||
        payload.socketId.length > 128))
  )
    return { ok: false, error: "user_name_invalid" };
  const targetId =
    typeof payload.socketId === "string" ? payload.socketId : socket.id;
  const actor = getBoardUser(boardName, socket.id);
  const target = getBoardUser(boardName, targetId);
  if (!socket.rooms.has(boardName) || !actor || !target)
    return { ok: false, error: "user_name_unavailable" };
  const ownIdentity =
    targetId === socket.id ||
    (!!actor.userSecret && actor.userSecret === target.userSecret);
  if (!ownIdentity && !canBanOnBoard(config, boardName, socket))
    return { ok: false, error: "user_name_forbidden" };
  for (const user of getBoardUserMap(boardName).values()) {
    if (
      user.socketId !== targetId &&
      (!target.userSecret || user.userSecret !== target.userSecret)
    )
      continue;
    user.name = name;
    user.nameChosen = true;
    emitUserUpdatedToBoard(socket, boardName, user);
  }
  return { ok: true, name };
}
