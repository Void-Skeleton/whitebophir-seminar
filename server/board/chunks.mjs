// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-15: accepted activity from canonical summaries.
import MessageCommon from "../../client-data/js/message_common.js";
import {
  DEFAULT_CHUNKS,
  validateChunkState,
} from "../../client-data/js/board_chunks.js";
import { MutationType } from "../../client-data/js/mutation_type.js";

/** @param {import("./data.mjs").BoardData} board */
export function chunkState(board) {
  return (
    board.metadata.chunks || { ...DEFAULT_CHUNKS, point: board.activityPoint }
  );
}

/** @param {string | undefined} raw */
export function parseStoredChunks(raw) {
  if (raw === undefined) return undefined;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Invalid stored chunk settings");
  }
  // Read boards saved before view modes replaced follow/locked. Locks no longer
  // affect the camera; the old follow choice becomes a freely changeable mode.
  if (
    value &&
    value.viewMode === undefined &&
    typeof value.follow === "boolean" &&
    typeof value.locked === "boolean"
  ) {
    value = { ...value, viewMode: value.follow ? "latest" : "free" };
  }
  const state = validateChunkState(value);
  if (!state) throw new Error("Invalid stored chunk settings");
  return state;
}

/**
 * Look only at the last spatial mutation and cached canonical bounds. Deleted
 * items remain tombstones until save; no SVG reads or pencil hydration occur.
 * @param {import("./data.mjs").BoardData} board
 * @param {import("../../types/app-runtime.d.ts").BoardMessage | import("../../types/app-runtime.d.ts").ToolOwnedChildMessage} message
 * @returns {import("../../client-data/js/board_chunks.js").ActivityPoint | null}
 */
export function mutationActivityPoint(board, message) {
  if ("_children" in message && Array.isArray(message._children)) {
    for (let i = message._children.length - 1; i >= 0; i--) {
      const child = message._children[i];
      if (!child) continue;
      const point = mutationActivityPoint(board, child);
      if (point) return point;
    }
    return null;
  }
  if (!("type" in message)) return null;
  if (message.type === MutationType.RESTORE) {
    for (const entry of message.items.slice().reverse()) {
      const point = mutationActivityPoint(board, {
        tool: 6,
        type: MutationType.DELETE,
        id: entry.id,
      });
      if (point) return point;
    }
    return null;
  }
  if (message.type === MutationType.CLEAR) return { x: 0, y: 0 };
  const id =
    "newid" in message
      ? message.newid
      : "parent" in message
        ? message.parent
        : "id" in message
          ? message.id
          : undefined;
  const item = typeof id === "string" ? board.itemsById.get(id) : undefined;
  if (!item) return null;
  const bounds = MessageCommon.applyTransformToBounds(
    item.bounds,
    item.transform,
  );
  if (!bounds) return null;
  if (
    message.type === MutationType.APPEND &&
    "x" in message &&
    "y" in message
  ) {
    const pointBounds = MessageCommon.applyTransformToBounds(
      { minX: message.x, minY: message.y, maxX: message.x, maxY: message.y },
      item.transform,
    );
    if (pointBounds)
      return {
        x: Math.max(0, pointBounds.maxX),
        y: Math.max(0, pointBounds.maxY),
      };
  }
  return {
    x: Math.max(0, (bounds.minX + bounds.maxX) / 2),
    y: Math.max(0, (bounds.minY + bounds.maxY) / 2),
  };
}
