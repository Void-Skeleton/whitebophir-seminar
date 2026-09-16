// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-16: moderator historical snapshots and log exports.
import { downloadHistory, historicalSnapshot } from "../board/history.mjs";
import { getBoardSession } from "../board/session.mjs";
import {
  badRequest,
  BoundaryError,
  forbidden,
} from "../http/boundary_errors.mjs";
import { getBoard } from "../socket/index.mjs";
import {
  boardPermissionsForRequest,
  requireBoardPathName,
} from "./board_http_helpers.mjs";

/** @type {WeakMap<object, number>} */
const activeExports = new WeakMap();
/** @param {URLSearchParams} query @param {string} key */
function timestamp(query, key) {
  const value = query.get(key);
  if (
    query.getAll(key).length !== 1 ||
    value === null ||
    !/^(0|[1-9]\d{0,15})$/.test(value)
  )
    throw badRequest("invalid_history_time");
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result > 8640000000000000)
    throw badRequest("invalid_history_time");
  return result;
}

/** @param {import("../../types/server-runtime.d.ts").HttpRouteContext} ctx */
export async function boardHistory(ctx) {
  ctx.response.setHeader("Cache-Control", "no-store");
  ctx.response.setHeader("X-Content-Type-Options", "nosniff");
  let exporting = false;
  try {
    const name = requireBoardPathName(ctx.params);
    const permissions = boardPermissionsForRequest(ctx, name);
    permissions.requireOpen();
    if (!permissions.canBan()) throw forbidden("history_forbidden");
    if (ctx.request.method !== "GET") {
      ctx.response.setHeader("Allow", "GET");
      throw new BoundaryError(405, "method_not_allowed");
    }
    const query = ctx.url.searchParams;
    for (const key of query.keys())
      if (!["at", "from", "to", "token"].includes(key))
        throw badRequest("invalid_history_time");
    const snapshot = query.has("at");
    const ranged = query.has("from") || query.has("to");
    if (snapshot && ranged) throw badRequest("invalid_history_time");
    const at = snapshot ? timestamp(query, "at") : null;
    const from = ranged ? timestamp(query, "from") : null;
    const to = ranged ? timestamp(query, "to") : null;
    const board = await getBoard(name, ctx.runtime.config);
    const captured = await getBoardSession(board).runExclusive(async () => {
      if (!permissions.canBan() || board.disposed)
        throw forbidden("history_forbidden");
      const history = board.history;
      if (!history) throw new BoundaryError(503, "history_unavailable");
      await history.pending;
      return {
        history,
        limit: history.offset,
        availableFrom: history.startedAtMs,
        now: history.timestamp(),
      };
    });
    if (!snapshot && !ranged) {
      ctx.response.setHeader("Content-Type", "application/json");
      ctx.response.end(
        JSON.stringify({
          availableFrom: captured.availableFrom,
          now: captured.now,
        }),
      );
      return;
    }
    const start = at ?? from ?? 0;
    const end = at ?? to ?? 0;
    if (start > end || end > captured.now)
      throw badRequest("invalid_history_time");
    if (start < captured.availableFrom)
      throw new BoundaryError(416, "history_before_start");
    if ((activeExports.get(ctx.runtime) || 0) >= 2)
      throw new BoundaryError(429, "history_busy");
    activeExports.set(ctx.runtime, (activeExports.get(ctx.runtime) || 0) + 1);
    exporting = true;
    const data = snapshot
      ? await historicalSnapshot(
          captured.history,
          start,
          captured.limit,
          ctx.runtime.config,
        )
      : null;
    if (!permissions.canBan()) throw forbidden("history_forbidden");
    const filename = `${name}-${start}${snapshot ? ".wbo" : `-${end}.jsonl.gz`}`;
    ctx.response.setHeader("Content-Type", "application/gzip");
    ctx.response.setHeader(
      "Content-Disposition",
      `attachment; filename="history${snapshot ? ".wbo" : ".jsonl.gz"}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    if (data) {
      ctx.response.setHeader("Content-Length", data.length);
      ctx.response.end(data);
    } else
      await downloadHistory(
        captured.history,
        start,
        end,
        captured.limit,
        ctx.response,
      );
  } catch (error) {
    if (ctx.response.headersSent) {
      ctx.response.destroy();
      return;
    }
    if (!(error instanceof BoundaryError)) throw error;
    ctx.response.statusCode = error.statusCode;
    ctx.response.setHeader("Content-Type", "application/json");
    ctx.response.end(JSON.stringify({ error: error.reason }));
  } finally {
    if (exporting)
      activeExports.set(ctx.runtime, (activeExports.get(ctx.runtime) || 1) - 1);
  }
}
