// SPDX-License-Identifier: AGPL-3.0-or-later
import MessageCommon from "../../client-data/js/message_common.js";
import { MutationType } from "../../client-data/js/mutation_type.js";
import { prepareArchiveImport, ARCHIVE_FORMAT } from "./archive_codec.mjs";
import { removeCanonicalItem } from "./canonical_index.mjs";

export const MAX_RESTORE_ITEMS = 1000;
export const MAX_RESTORE_BYTES = 8 * 1024 * 1024;

/** Validate server-generated history too: downloaded logs are untrusted inputs.
 * @param {any} raw @param {import("../../types/server-runtime.d.ts").ServerConfig} config
 * @returns {import("../../types/app-runtime").RestoreMessage}
 */
export function validateRestore(raw, config) {
  if (
    !raw ||
    raw.tool !== 7 ||
    raw.type !== MutationType.RESTORE ||
    !Array.isArray(raw.items) ||
    raw.items.length > MAX_RESTORE_ITEMS ||
    Buffer.byteLength(JSON.stringify(raw)) > MAX_RESTORE_BYTES
  )
    throw new Error("Invalid restored items");
  const ids = new Set();
  for (const entry of raw.items) {
    if (
      !entry ||
      MessageCommon.normalizeId(entry.id) === null ||
      ids.has(entry.id) ||
      !Number.isSafeInteger(entry.order) ||
      entry.order < 0 ||
      (entry.item !== null && (!entry.item || entry.item.id !== entry.id))
    )
      throw new Error("Invalid restored item");
    ids.add(entry.id);
  }
  const prepared = prepareArchiveImport(
    {
      format: ARCHIVE_FORMAT,
      version: 1,
      items: raw.items
        .filter((/** @type {any} */ entry) => entry.item !== null)
        .map((/** @type {any} */ entry) => entry.item),
    },
    config,
    true,
  );
  const items = new Map(prepared.items.map((item) => [item.id, item]));
  return {
    tool: 7,
    type: MutationType.RESTORE,
    items: raw.items.map((/** @type {any} */ entry) => ({
      id: entry.id,
      order: entry.order,
      item: items.get(entry.id) || null,
      beforeId: typeof entry.beforeId === "string" ? entry.beforeId : null,
    })),
  };
}

/** Caller owns the session queue. Validate everything before changing any item.
 * @param {import("./data.mjs").BoardData} board
 * @param {import("../../types/app-runtime").RestoreMessage} message
 * @returns {{ok:true}|{ok:false,reason:string}}
 */
export function applyRestore(board, message) {
  const candidates = [];
  let count = board.authoritativeItemCount();
  for (const entry of message.items) {
    if (board.itemsById.get(entry.id)?.deleted === false) count--;
    if (entry.item) {
      const candidate = board.validateStoredCandidate(entry.id, entry.item);
      if (!candidate.ok) return candidate;
      candidate.canonical.paintOrder = entry.order;
      candidates.push(candidate.canonical);
      count++;
    }
  }
  if (count > board.maxItemCount) return { ok: false, reason: "board full" };
  for (const entry of message.items) removeCanonicalItem(board, entry.id);
  for (const candidate of candidates) board.upsertItem(candidate);
  board.paintOrder.sort(
    (a, b) =>
      (board.itemsById.get(a)?.paintOrder || 0) -
      (board.itemsById.get(b)?.paintOrder || 0),
  );
  board.trimPaintOrderIndex = 0;
  board.delaySave();
  return { ok: true };
}
