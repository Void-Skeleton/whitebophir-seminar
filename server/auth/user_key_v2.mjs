// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-15: one-use Ed25519 authentication proofs.
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { forbidden, BoundaryError } from "../http/boundary_errors.mjs";
import { parseCookieHeader } from "./user_secret_cookie.mjs";

/** @import { ServerConfig, HttpRouteContext, HttpRequest } from "../../types/server-runtime.d.ts" */
/** @typedef {{board: string, scope: string, publicKey: string, bodyHash: string, audience: string}} ChallengeInput */
/** @typedef {ChallengeInput & {challenge: string, expiresAt: number, ip: string}} Challenge */
export const PUBLIC_KEY_COOKIE = "wbo-user-secret-v2-public";
export const AUTH_V2_HEADER = "x-wbo-auth-v2";
export const AUTH_V2_QUERY = "authV2";
const PUBLIC_KEY_PATTERN = /^[0-9a-f]{64}$/i;
const PROOF_PATTERN = /^([0-9a-f]{64})\.([0-9a-f]{128})$/;
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const MAX_CHALLENGES = 4096;
const MAX_CHALLENGES_PER_IP = 32;
const CHALLENGE_TTL_MS = 60000;
/** @type {WeakMap<object, Map<string, Challenge>>} */
const stores = new WeakMap();
/** @type {WeakMap<HttpRequest, Challenge>} */
const httpIdentities = new WeakMap();

/** @param {unknown} value */
export function normalizePublicKey(value) {
  return typeof value === "string" && PUBLIC_KEY_PATTERN.test(value)
    ? value.toLowerCase()
    : "";
}

/** @param {string | string[] | undefined} header */
export function getPublicKeyCookie(header) {
  return normalizePublicKey(parseCookieHeader(header)[PUBLIC_KEY_COOKIE]);
}

/** @param {object} config @param {ChallengeInput} input @param {string} ip @param {number} [now] */
export function issueChallenge(config, input, ip, now = Date.now()) {
  let store = stores.get(config);
  if (!store) {
    store = new Map();
    stores.set(config, store);
  }
  let pendingForIp = 0;
  for (const [id, entry] of store) {
    if (entry.expiresAt <= now) store.delete(id);
    else if (entry.ip === ip) pendingForIp++;
  }
  if (store.size >= MAX_CHALLENGES || pendingForIp >= MAX_CHALLENGES_PER_IP)
    throw new BoundaryError(429, "auth_v2_rate_limited");
  const id = randomBytes(32).toString("hex");
  const expiresAt = now + CHALLENGE_TTL_MS;
  const challenge = JSON.stringify([
    "wbo-auth-v2",
    input.audience,
    input.board,
    input.scope,
    input.publicKey,
    input.bodyHash,
    id,
    expiresAt,
  ]);
  store.set(id, { ...input, challenge, expiresAt, ip });
  return { challenge };
}

/** @param {object} config @param {unknown} proof @param {string} board @param {string} scope @param {number} [now] */
export function verifyProof(config, proof, board, scope, now = Date.now()) {
  const match =
    typeof proof === "string" && proof.length === 193
      ? PROOF_PATTERN.exec(proof)
      : null;
  if (!match) throw forbidden("auth_v2_failed");
  const id = match[1] || "";
  const store = stores.get(config);
  const entry = store?.get(id);
  // Consume before any verification: failed proofs cannot be retried or replayed.
  store?.delete(id);
  if (
    !entry ||
    entry.expiresAt <= now ||
    entry.board !== board ||
    entry.scope !== scope
  )
    throw forbidden("auth_v2_failed");
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(entry.publicKey, "hex")]),
      format: "der",
      type: "spki",
    });
    if (
      !verify(
        null,
        Buffer.from(entry.challenge),
        key,
        Buffer.from(match[2] || "", "hex"),
      )
    )
      throw forbidden("auth_v2_failed");
  } catch {
    throw forbidden("auth_v2_failed");
  }
  return entry;
}

/** @param {HttpRouteContext} ctx @param {string} board */
export function authenticateHttpV2(ctx, board) {
  const existing = httpIdentities.get(ctx.request);
  if (existing) return existing;
  const header = ctx.request.headers[AUTH_V2_HEADER];
  const query = ctx.url.searchParams.get(AUTH_V2_QUERY);
  if (header === undefined && query === null) return undefined;
  // Navigation proofs are only accepted for board HTML; fetches use a header.
  if (
    query !== null &&
    (ctx.request.method !== "GET" ||
      ctx.url.pathname !== `/boards/${ctx.params.board}`)
  )
    throw forbidden("auth_v2_failed");
  const identity = verifyProof(
    ctx.runtime.config,
    header ?? query,
    board,
    `${ctx.request.method}:${ctx.publicUrl.pathname}`,
  );
  httpIdentities.set(ctx.request, identity);
  ctx.response.setHeader("Cache-Control", "no-store");
  ctx.response.setHeader("Referrer-Policy", "no-referrer");
  return identity;
}

/** @param {HttpRequest} request */
export function hasHttpV2Identity(request) {
  return httpIdentities.has(request);
}
