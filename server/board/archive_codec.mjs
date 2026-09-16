// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-16: configuration-free archive encoding shared by history.
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { validateChunkSettings } from "../../client-data/js/board_chunks.js";
import { badRequest, BoundaryError } from "../http/boundary_errors.mjs";
import { parseStoredSvgItem } from "../persistence/stored_svg_item_codec.mjs";
import { streamStoredSvgStructure } from "../persistence/streaming_stored_svg_scan.mjs";
import { readRawAttribute } from "../persistence/svg_envelope.mjs";
export const ARCHIVE_FORMAT = "whitebophir-board";
const compress = promisify(gzip);
export const ARCHIVE_ITEM_FIELDS = new Set([
  "id",
  "tool",
  "color",
  "size",
  "opacity",
  "x",
  "y",
  "x2",
  "y2",
  "txt",
  "transform",
  "_children",
]);
/** @typedef {Record<string, any>} ArchiveItem */
/** @typedef {Pick<import("../../types/server-runtime.d.ts").ServerConfig, "MAX_ARCHIVE_BYTES" | "MAX_ARCHIVE_JSON_BYTES">} ArchiveLimits */
/** @typedef {import("../../client-data/js/board_chunks.js").ChunkSettings} ChunkSettings */
/** @typedef {import("../../client-data/js/board_theme.js").BoardTheme} BoardTheme */

/** @param {string} svg @returns {Promise<ArchiveItem[]>} */
export async function itemsFromSvg(svg) {
  const items = [];
  for await (const event of streamStoredSvgStructure(Readable.from([svg]))) {
    if (event.type !== "item") continue;
    const item = parseStoredSvgItem(event.entry);
    if (!item) throw badRequest("unsupported_archive_item");
    if (item.tool === "pencil") {
      // The stored codec deliberately only summarizes Pencil. Materialize its
      // canonical relative path here, solely for an explicit native export.
      const path = readRawAttribute(event.entry.rawAttributes, "d");
      if (typeof path !== "string") throw badRequest("invalid_archive_path");
      let x = 0;
      let y = 0;
      item._children = [];
      for (const match of path.matchAll(/([Ml]) (-?\d+) (-?\d+)/g)) {
        x = match[1] === "M" ? Number(match[2]) : x + Number(match[2]);
        y = match[1] === "M" ? Number(match[3]) : y + Number(match[3]);
        const last = item._children.at(-1);
        if (!last || last.x !== x || last.y !== y)
          item._children.push({ x, y });
      }
    }
    items.push(item);
  }
  return items;
}

/** @typedef {{board: string, atMs: number, seq: number, point: {x: number, y: number}, emptyPencils: ArchiveItem[]}} ReplayBaseline */
/** @param {ArchiveItem[]} items @param {ArchiveLimits} limits @param {ChunkSettings} [chunks] @param {BoardTheme} [theme] @param {ReplayBaseline} [replay] @returns {Promise<Buffer>} */
export async function encodeArchive(items, limits, chunks, theme, replay) {
  const json = Buffer.from(
    JSON.stringify({
      format: ARCHIVE_FORMAT,
      version: 1,
      items,
      // Export board settings without the source board's revision or activity.
      ...(chunks && { chunks: validateChunkSettings(chunks) }),
      ...(theme && { theme }),
      // Optional replay context does not affect native import or permissions.
      ...(replay && { replay }),
    }),
  );
  if (json.length > limits.MAX_ARCHIVE_JSON_BYTES)
    throw new BoundaryError(413, "archive_too_large");
  const data = await compress(json);
  if (data.length > limits.MAX_ARCHIVE_BYTES)
    throw new BoundaryError(413, "archive_too_large");
  return data;
}
