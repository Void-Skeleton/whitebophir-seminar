// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-14: compressed native board backups.
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import MessageCommon from "../../client-data/js/message_common.js";
import { MutationType } from "../../client-data/js/mutation_type.js";
import { TOOL_BY_ID } from "../../client-data/tools/index.js";
import * as configuration from "../configuration.mjs";
import { badRequest, BoundaryError } from "../http/boundary_errors.mjs";
import { parseStoredSvgItem } from "../persistence/stored_svg_item_codec.mjs";
import { streamStoredSvgStructure } from "../persistence/streaming_stored_svg_scan.mjs";
import { readRawAttribute } from "../persistence/svg_envelope.mjs";
import { normalizeIncomingMessage } from "../socket/message_validation.mjs";

export const ARCHIVE_FORMAT = "whitebophir-board";
const MAX_ARCHIVE_MUTATIONS = 1000000;
const compress = promisify(gzip);
const decompress = promisify(gunzip);
const ITEM_FIELDS = new Set([
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

/** @import { ServerConfig, NormalizedMessageData } from "../../types/server-runtime.d.ts" */
/** @typedef {Record<string, any>} ArchiveItem */
/** @typedef {Pick<ServerConfig, "MAX_ARCHIVE_BYTES" | "MAX_ARCHIVE_JSON_BYTES">} ArchiveLimits */

/** @param {unknown} value @returns {value is ArchiveItem} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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

/** @param {ArchiveItem[]} items @param {ArchiveLimits} [limits] @returns {Promise<Buffer>} */
export async function encodeArchive(items, limits = configuration) {
  const json = Buffer.from(
    JSON.stringify({ format: ARCHIVE_FORMAT, version: 1, items }),
  );
  if (json.length > limits.MAX_ARCHIVE_JSON_BYTES)
    throw new BoundaryError(413, "archive_too_large");
  const data = await compress(json);
  if (data.length > limits.MAX_ARCHIVE_BYTES)
    throw new BoundaryError(413, "archive_too_large");
  return data;
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
 * Validate the entire archive before touching the board. Storage candidates
 * contain complete payloads; live messages use the existing wire protocol.
 * @param {unknown} archive
 * @param {ServerConfig} config
 * @returns {{items: ArchiveItem[], mutations: NormalizedMessageData[]}}
 */
export function prepareArchiveImport(archive, config) {
  if (
    !isRecord(archive) ||
    archive.format !== ARCHIVE_FORMAT ||
    archive.version !== 1 ||
    !Array.isArray(archive.items) ||
    archive.items.length > config.MAX_ITEM_COUNT
  ) {
    throw badRequest("invalid_archive");
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
      Object.keys(raw).some((key) => !ITEM_FIELDS.has(key)) ||
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
    const id = `${raw.id[0]}${randomBytes(12).toString("hex")}`;
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
        raw._children.length === 0 ||
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
  return { items, mutations };
}

/**
 * Called inside the board session queue. All candidates must validate before
 * any item is inserted. Complete Pencil payloads stay native stored items;
 * their separate live create/append messages are retained for replay.
 * @param {import("./data.mjs").BoardData} board
 * @param {ReturnType<typeof prepareArchiveImport>} prepared
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
  if (candidates.length > 0) board.delaySave();
  return prepared.mutations.map((mutation) =>
    board.recordPersistentMutation(mutation, now),
  );
}
