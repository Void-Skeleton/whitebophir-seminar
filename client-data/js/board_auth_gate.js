// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-15: prove ownership before loading private boards.
import { createProof } from "./board_auth_v2.js";

async function openAuthenticatedBoard() {
  try {
    const url = new URL(window.location.href);
    const board = decodeURIComponent(url.pathname.split("/boards/")[1] || "");
    const proof = await createProof(board, `GET:${url.pathname}`);
    url.searchParams.set("authV2", proof);
    window.location.replace(url);
  } catch {
    document.getElementById("auth-v2-loading")?.setAttribute("hidden", "");
    document.getElementById("auth-v2-error")?.removeAttribute("hidden");
  }
}

void openAuthenticatedBoard();
