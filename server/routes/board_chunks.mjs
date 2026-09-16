// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-15: board-scoped presentation settings API.
import { createHash, randomUUID } from "node:crypto";
import { validateChunkSettings } from "../../client-data/js/board_chunks.js";
import { isBoardTheme } from "../../client-data/js/board_theme.js";
import { authenticateHttpV2 } from "../auth/user_key_v2.mjs";
import { chunkState } from "../board/chunks.mjs";
import { getBoardSession } from "../board/session.mjs";
import {
  BoundaryError,
  badRequest,
  forbidden,
} from "../http/boundary_errors.mjs";
import { getBoard, emitChunkState, emitThemeState } from "../socket/index.mjs";
import {
  boardPermissionsForRequest,
  requireBoardPathName,
} from "./board_http_helpers.mjs";

/** @type {WeakMap<import("../board/data.mjs").BoardData, {start:number,count:number}>} */
const nextUpdate = new WeakMap();

/** @param {import("../../types/server-runtime.d.ts").HttpRouteContext} ctx @param {boolean} [theme] */
export async function boardChunks(ctx, theme = false) {
  const invalid = theme ? "invalid_board_theme" : "invalid_chunk_settings";
  ctx.response.setHeader("Cache-Control", "no-store");
  ctx.response.setHeader("Content-Type", "application/json");
  ctx.response.setHeader("X-Content-Type-Options", "nosniff");
  try {
    const name = requireBoardPathName(ctx.params);
    const permissions = boardPermissionsForRequest(ctx, name);
    permissions.requireOpen();
    if (ctx.request.method !== "GET" && ctx.request.method !== "POST") {
      ctx.response.setHeader("Allow", "GET, POST");
      throw new BoundaryError(405, "method_not_allowed");
    }
    if (ctx.request.method === "POST" && !permissions.canBan())
      throw forbidden("write_blocked");
    const board = await getBoard(name, ctx.runtime.config);
    if (ctx.request.method === "POST") {
      if (
        ctx.request.headers[theme ? "x-wbo-theme" : "x-wbo-chunks"] !== "1" ||
        ctx.request.headers["content-type"] !== "application/json"
      )
        throw badRequest(invalid);
      if (Number(ctx.request.headers["content-length"]) > 2048)
        throw new BoundaryError(413, invalid);
      const parts = [];
      let size = 0;
      for await (const part of ctx.request.iterator({
        destroyOnReturn: false,
      })) {
        size += part.length;
        if (size > 2048) throw new BoundaryError(413, invalid);
        parts.push(part);
      }
      const body = Buffer.concat(parts);
      const v2 = authenticateHttpV2(ctx, name);
      if (v2 && createHash("sha512").update(body).digest("hex") !== v2.bodyHash)
        throw forbidden("auth_v2_failed");
      let input;
      try {
        input = JSON.parse(body.toString("utf8"));
      } catch {
        throw badRequest(invalid);
      }
      const settings = theme ? null : validateChunkSettings(input);
      if (
        theme
          ? !input ||
            Array.isArray(input) ||
            !isBoardTheme(input.theme) ||
            Object.keys(input).length !== 1
          : !settings ||
            Object.keys(input).some(
              (key) => !Object.prototype.hasOwnProperty.call(settings, key),
            )
      )
        throw badRequest(invalid);
      await getBoardSession(board).runExclusive(async () => {
        if (!permissions.canBan() || board.disposed)
          throw forbidden("write_blocked");
        const now = Date.now();
        const window = nextUpdate.get(board);
        if (window && now - window.start < 10000 && window.count >= 10)
          throw new BoundaryError(
            429,
            theme ? "board_theme_rate_limited" : "chunk_settings_rate_limited",
          );
        nextUpdate.set(board, {
          start: window && now - window.start < 10000 ? window.start : now,
          count: window && now - window.start < 10000 ? window.count + 1 : 1,
        });
        const previous = board.metadata;
        if (theme) board.metadata = { ...previous, theme: input.theme };
        else if (settings)
          board.metadata = {
            ...previous,
            chunks: {
              ...settings,
              revision: randomUUID(),
              point: board.activityPoint,
            },
          };
        await board.history?.commit([], "", board.metadata);
        board.delaySave();
        const saved = await board.save();
        if (saved.status !== "saved") {
          // The settings are already durable in history; retry the SVG save.
          if (!board.history) board.metadata = previous;
          throw new BoundaryError(
            503,
            theme ? "board_theme_save_failed" : "chunk_settings_save_failed",
          );
        }
        if (theme) emitThemeState(board);
        else emitChunkState(board);
      });
    }
    ctx.response.end(
      JSON.stringify(
        theme ? { theme: board.metadata.theme || "light" } : chunkState(board),
      ),
    );
  } catch (error) {
    ctx.request.resume();
    if (!(error instanceof BoundaryError)) throw error;
    ctx.response.statusCode = error.statusCode;
    ctx.response.end(JSON.stringify({ error: error.reason }));
  }
}

/** @param {import("../../types/server-runtime.d.ts").HttpRouteContext} ctx */
export function boardTheme(ctx) {
  return boardChunks(ctx, true);
}
