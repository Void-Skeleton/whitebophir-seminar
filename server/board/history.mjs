// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-16: durable compressed, timestamped board history.
import { open, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { readServedBaseline } from "../persistence/svg_board_store.mjs";
import { BoundaryError } from "../http/boundary_errors.mjs";
import {
  itemsFromSvg,
  encodeArchive,
  ARCHIVE_ITEM_FIELDS,
} from "./archive_codec.mjs";
import { BoardData } from "./data.mjs";
import { createMutationLog } from "./mutation_log.mjs";
import { pencilCurve } from "../../client-data/tools/pencil/curve.js";
import { wboPencilPoint } from "../../client-data/tools/pencil/wbo_pencil_point.js";

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const MAX_RECORD_BYTES = 1024 * 1024 * 1024;
const HEADER_SIZE = 20;
/** @typedef {import("./data.mjs").BoardMetadata} Metadata */
/** @typedef {import("../../types/server-runtime.d.ts").MutationLogEntry} MutationLogEntry */
/** @typedef {{id:string, startAtMs:number, endAtMs:number}} Stroke */
/** @typedef {{kind:string, atMs:number, seq?:number, mutation?:any, metadata?:Metadata, svg?:string, startAtMs?:number, endAtMs?:number, id?:string, reason?:string, socketId?:string, stroke?:Stroke | null, curve?:import("../../client-data/tools/pencil/curve.js").PencilCurve}} HistoryRecord */

/**
 * Each transaction is a complete gzip member containing JSON Lines. A standard
 * gzip extra field carries its compressed length, allowing bounded sequential
 * reads and recovery of an interrupted final write without accepting corruption.
 * Ordinary gzip tools can decompress the concatenated members directly.
 * @param {HistoryRecord[]} records
 */
async function encodeMember(records) {
  const json = Buffer.from(
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  if (json.length > MAX_RECORD_BYTES)
    throw new Error("History transaction too large");
  const gz = await compress(json, { level: 1 });
  if (gz.length + 10 > MAX_RECORD_BYTES)
    throw new Error("Compressed history transaction too large");
  const header = Buffer.alloc(HEADER_SIZE);
  gz.copy(header, 0, 0, 10);
  header[3] = 4; // FEXTRA
  header.writeUInt16LE(8, 10);
  header.write("WB", 12);
  header.writeUInt16LE(4, 14);
  header.writeUInt32LE(gz.length + 10, 16);
  return Buffer.concat([header, gz.subarray(10)]);
}

/** @param {import("node:fs/promises").FileHandle} file @param {number} size @param {number} offset */
async function readExact(file, size, offset) {
  const buffer = Buffer.alloc(size);
  let read = 0;
  while (read < size) {
    const result = await file.read(buffer, read, size - read, offset + read);
    if (!result.bytesRead) break;
    read += result.bytesRead;
  }
  return buffer.subarray(0, read);
}

/** @param {string} path @param {number} [limit] @param {boolean} [recover] */
export async function* readHistory(path, limit = Infinity, recover = false) {
  const file = await open(path, recover ? "r+" : "r");
  try {
    const size = Math.min((await file.stat()).size, limit);
    let offset = 0;
    while (offset < size) {
      const header = await readExact(
        file,
        Math.min(HEADER_SIZE, size - offset),
        offset,
      );
      if (header.length < HEADER_SIZE) {
        if (!recover) throw new Error("Incomplete history header");
        await file.truncate(offset);
        await file.sync();
        break;
      }
      if (
        header[0] !== 31 ||
        header[1] !== 139 ||
        header[2] !== 8 ||
        header[3] !== 4 ||
        header.readUInt16LE(10) !== 8 ||
        header.toString("ascii", 12, 14) !== "WB" ||
        header.readUInt16LE(14) !== 4
      )
        throw new Error("Invalid history member header");
      const length = header.readUInt32LE(16);
      if (length < HEADER_SIZE + 8 || length > MAX_RECORD_BYTES)
        throw new Error("Invalid history member length");
      if (offset + length > size) {
        if (!recover) throw new Error("Incomplete history member");
        await file.truncate(offset);
        await file.sync();
        break;
      }
      const member = await readExact(file, length, offset);
      const json = await decompress(member, {
        maxOutputLength: MAX_RECORD_BYTES,
      });
      if (json[json.length - 1] !== 10)
        throw new Error("Incomplete history transaction");
      /** @type {HistoryRecord[]} */
      const records = json
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      for (const record of records) {
        if (!record || !Number.isSafeInteger(record.atMs) || record.atMs < 0)
          throw new Error("Invalid history timestamp");
      }
      offset += length;
      yield { records, offset };
    }
  } finally {
    await file.close();
  }
}

export class BoardHistory {
  /** @param {BoardData} board */
  constructor(board) {
    this.board = board;
    this.path = `${board.file}.history.jsonl.gz`;
    this.offset = 0;
    this.startedAtMs = 0;
    this.lastAtMs = 0;
    /** @type {Map<string, Stroke>} */
    this.strokes = new Map();
    /** Active geometry survives SVG saves, which discard in-memory point payloads.
     * It is stored once on completion, never duplicated in each timing record.
     * @type {Map<string, import("../../client-data/tools/pencil/curve.js").PencilCurve>}
     */
    this.curves = new Map();
    this.pending = Promise.resolve();
  }

  /** @param {number} [time] */
  timestamp(time = Date.now()) {
    return Math.max(this.lastAtMs, Math.trunc(time));
  }

  /** Save the browser's cubic controls once per completed stroke. Point mutations
   * remain authoritative for board recovery and older readers.
   * @param {Stroke} stroke @param {number} atMs @param {string} reason @returns {HistoryRecord}
   */
  strokeRecord(stroke, atMs, reason) {
    return {
      kind: "stroke",
      ...stroke,
      atMs,
      reason,
      endAtMs: reason === "release" ? atMs : stroke.endAtMs,
      ...(this.curves.has(stroke.id) && { curve: this.curves.get(stroke.id) }),
    };
  }

  /** @param {HistoryRecord[]} records */
  append(records) {
    if (!records.length) return this.pending;
    this.lastAtMs = records[records.length - 1]?.atMs || this.lastAtMs;
    this.pending = this.pending
      .then(async () => {
        if (this.board.disposed) throw new Error("History board unavailable");
        const data = await encodeMember(records);
        const file = await open(this.path, "a", 0o600);
        try {
          await file.writeFile(data);
          await file.datasync();
          this.offset += data.length;
        } finally {
          await file.close();
        }
      })
      .catch((error) => {
        // Never publish an unjournaled edit or allow a later SVG save to hide it.
        this.board.dispose();
        throw error;
      });
    return this.pending;
  }

  /** @param {MutationLogEntry[]} entries @param {string} [socketId] @param {Metadata} [metadata] */
  commit(entries, socketId = "", metadata) {
    if (!entries.length && !metadata) return this.pending;
    const atMs = this.timestamp();
    /** @type {HistoryRecord[]} */
    const records = [];
    for (const entry of entries) {
      const mutation = entry.mutation;
      // The endpoint already normalizes mutations; never store transport secrets.
      const { socket: _socket, userId: _user, ...data } = mutation;
      if (socketId && data.tool === 1 && data.type === 1 && "id" in data) {
        const previous = this.strokes.get(socketId);
        if (previous) {
          records.push(this.strokeRecord(previous, atMs, "superseded"));
          this.curves.delete(previous.id);
        }
        this.strokes.set(socketId, {
          id: String(data.id),
          startAtMs: atMs,
          endAtMs: atMs,
        });
        this.curves.set(String(data.id), pencilCurve([]));
      }
      const stroke = this.strokes.get(socketId);
      if (data.tool === 1 && data.type === 4 && "parent" in data) {
        if (stroke && data.parent === stroke.id) stroke.endAtMs = atMs;
        const curve = this.curves.get(data.parent);
        if (curve) wboPencilPoint(curve.segments, data.x, data.y);
      }
      records.push({
        kind: "mutation",
        atMs,
        startAtMs: atMs,
        endAtMs: atMs,
        seq: entry.seq,
        mutation: data,
      });
    }
    if (metadata)
      records.push({
        kind: "settings",
        atMs,
        startAtMs: atMs,
        endAtMs: atMs,
        seq: this.board.getSeq(),
        metadata,
      });
    // Persist active timing so a process interruption has a bounded end time.
    if (socketId)
      records.push({
        kind: "active_stroke",
        atMs,
        socketId,
        stroke: this.strokes.get(socketId) || null,
      });
    return this.append(records);
  }

  /** @param {string} socketId @param {string | undefined} id @param {string} reason */
  finishStroke(socketId, id, reason) {
    const stroke = this.strokes.get(socketId);
    if (!stroke || (id !== undefined && stroke.id !== id)) return this.pending;
    this.strokes.delete(socketId);
    const atMs = this.timestamp();
    const record = this.strokeRecord(stroke, atMs, reason);
    this.curves.delete(stroke.id);
    return this.append([
      record,
      { kind: "active_stroke", atMs, socketId, stroke: null },
    ]);
  }
}

/** Called only during cold server-board load, before writes can be admitted. @param {BoardData} board */
export async function initializeHistory(board) {
  const delaySave = board.delaySave;
  /** @type {[number, number, number]} */
  const limits = [board.maxChildren, board.maxItemCount, board.maxBoardSize];
  board.delaySave = () => {};
  // Replaying already accepted edits must not reapply newer admission limits
  // or evict different objects. Recorded eviction mutations remain authoritative.
  board.maxChildren = Number.MAX_SAFE_INTEGER;
  board.maxItemCount = Number.MAX_SAFE_INTEGER;
  board.maxBoardSize = Number.MAX_SAFE_INTEGER;
  try {
    await loadHistory(board);
  } finally {
    board.delaySave = delaySave;
    [board.maxChildren, board.maxItemCount, board.maxBoardSize] = limits;
  }
  if (
    board.getSeq() > board.getPersistedSeq() ||
    board.metadata !== board.persistedMetadata
  )
    board.delaySave();
}

/** @param {BoardData} board */
async function loadHistory(board) {
  const history = new BoardHistory(board);
  let exists = true;
  try {
    const file = await open(history.path, "r");
    await file.close();
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT")
      throw error;
    exists = false;
  }
  if (!exists) {
    const atMs = Date.now();
    const svg = await readServedBaseline(board.name, {
      historyDir: board.historyDir,
    });
    const data = await encodeMember([
      {
        kind: "baseline",
        atMs,
        seq: board.getSeq(),
        svg,
        metadata: board.metadata,
      },
    ]);
    const temporary = `${history.path}.tmp`;
    const file = await open(temporary, "w", 0o600);
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, history.path);
    const directory = await open(dirname(history.path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  const savedSeq = board.getSeq();
  const savedMetadata = board.metadata;
  let latestSeq = -1;
  let recovered = false;
  for await (const { records, offset } of readHistory(
    history.path,
    Infinity,
    true,
  )) {
    for (const record of records) {
      if (record.atMs < history.lastAtMs)
        throw new Error("History timestamps out of order");
      history.lastAtMs = record.atMs;
      if (record.kind === "baseline" || record.kind === "checkpoint") {
        if (
          (record.kind === "baseline" && latestSeq !== -1) ||
          record.seq === undefined ||
          record.seq < latestSeq ||
          !record.svg
        )
          throw new Error("Invalid history baseline");
        latestSeq = record.seq;
        if (record.kind === "baseline") history.startedAtMs = record.atMs;
        if (savedSeq < latestSeq || board.loadSource === "empty") {
          board.board = Object.fromEntries(
            (await itemsFromSvg(record.svg)).map((item) => [item.id, item]),
          );
          board.metadata = record.metadata || { readonly: false };
          board.mutationLog = createMutationLog(latestSeq);
          recovered = true;
        }
      } else if (latestSeq === -1) throw new Error("Missing history baseline");
      else if (record.kind === "mutation") {
        if (record.seq !== latestSeq + 1)
          throw new Error("History sequence gap");
        latestSeq = record.seq;
        const mutation = record.mutation;
        const curve = history.curves.get(mutation?.parent);
        if (curve && mutation.tool === 1 && mutation.type === 4)
          wboPencilPoint(curve.segments, mutation.x, mutation.y);
        if (record.seq > savedSeq) {
          const prepared = await board.preparePersistentMutation(
            record.mutation,
          );
          if (
            !prepared.ok ||
            !board.processMessage(prepared.mutation || record.mutation).ok
          )
            throw new Error("Cannot recover history mutation");
          board.recordPersistentMutation(
            prepared.mutation || record.mutation,
            record.atMs,
          );
          board.consumePendingAcceptedMutationEffects();
          board.consumePendingRejectedMutationEffects();
          recovered = true;
        }
      } else if (record.kind === "settings" && record.metadata) {
        if ((record.seq || 0) >= savedSeq) {
          board.metadata = record.metadata;
          recovered = true;
        }
      } else if (record.kind === "active_stroke" && record.socketId) {
        const previous = history.strokes.get(record.socketId);
        if (previous && previous.id !== record.stroke?.id)
          history.curves.delete(previous.id);
        if (record.stroke) {
          history.strokes.set(record.socketId, record.stroke);
          if (!history.curves.has(record.stroke.id))
            history.curves.set(record.stroke.id, pencilCurve([]));
        } else history.strokes.delete(record.socketId);
      } else if (record.kind !== "stroke")
        throw new Error("Unknown history record");
    }
    history.offset = offset;
  }
  board.history = history;
  if (latestSeq < savedSeq) {
    board.metadata = savedMetadata;
    await history.append([
      {
        kind: "checkpoint",
        atMs: history.timestamp(),
        seq: savedSeq,
        svg: await readServedBaseline(board.name, {
          historyDir: board.historyDir,
        }),
        metadata: savedMetadata,
        reason: "external_snapshot",
      },
    ]);
  }
  for (const socketId of [...history.strokes.keys()])
    await history.finishStroke(socketId, undefined, "interrupted");
  if (recovered && board.metadata.chunks)
    board.metadata = {
      ...board.metadata,
      chunks: { ...board.metadata.chunks, point: board.activityPoint },
    };
}

/** @param {BoardHistory} history @param {number} atMs @param {number} limit @param {import("../../types/server-runtime.d.ts").ServerConfig} config */
export async function historicalSnapshot(history, atMs, limit, config) {
  if (atMs < history.startedAtMs)
    throw new BoundaryError(416, "history_before_start");
  const board = new BoardData("history-snapshot", config);
  // Historical replay is an isolated in-memory board and must never autosave.
  board.delaySave = () => {};
  board.maxItemCount = Number.MAX_SAFE_INTEGER;
  board.maxChildren = Number.MAX_SAFE_INTEGER;
  board.maxBoardSize = Number.MAX_SAFE_INTEGER;
  try {
    for await (const { records } of readHistory(history.path, limit)) {
      for (const record of records) {
        if (record.atMs > atMs) break;
        if (record.kind === "baseline" || record.kind === "checkpoint") {
          board.board = Object.fromEntries(
            (await itemsFromSvg(record.svg || "")).map((item) => [
              item.id,
              item,
            ]),
          );
          board.metadata = record.metadata || { readonly: false };
          board.mutationLog = createMutationLog(record.seq);
          board.activityPoint = board.metadata.chunks?.point || { x: 0, y: 0 };
        } else if (record.kind === "mutation") {
          const result = board.processMessage(record.mutation);
          if (!result.ok) throw new Error("Invalid historical mutation");
          board.recordPersistentMutation(record.mutation, record.atMs);
          board.consumePendingAcceptedMutationEffects();
          board.consumePendingRejectedMutationEffects();
          // This snapshot needs state, not a second in-memory event log.
          board.mutationLog.trimBefore(board.getSeq() + 1);
        } else if (record.kind === "settings" && record.metadata)
          board.metadata = record.metadata;
      }
      if ((records[records.length - 1]?.atMs || 0) > atMs) break;
    }
    const items = Object.values(board.board).map((item) =>
      Object.fromEntries(
        Object.entries(item).filter(([key]) => ARCHIVE_ITEM_FIELDS.has(key)),
      ),
    );
    return await encodeArchive(
      items.filter((item) => item.tool !== "pencil" || item._children?.length),
      config,
      board.metadata.chunks,
      board.metadata.theme,
      {
        board: history.board.name,
        atMs,
        seq: board.getSeq(),
        point: board.activityPoint,
        emptyPencils: items.filter(
          (item) => item.tool === "pencil" && !item._children?.length,
        ),
      },
    );
  } finally {
    board.dispose();
  }
}

/** @param {BoardHistory} history @param {number} from @param {number} to @param {number} limit @param {import("node:stream").Writable} output */
export async function downloadHistory(history, from, to, limit, output) {
  async function* lines() {
    yield `${JSON.stringify({
      format: "whitebophir-history",
      version: 1,
      board: history.board.name,
      from,
      to,
      availableFrom: history.startedAtMs,
      timeUnit: "unix-ms",
      interval: "inclusive",
    })}\n`;
    for await (const { records } of readHistory(history.path, limit)) {
      for (const record of records) {
        if (record.atMs > to) return;
        if (
          record.atMs >= from &&
          record.kind !== "baseline" &&
          record.kind !== "active_stroke"
        )
          yield `${JSON.stringify(record)}\n`;
      }
    }
  }
  await pipeline(Readable.from(lines()), createGzip(), output);
}

/** Materialize only requested undo snapshots; sequence bounds distinguish writes
 * accepted in the same millisecond. Called for an explicit undo, never a write.
 * @param {BoardHistory} history
 * @param {import("./edit_history.mjs").Snapshot[]} requests
 */
export async function historicalItems(history, requests) {
  const { archiveItem } = await import("./edit_history.mjs");
  const { MAX_RESTORE_BYTES } = await import("./restore.mjs");
  let bytes = 0;
  const board = new BoardData("undo-snapshot", history.board.config);
  board.delaySave = () => {};
  board.maxItemCount = Number.MAX_SAFE_INTEGER;
  board.maxChildren = Number.MAX_SAFE_INTEGER;
  board.maxBoardSize = Number.MAX_SAFE_INTEGER;
  const pending = requests.slice().sort((a, b) => a.seq - b.seq);
  let index = 0;
  const collect = () => {
    while (index < pending.length && pending[index]?.seq === board.getSeq()) {
      const request = pending[index++];
      if (!request) break;
      const item = board.get(request.id);
      request.item = item ? structuredClone(archiveItem(item)) : null;
      bytes += JSON.stringify(request.item).length * 2;
      if (bytes > MAX_RESTORE_BYTES) throw new Error("Undo snapshot too large");
    }
  };
  try {
    for await (const { records } of readHistory(history.path, history.offset)) {
      for (const record of records) {
        if (record.kind === "baseline" || record.kind === "checkpoint") {
          board.board = Object.fromEntries(
            (await itemsFromSvg(record.svg || "")).map((item) => [
              item.id,
              item,
            ]),
          );
          board.mutationLog = createMutationLog(record.seq);
        } else if (record.kind === "mutation") {
          if (!board.processMessage(record.mutation).ok)
            throw new Error("Invalid undo history");
          board.recordPersistentMutation(record.mutation, record.atMs);
          board.mutationLog.trimBefore(board.getSeq() + 1);
        } else continue;
        collect();
        if (index === pending.length) return;
      }
    }
    throw new Error("Undo snapshot unavailable");
  } finally {
    board.dispose();
  }
}
