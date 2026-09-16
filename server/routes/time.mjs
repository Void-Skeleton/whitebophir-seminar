// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-16: clock sampling without board access.
/** @param {import("../../types/server-runtime.d.ts").HttpRouteContext} ctx */
export function serverTime(ctx) {
  const { request, response, url } = ctx;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (request.method !== "GET") {
    response.statusCode = 405;
    response.setHeader("Allow", "GET");
    response.end(JSON.stringify({ error: "method_not_allowed" }));
  } else if (
    [...url.searchParams.keys()].some((key) => key !== "nonce") ||
    url.searchParams.getAll("nonce").length > 1 ||
    (url.searchParams.has("nonce") &&
      !/^[a-zA-Z0-9-]{1,64}$/.test(url.searchParams.get("nonce") || ""))
  ) {
    response.statusCode = 400;
    response.end(JSON.stringify({ error: "invalid_clock_request" }));
  } else response.end(JSON.stringify({ now: Date.now() }));
}
