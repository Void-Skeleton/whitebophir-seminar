// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-15: bounded Ed25519 challenge endpoint.
import { isValidBoardName } from "../../client-data/js/board_name.js";
import { issueChallenge, normalizePublicKey } from "../auth/user_key_v2.mjs";
import { badRequest, BoundaryError } from "../http/boundary_errors.mjs";
import { requestAuthority, requestScheme } from "../http/observation.mjs";
import { resolveRequestClientIpSafe } from "../socket/policy.mjs";

/** @param {import("../../types/server-runtime.d.ts").HttpRouteContext} ctx */
export async function authV2Challenge(ctx) {
  ctx.response.setHeader("Cache-Control", "no-store");
  ctx.response.setHeader("Content-Type", "application/json");
  ctx.response.setHeader("X-Content-Type-Options", "nosniff");
  try {
    if (ctx.request.method !== "POST") {
      ctx.response.setHeader("Allow", "POST");
      throw new BoundaryError(405, "method_not_allowed");
    }
    if (ctx.request.headers["content-type"] !== "application/json")
      throw badRequest("invalid_auth_v2_request");
    let size = 0;
    const chunks = [];
    for await (const chunk of ctx.request.iterator({
      destroyOnReturn: false,
    })) {
      size += chunk.length;
      if (size > 2048) throw new BoundaryError(413, "invalid_auth_v2_request");
      chunks.push(chunk);
    }
    let input;
    try {
      input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw badRequest("invalid_auth_v2_request");
    }
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw badRequest("invalid_auth_v2_request");
    const publicKey = normalizePublicKey(input.publicKey);
    const board = isValidBoardName(input.board) ? input.board : "";
    if (
      !publicKey ||
      !board ||
      board !== input.board ||
      typeof input.scope !== "string" ||
      input.scope.length > 512 ||
      !(
        input.scope === "socket" || /^(GET|POST):\/[^\s?#]*$/.test(input.scope)
      ) ||
      (input.scope.startsWith("POST:")
        ? typeof input.bodyHash !== "string" ||
          !/^[0-9a-f]{128}$/.test(input.bodyHash)
        : input.bodyHash !== "")
    )
      throw badRequest("invalid_auth_v2_request");
    const host = requestAuthority(ctx.request);
    if (!host) throw badRequest("invalid_auth_v2_request");
    const audience = `${requestScheme(ctx.request)}://${host}${ctx.runtime.config.BASE_PATH}`;
    const result = issueChallenge(
      ctx.runtime.config,
      {
        board,
        publicKey,
        scope: input.scope,
        bodyHash: input.bodyHash,
        audience,
      },
      resolveRequestClientIpSafe(ctx.runtime.config, ctx.request),
    );
    ctx.response.end(JSON.stringify(result));
  } catch (error) {
    ctx.request.resume();
    if (!(error instanceof BoundaryError)) throw error;
    if (error.statusCode === 429) ctx.response.setHeader("Retry-After", "60");
    ctx.response.statusCode = error.statusCode;
    ctx.response.end(JSON.stringify({ error: error.reason }));
  }
}
