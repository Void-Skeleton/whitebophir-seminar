// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-16: native archive API with chunk settings.
import MessageCommon from "../../client-data/js/message_common.js";
import { createHash } from "node:crypto";
import { authenticateHttpV2 } from "../auth/user_key_v2.mjs";
import {
  applyArchiveImport,
  decodeArchive,
  encodeArchive,
  itemsFromSvg,
  prepareArchiveImport,
} from "../board/archive.mjs";
import { getBoardSession } from "../board/session.mjs";
import { getUserSecretFromCookieHeader } from "../auth/user_secret_cookie.mjs";
import {
  badRequest,
  BoundaryError,
  forbidden,
} from "../http/boundary_errors.mjs";
import { readServedBaseline } from "../persistence/svg_board_store.mjs";
import {
  getBoard,
  getActiveSocket,
  emitArchiveMutations,
  emitChunkState,
} from "../socket/index.mjs";
import { resolveRequestClientIpSafe } from "../socket/policy.mjs";
import { getSocketUserSecret } from "../socket/request.mjs";
import { isTurnstileValidationActive } from "../socket/turnstile.mjs";
import {
  annotateBoardRequest,
  boardPermissionsForRequest,
  requireBoardPathName,
} from "./board_http_helpers.mjs";

/** @import { HttpRouteContext, ServerRuntime } from "../../types/server-runtime.d.ts" */
/** @type {WeakMap<ServerRuntime, Map<string, number>>} */
const importAttempts = new WeakMap();

/** @param {HttpRouteContext} ctx */
function limitImportAttempts(ctx) {
  let attempts = importAttempts.get(ctx.runtime);
  if (!attempts) {
    attempts = new Map();
    importAttempts.set(ctx.runtime, attempts);
  }
  const ip = resolveRequestClientIpSafe(ctx.runtime.config, ctx.request);
  const now = Date.now();
  if ((attempts.get(ip) || 0) > now) {
    ctx.response.setHeader("Retry-After", "10");
    throw new BoundaryError(429, "archive_rate_limited");
  }
  for (const [key, expiry] of attempts) {
    if (expiry <= now) attempts.delete(key);
  }
  if (attempts.size >= 4096)
    throw new BoundaryError(429, "archive_rate_limited");
  attempts.set(ip, now + 10000);
}

/** @param {HttpRouteContext} ctx @returns {Promise<Buffer>} */
async function readArchiveBody(ctx) {
  const maxBytes = ctx.runtime.config.MAX_ARCHIVE_BYTES;
  if (Number(ctx.request.headers["content-length"]) > maxBytes) {
    throw new BoundaryError(413, "archive_too_large");
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of ctx.request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > maxBytes) throw new BoundaryError(413, "archive_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

/** @param {HttpRouteContext} ctx @param {string} boardName @param {boolean} canClear */
function requireArchiveTurnstile(ctx, boardName, canClear) {
  if (
    !ctx.runtime.config.TURNSTILE_SECRET_KEY ||
    canClear ||
    !MessageCommon.requiresTurnstile(boardName, 1)
  )
    return;
  const socketId = ctx.request.headers["x-wbo-socket-id"];
  const socket =
    typeof socketId === "string" ? getActiveSocket(socketId) : undefined;
  const secret = getUserSecretFromCookieHeader(ctx.request.headers.cookie);
  if (
    !socket ||
    !socket.connected ||
    socket.boardName !== boardName ||
    !secret ||
    getSocketUserSecret(socket) !== secret ||
    !isTurnstileValidationActive(socket, Date.now())
  ) {
    throw forbidden("turnstile_validation_required");
  }
}

/** @param {HttpRouteContext} ctx */
async function handleArchive(ctx) {
  const boardName = requireBoardPathName(ctx.params);
  annotateBoardRequest(ctx.observed, boardName);
  const permissions = boardPermissionsForRequest(ctx, boardName);
  permissions.requireOpen();
  const method = ctx.request.method;
  if (method !== "GET" && method !== "POST") {
    ctx.response.setHeader("Allow", "GET, POST");
    throw new BoundaryError(405, "method_not_allowed");
  }
  if (method === "POST") {
    // A custom header plus a non-form content type makes browser cross-origin
    // submissions require a CORS preflight, which this endpoint does not allow.
    if (
      ctx.request.headers["x-wbo-archive"] !== "1" ||
      ctx.request.headers["content-type"] !== "application/gzip"
    ) {
      throw badRequest("invalid_archive_request");
    }
    if (
      !permissions.canBan() ||
      !permissions.resolveCapabilities({ name: boardName }).canEdit
    )
      throw forbidden("write_blocked");
    limitImportAttempts(ctx);
  }
  const board = await getBoard(boardName, ctx.runtime.config);
  const session = getBoardSession(board);
  if (method === "GET") {
    const snapshot = await session.runExclusive(async () => {
      const saved = await board.save();
      if (
        saved.status === "failed" ||
        saved.status === "stale" ||
        board.disposed
      ) {
        throw new BoundaryError(503, "archive_save_failed");
      }
      return {
        svg: await readServedBaseline(boardName, {
          historyDir: ctx.runtime.config.HISTORY_DIR,
        }),
        chunks: board.metadata.chunks,
      };
    });
    const data = await encodeArchive(
      await itemsFromSvg(snapshot.svg),
      ctx.runtime.config,
      snapshot.chunks,
    );
    ctx.response.writeHead(200, {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="board.wbo"; filename*=UTF-8''${encodeURIComponent(boardName)}.wbo`,
      "Content-Length": data.length,
    });
    ctx.response.end(data);
    return;
  }
  const checkAccess = () => {
    const capabilities = permissions.resolveCapabilities(board);
    if (!permissions.canBan() || !capabilities.canEdit || board.disposed)
      throw forbidden("write_blocked");
    requireArchiveTurnstile(ctx, boardName, capabilities.canClear);
  };
  checkAccess();
  const body = await readArchiveBody(ctx);
  const v2 = authenticateHttpV2(ctx, boardName);
  if (v2 && createHash("sha512").update(body).digest("hex") !== v2.bodyHash)
    throw forbidden("auth_v2_failed");
  const prepared = prepareArchiveImport(
    await decodeArchive(body, ctx.runtime.config),
    ctx.runtime.config,
  );
  const seq = await session.runExclusive(() => {
    checkAccess();
    const entries = applyArchiveImport(board, prepared);
    emitArchiveMutations(board, entries);
    if (prepared.chunks) emitChunkState(board);
    return board.getSeq();
  });
  ctx.response.writeHead(200, { "Content-Type": "application/json" });
  ctx.response.end(JSON.stringify({ imported: prepared.items.length, seq }));
}

/** @param {HttpRouteContext} ctx */
export async function boardArchive(ctx) {
  ctx.response.setHeader("Cache-Control", "no-store");
  ctx.response.setHeader("X-Content-Type-Options", "nosniff");
  try {
    await handleArchive(ctx);
  } catch (error) {
    ctx.request.resume();
    if (!(error instanceof BoundaryError)) throw error;
    ctx.response.writeHead(error.statusCode, {
      "Content-Type": "application/json",
    });
    ctx.response.end(JSON.stringify({ error: error.reason }));
  }
}
