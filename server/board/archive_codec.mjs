// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-16: configuration-free archive encoding shared by history.
import { randomBytes } from "node:crypto";
import { isBoardTheme } from "../../client-data/js/board_theme.js";
import MessageCommon from "../../client-data/js/message_common.js";
import { MutationType } from "../../client-data/js/mutation_type.js";
import { TOOL_BY_ID } from "../../client-data/tools/index.js";
import { normalizeIncomingMessage } from "../socket/message_validation.mjs";
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

/** @import { ServerConfig, NormalizedMessageData } from "../../types/server-runtime.d.ts" */
const MAX_ARCHIVE_MUTATIONS = 1000000;
/** @param {unknown} value @returns {value is ArchiveItem} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate the entire archive before touching the board. Storage candidates
 * contain complete payloads; live messages use the existing wire protocol.
 * @param {unknown} archive
 * @param {ServerConfig} config
 * @param {boolean} [preserveIds] Internal restoration of previously accepted items.
 * @returns {{items: ArchiveItem[], mutations: NormalizedMessageData[], chunks?: ChunkSettings, theme?: BoardTheme}}
 */
export function prepareArchiveImport(archive, config, preserveIds = false) {
  if (
    !isRecord(archive) ||
    archive.format !== ARCHIVE_FORMAT ||
    archive.version !== 1 ||
    !Array.isArray(archive.items) ||
    archive.items.length > config.MAX_ITEM_COUNT
  ) {
    throw badRequest("invalid_archive");
  }
  /** @type {ChunkSettings | undefined} */
  let chunks;
  if (
    Object.prototype.hasOwnProperty.call(archive, "theme") &&
    !isBoardTheme(archive.theme)
  )
    throw badRequest("invalid_archive_theme");
  if (Object.prototype.hasOwnProperty.call(archive, "chunks")) {
    const settings = validateChunkSettings(archive.chunks);
    if (
      !settings ||
      Object.keys(archive.chunks).some(
        (key) => !Object.prototype.hasOwnProperty.call(settings, key),
      )
    )
      throw badRequest("invalid_archive_chunks");
    chunks = settings;
  }
  const sourceIds = new Set();
  const items = [];
  /** @type {NormalizedMessageData[]} */
  const mutations = [];
  /** @param {ArchiveItem} raw */
  const normalize = (raw) => {
    const result = normalizeIncomingMessage(config, raw);
    if (!result.ok) throw badRequest("invalid_archive_item", result.reason);
    mutations.push(result.value);
    if (mutations.length > MAX_ARCHIVE_MUTATIONS)
      throw new BoundaryError(413, "archive_too_large");
    return result.value;
  };
  for (const raw of archive.items) {
    if (
      !isRecord(raw) ||
      Object.keys(raw).some((key) => !ARCHIVE_ITEM_FIELDS.has(key)) ||
      MessageCommon.normalizeId(raw.id) === null ||
      sourceIds.has(raw.id)
    ) {
      throw badRequest("invalid_archive_item");
    }
    sourceIds.add(raw.id);
    const contract =
      typeof raw.tool === "string" &&
      Object.prototype.hasOwnProperty.call(TOOL_BY_ID, raw.tool)
        ? TOOL_BY_ID[raw.tool]
        : undefined;
    if (!contract?.storedTagName || config.BLOCKED_TOOLS.includes(raw.tool)) {
      throw badRequest("unsupported_archive_tool");
    }
    const id = preserveIds
      ? raw.id
      : `${raw.id[0]}${randomBytes(12).toString("hex")}`;
    const create = normalize({
      ...raw,
      _children: undefined,
      transform: undefined,
      tool: contract.id,
      type: MutationType.CREATE,
      id,
    });
    /** @type {ArchiveItem} */
    const item = { ...create, tool: contract.toolId };
    delete item.type;
    if (contract.payloadKind === "children") {
      if (
        !Array.isArray(raw._children) ||
        (!preserveIds && raw._children.length === 0) ||
        raw._children.length > config.MAX_CHILDREN
      ) {
        throw badRequest("invalid_archive_points");
      }
      item._children = raw._children.map((point) => {
        if (
          !isRecord(point) ||
          Object.keys(point).some((key) => key !== "x" && key !== "y")
        ) {
          throw badRequest("invalid_archive_point");
        }
        const normalizedPoint = normalize({
          tool: contract.id,
          type: MutationType.APPEND,
          parent: id,
          x: point.x,
          y: point.y,
        });
        if (!("x" in normalizedPoint) || !("y" in normalizedPoint))
          throw badRequest("invalid_archive_point");
        return { x: normalizedPoint.x, y: normalizedPoint.y };
      });
    } else if (Object.prototype.hasOwnProperty.call(raw, "_children")) {
      throw badRequest("invalid_archive_points");
    }
    if (contract.payloadKind === "text") {
      normalize({
        tool: contract.id,
        type: MutationType.UPDATE,
        id,
        txt: raw.txt,
      });
      item.txt = raw.txt;
    } else if (Object.prototype.hasOwnProperty.call(raw, "txt")) {
      throw badRequest("invalid_archive_text");
    }
    if (Object.prototype.hasOwnProperty.call(raw, "transform")) {
      if (config.BLOCKED_TOOLS.includes("hand"))
        throw badRequest("unsupported_archive_tool");
      const transformed = normalize({
        tool: TOOL_BY_ID.hand.id,
        _children: [
          { type: MutationType.UPDATE, id, transform: raw.transform },
        ],
      });
      const child =
        "_children" in transformed ? transformed._children[0] : undefined;
      if (child && "transform" in child) {
        item.transform = child.transform;
      }
    }
    items.push(item);
  }
  return {
    items,
    mutations,
    ...(chunks && { chunks }),
    ...(archive.theme && { theme: archive.theme }),
  };
}
