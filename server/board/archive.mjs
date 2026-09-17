// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-16: compressed backups with chunk settings.
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import * as configuration from "../configuration.mjs";
import { badRequest, BoundaryError } from "../http/boundary_errors.mjs";

import { encodeArchive as encodeArchiveData } from "./archive_codec.mjs";
export {
  ARCHIVE_FORMAT,
  itemsFromSvg,
  prepareArchiveImport,
} from "./archive_codec.mjs";
const decompress = promisify(gunzip);

/** @import { ServerConfig } from "../../types/server-runtime.d.ts" */
/** @import { ChunkSettings } from "../../client-data/js/board_chunks.js" */
/** @import { BoardTheme } from "../../client-data/js/board_theme.js" */
/** @typedef {Record<string, any>} ArchiveItem */
/** @typedef {Pick<ServerConfig, "MAX_ARCHIVE_BYTES" | "MAX_ARCHIVE_JSON_BYTES">} ArchiveLimits */

/** @param {ArchiveItem[]} items @param {ArchiveLimits} [limits] @param {ChunkSettings} [chunks] @param {BoardTheme} [theme] */
export function encodeArchive(items, limits = configuration, chunks, theme) {
  return encodeArchiveData(items, limits, chunks, theme);
}

/** @param {Buffer} data @param {ArchiveLimits} [limits] @returns {Promise<unknown>} */
export async function decodeArchive(data, limits = configuration) {
  if (data.length > limits.MAX_ARCHIVE_BYTES)
    throw new BoundaryError(413, "archive_too_large");
  try {
    const json = await decompress(data, {
      maxOutputLength: limits.MAX_ARCHIVE_JSON_BYTES,
    });
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(json));
  } catch {
    throw badRequest("invalid_archive");
  }
}

/**
 * Called inside the board session queue. All candidates must validate before
 * any item is inserted. Complete Pencil payloads stay native stored items;
 * their separate live create/append messages are retained for replay.
 * @param {import("./data.mjs").BoardData} board
 * @param {ReturnType<typeof import("./archive_codec.mjs").prepareArchiveImport>} prepared
 */
export function applyArchiveImport(board, prepared) {
  if (
    board.authoritativeItemCount() + prepared.items.length >
    board.maxItemCount
  ) {
    throw new BoundaryError(409, "archive_board_full");
  }
  const now = Date.now();
  const candidates = prepared.items.map((item) => {
    if (board.itemsById.has(item.id))
      throw new BoundaryError(409, "archive_id_conflict");
    const result = board.validateStoredCandidate(item.id, {
      ...item,
      time: now,
    });
    if (!result.ok) throw badRequest("invalid_archive_item", result.reason);
    return result.canonical;
  });
  for (const candidate of candidates) {
    candidate.paintOrder = board.nextPaintOrder;
    board.upsertItem(candidate);
  }
  const entries = prepared.mutations.map((mutation) =>
    board.recordPersistentMutation(mutation, now),
  );
  if (prepared.chunks) {
    board.metadata = {
      ...board.metadata,
      chunks: {
        ...prepared.chunks,
        revision: randomUUID(),
        point: board.activityPoint,
      },
    };
  }
  if (prepared.theme)
    board.metadata = { ...board.metadata, theme: prepared.theme };
  if (candidates.length > 0 || prepared.chunks || prepared.theme)
    board.delaySave();
  return entries;
}
