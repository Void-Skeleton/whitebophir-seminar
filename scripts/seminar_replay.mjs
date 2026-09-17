// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-16: offline, validated canvas replay.
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { promisify } from "node:util";
import { gunzip, createGunzip } from "node:zlib";
import * as configuration from "../server/configuration.mjs";
import { BoardData } from "../server/board/data.mjs";
import { prepareArchiveImport } from "../server/board/archive.mjs";
import {
  ARCHIVE_ITEM_FIELDS,
  itemsFromSvg,
} from "../server/board/archive_codec.mjs";
import { normalizeIncomingMessage } from "../server/socket/message_validation.mjs";
import { mutationActivityPoint } from "../server/board/chunks.mjs";
import MessageCommon from "../client-data/js/message_common.js";
import {
  pencilCurve,
  pencilCurvePath,
  validatePencilCurve,
} from "../client-data/tools/pencil/curve.js";
import { curveEndpoint, measureCurve, revealCurve } from "./seminar_curves.mjs";
import {
  isActivityPoint,
  validateChunkState,
} from "../client-data/js/board_chunks.js";

const decompress = promisify(gunzip);
const replayConfig = {
  ...configuration,
  BLOCKED_TOOLS: [],
  MAX_BOARD_SIZE: 1e9,
  MAX_CHILDREN: 1000000,
  MAX_ITEM_COUNT: 1000000,
};
/** @typedef {{x:number,y:number}} Point */
/** @typedef {import("../client-data/tools/pencil/curve.js").Segment} CurveSegment */
/** @typedef {{id:string, start:number, end:number, order:number, points:Point[], prefix:number, closed:boolean, recordedCurve?:CurveSegment[], curve?:import("./seminar_curves.mjs").MeasuredCurve, path?:string, transforms:Map<string,{transform:any,padding:number}>}} Stroke */
/** @typedef {{minX:number,minY:number,maxX:number,maxY:number}} Bounds */

/** Cubic control hulls bound the curve, including overshoot beyond input points.
 * @param {CurveSegment[]} segments @param {number} [padding] @returns {Bounds | null}
 */
function curveBounds(segments, padding = 0) {
  if (!segments.length) return null;
  const b = {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  };
  for (const segment of segments)
    for (let i = 0; i < segment.values.length; i += 2) {
      const x = segment.values[i] || 0,
        y = segment.values[i + 1] || 0;
      b.minX = Math.min(b.minX, x);
      b.minY = Math.min(b.minY, y);
      b.maxX = Math.max(b.maxX, x);
      b.maxY = Math.max(b.maxY, y);
    }
  return {
    minX: b.minX - padding,
    minY: b.minY - padding,
    maxX: b.maxX + padding,
    maxY: b.maxY + padding,
  };
}

/** @param {any} value */
function time(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000)
    throw new Error("Invalid replay timestamp");
  return value;
}

/** @param {string} filename @param {number} compressed @param {number} expanded */
export async function readCompressed(filename, compressed, expanded) {
  if ((await stat(filename)).size > compressed)
    throw new Error("Replay input exceeds compressed limit");
  const data = await readFile(filename);
  if (data.length > compressed)
    throw new Error("Replay input exceeds compressed limit");
  return new TextDecoder("utf-8", { fatal: true }).decode(
    await decompress(data, { maxOutputLength: expanded }),
  );
}

/** Stream JSON Lines without materializing a seminar's entire decompressed log.
 * @param {string} filename @param {number} compressed @param {number} expanded
 */
export async function* readHistoryLines(filename, compressed, expanded) {
  if ((await stat(filename)).size > compressed)
    throw new Error("Replay input exceeds compressed limit");
  const input = createReadStream(filename);
  const unzip = createGunzip();
  let compressedBytes = 0,
    expandedBytes = 0,
    pending = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  input.on("data", (chunk) => {
    compressedBytes += chunk.length;
    if (compressedBytes > compressed)
      input.destroy(new Error("Replay input exceeds compressed limit"));
  });
  input.on("error", (error) => unzip.destroy(error));
  input.pipe(unzip);
  try {
    for await (const chunk of unzip) {
      expandedBytes += chunk.length;
      if (expandedBytes > expanded)
        throw new Error("Replay input exceeds decompressed limit");
      pending += decoder.decode(chunk, { stream: true });
      let start = 0;
      for (;;) {
        const newline = pending.indexOf("\n", start);
        if (newline === -1) break;
        yield pending.slice(start, newline);
        start = newline + 1;
      }
      pending = pending.slice(start);
    }
    pending += decoder.decode();
    if (pending.length) yield pending;
  } finally {
    input.destroy();
    unzip.destroy();
  }
}

/** @param {string | AsyncIterable<string>} log */
async function* historyLines(log) {
  if (typeof log === "string") yield* log.trimEnd().split("\n");
  else yield* log;
}

/** Validate with the native importer, retaining source IDs for history references. @param {any} raw @returns {any[]} */
function snapshotItems(raw) {
  const prepared = prepareArchiveImport(raw, replayConfig);
  return prepared.items.map((item, i) => ({ ...item, id: raw.items[i].id }));
}

/** @param {any} raw */
function metadata(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid replay settings");
  if (raw.theme !== undefined && raw.theme !== "light" && raw.theme !== "dark")
    throw new Error("Invalid replay theme");
  const chunks =
    raw.chunks === undefined ? undefined : validateChunkState(raw.chunks);
  if (chunks === null) throw new Error("Invalid replay chunks");
  return {
    readonly: false,
    ...(chunks && { chunks }),
    ...(raw.theme && { theme: raw.theme }),
  };
}

/** @param {any[]} items @param {any} settings */
function makeBoard(items, settings) {
  const board = new BoardData("offline-replay", replayConfig);
  board.delaySave = () => {};
  board.board = Object.fromEntries(items.map((item) => [item.id, item]));
  board.metadata = settings;
  return board;
}

/** @param {BoardData} board @param {any} mutation */
function apply(board, mutation) {
  const result = board.processMessage(mutation);
  if (!result.ok)
    throw new Error(`Snapshot/history mismatch: ${result.reason}`);
  board.consumePendingAcceptedMutationEffects();
  board.consumePendingRejectedMutationEffects();
}

/** Reveal the recorded cubic geometry at constant distance per unit time.
 * @param {Stroke} stroke @param {number} at @returns {CurveSegment[]}
 */
function strokeSegments(stroke, at) {
  if (at < stroke.start || !stroke.curve) return [];
  return revealCurve(
    stroke.curve,
    at >= stroke.end
      ? 1
      : (at - stroke.start) / Math.max(1, stroke.end - stroke.start),
  );
}

/** @param {CurveSegment[]} segments @returns {Point[]} */
function segmentPoints(segments) {
  return segments
    .filter((segment) => segment.type !== "L")
    .map((segment) => {
      const point = curveEndpoint(segment);
      return { x: Number(point.x.toFixed(6)), y: Number(point.y.toFixed(6)) };
    });
}

/** SVG snapshots omit repeated samples; compare geometric endpoints without
 * requiring those zero-length segments to survive a snapshot round trip.
 * @param {CurveSegment[]} segments
 */
function distinctCurvePoints(segments) {
  return segmentPoints(segments).filter(
    (point, index, points) =>
      index === 0 ||
      point.x !== points[index - 1]?.x ||
      point.y !== points[index - 1]?.y,
  );
}

/** @typedef {{snapshotAtMs?:number, startMs?:number, endMs?:number}} ReplayTimes */
/** @param {any} snapshot @param {string | AsyncIterable<string>} log @param {ReplayTimes} [options] */
export async function compileReplay(snapshot, log, options = {}) {
  const items = snapshotItems(snapshot);
  const lines = historyLines(log);
  try {
    const firstLine = await lines.next();
    const header = JSON.parse(firstLine.value || "null");
    if (
      !header ||
      header.format !== "whitebophir-history" ||
      header.version !== 1 ||
      header.timeUnit !== "unix-ms" ||
      header.interval !== "inclusive" ||
      typeof header.board !== "string"
    )
      throw new Error("Unsupported history format");
    const historyStart = time(header.from),
      end = time(header.to);
    if (historyStart > end || time(header.availableFrom) > historyStart)
      throw new Error("Invalid history range");
    const context = snapshot.replay;
    const start = time(options.snapshotAtMs ?? context?.atMs ?? historyStart);
    if (start < historyStart || start > end)
      throw new Error("Snapshot timestamp does not match history interval");
    const videoStart = time(options.startMs ?? start),
      videoEnd = time(options.endMs ?? end);
    if (videoStart < start || videoEnd > end || videoStart > videoEnd)
      throw new Error(
        "Require snapshot time <= video start <= video end <= history end",
      );
    if (context !== undefined) {
      if (
        !context ||
        context.atMs !== start ||
        context.board !== header.board ||
        !Number.isSafeInteger(context.seq) ||
        context.seq < 0 ||
        !isActivityPoint(context.point) ||
        !Array.isArray(context.emptyPencils)
      )
        throw new Error("Snapshot timestamp/board does not match history");
      const ids = new Set(items.map((item) => item.id));
      for (const item of context.emptyPencils) {
        if (
          !item ||
          item.tool !== "pencil" ||
          !Array.isArray(item._children) ||
          item._children.length ||
          ids.has(item.id)
        )
          throw new Error("Invalid pending Pencil in snapshot");
        const normalized = normalizeIncomingMessage(replayConfig, {
          ...item,
          _children: undefined,
          tool: 1,
          type: 1,
        });
        if (!normalized.ok)
          throw new Error("Invalid pending Pencil in snapshot");
        items.push({ ...normalized.value, tool: "pencil", _children: [] });
        ids.add(item.id);
      }
    }
    const initialMetadata = {
      readonly: false,
      theme: snapshot.theme || "light",
      ...(snapshot.chunks && {
        chunks: {
          ...snapshot.chunks,
          revision: "replay",
          point: context?.point || { x: 0, y: 0 },
        },
      }),
    };
    /** @type {any[]} */
    const events = [];
    let previousTime = historyStart,
      previousSeq,
      seqAtSnapshot,
      count = 0;
    for await (const line of lines) {
      if (++count > 4000000) throw new Error("Too many replay records");
      const raw = JSON.parse(line);
      if (!raw || time(raw.atMs) < previousTime || raw.atMs > end)
        throw new Error("History records out of order/range");
      previousTime = raw.atMs;
      if (raw.kind === "mutation") {
        if (
          !Number.isSafeInteger(raw.seq) ||
          raw.seq < 1 ||
          (previousSeq !== undefined && raw.seq !== previousSeq + 1)
        )
          throw new Error("History sequence gap");
        previousSeq = raw.seq;
        const normalized = normalizeIncomingMessage(replayConfig, raw.mutation);
        if (!normalized.ok || normalized.value.tool === 12)
          throw new Error("Invalid historical mutation");
        if (raw.atMs <= start) seqAtSnapshot = raw.seq;
        else events.push({ ...raw, mutation: normalized.value });
      } else if (raw.kind === "settings") {
        const settings = metadata(raw.metadata);
        if (raw.atMs > start) events.push({ ...raw, metadata: settings });
      } else if (raw.kind === "stroke") {
        if (
          MessageCommon.normalizeId(raw.id) === null ||
          time(raw.startAtMs) > time(raw.endAtMs) ||
          raw.endAtMs > raw.atMs
        )
          throw new Error("Invalid stroke interval");
        if (raw.curve !== undefined) validatePencilCurve(raw.curve);
        if (raw.atMs > start) events.push(raw);
      } else if (raw.kind === "checkpoint") {
        if (
          typeof raw.svg !== "string" ||
          !Number.isSafeInteger(raw.seq) ||
          raw.seq < (previousSeq || 0)
        )
          throw new Error("Invalid history checkpoint");
        previousSeq = raw.seq;
        const parsed = (await itemsFromSvg(raw.svg)).map((item) =>
          Object.fromEntries(
            Object.entries(item).filter(([key]) =>
              ARCHIVE_ITEM_FIELDS.has(key),
            ),
          ),
        );
        const checkpoint = {
          kind: "checkpoint",
          atMs: raw.atMs,
          seq: raw.seq,
          metadata: metadata(raw.metadata),
          items: snapshotItems({
            format: "whitebophir-board",
            version: 1,
            items: parsed,
          }),
        };
        if (raw.atMs <= start) seqAtSnapshot = raw.seq;
        else events.push(checkpoint);
      } else throw new Error("Unsupported history record");
    }
    const future = events;
    if (context) {
      const first = future.find(
        (event) => event.kind === "mutation" || event.kind === "checkpoint",
      );
      if (
        (first?.kind === "mutation" && first.seq !== context.seq + 1) ||
        (first?.kind === "checkpoint" && first.seq < context.seq)
      )
        throw new Error("Snapshot/history sequence mismatch");
      if (seqAtSnapshot !== undefined && seqAtSnapshot !== context.seq)
        throw new Error("Snapshot/history sequence mismatch");
    }
    /** @type {Map<string, Stroke>} */
    const active = new Map();
    /** @type {Stroke[]} */
    const strokes = [];
    /** @param {string} id @param {number} at @param {number} order @param {Point[]} [points] */
    const addStroke = (id, at, order, points = []) => {
      const stroke = {
        id,
        start: at,
        end: at,
        order,
        points: [...points],
        transforms: new Map(),
        prefix: points.length,
        closed: false,
      };
      active.set(id, stroke);
      strokes.push(stroke);
      return stroke;
    };
    for (const item of items)
      if (item.tool === "pencil") addStroke(item.id, start, -1, item._children);
    const initialStrokes = new Map(active);
    /** @type {Bounds | null} */
    let bounds = null;
    const board = makeBoard(items, initialMetadata);
    /** @param {Bounds | null} b */
    const mergeBounds = (b) => {
      if (!b) return;
      bounds = bounds
        ? {
            minX: Math.min(bounds.minX, b.minX),
            minY: Math.min(bounds.minY, b.minY),
            maxX: Math.max(bounds.maxX, b.maxX),
            maxY: Math.max(bounds.maxY, b.maxY),
          }
        : { ...b };
    };
    /** @param {Iterable<string>} ids */
    const includeBounds = (ids) => {
      for (const id of ids) {
        const item = board.itemsById.get(id);
        if (!item || item.deleted) continue;
        const b = MessageCommon.applyTransformToBounds(
          item.bounds,
          item.transform,
        );
        mergeBounds(b);
        if (item.tool === "pencil") {
          const stroke = active.get(id);
          const padding = Number(item.attrs.size || 0) / 2;
          if (stroke)
            stroke.transforms.set(
              JSON.stringify([item.transform || null, padding]),
              { transform: item.transform, padding },
            );
          else {
            const local = curveBounds(
              pencilCurve(board.get(id)?._children || []).segments,
              padding,
            );
            if (local)
              mergeBounds(
                MessageCommon.applyTransformToBounds(local, item.transform),
              );
          }
        }
      }
    };
    includeBounds(board.paintOrder);
    try {
      for (const [order, event] of future.entries()) {
        event.order = order;
        if (event.kind === "checkpoint") {
          board.board = Object.fromEntries(
            event.items.map((/** @type {any} */ item) => [item.id, item]),
          );
          active.clear();
          includeBounds(board.paintOrder);
        } else if (event.kind === "mutation") {
          const m = event.mutation;
          if (m.tool === 1 && m.type === 1)
            event.stroke = addStroke(m.id, event.atMs, order);
          if (m.tool === 1 && m.type === 4) {
            const stroke = active.get(m.parent);
            if (stroke) {
              stroke.points.push({ x: m.x, y: m.y });
              stroke.recordedCurve = undefined;
              stroke.end = event.atMs;
              event.stroke = stroke;
            }
          }
          apply(board, m);
          const children = m._children || [m];
          includeBounds(
            children.flatMap((/** @type {any} */ child) =>
              [child.id, child.newid, child.parent].filter(Boolean),
            ),
          );
        } else if (event.kind === "stroke") {
          const stroke = active.get(event.id);
          if (
            stroke &&
            event.startAtMs <= stroke.start &&
            event.endAtMs >= stroke.start
          ) {
            if (event.curve) {
              const expected = pencilCurve(stroke.points).segments;
              if (
                JSON.stringify(distinctCurvePoints(event.curve.segments)) !==
                JSON.stringify(distinctCurvePoints(expected))
              )
                throw new Error("Pencil curve/history mismatch");
              stroke.recordedCurve = event.curve.segments;
            }
            stroke.end = event.endAtMs;
            stroke.closed = true;
          }
        }
      }
    } finally {
      board.dispose();
    }
    for (const stroke of strokes) {
      const prefix = pencilCurve(
        stroke.points.slice(0, stroke.prefix),
      ).segments;
      stroke.curve = measureCurve(
        stroke.recordedCurve || pencilCurve(stroke.points).segments,
        prefix,
      );
      stroke.path = pencilCurvePath(stroke.curve.segments);
      for (const { transform, padding } of stroke.transforms.values()) {
        const local = curveBounds(stroke.curve.segments, padding);
        if (local)
          mergeBounds(MessageCommon.applyTransformToBounds(local, transform));
      }
    }
    return {
      start,
      end,
      videoStart,
      videoEnd,
      items,
      metadata: initialMetadata,
      initialPoint: context?.point || { x: 0, y: 0 },
      events: future,
      initialStrokes,
      bounds,
      incompleteStrokes: strokes.filter(
        (s) => !s.closed && s.end > s.start && s.points.length > s.prefix,
      ).length,
    };
  } finally {
    await lines.return();
  }
}

export class ReplayPlayer {
  /** @param {Awaited<ReturnType<typeof compileReplay>>} model */
  constructor(model) {
    this.model = model;
    this.board = makeBoard(model.items, model.metadata);
    this.strokes = new Map(model.initialStrokes);
    this.index = 0;
    this.time = model.start;
    this.activity = { at: model.start, order: -1, point: model.initialPoint };
  }

  /** @param {number} at */
  frame(at) {
    if (at < this.time || at > this.model.end)
      throw new Error("Replay frames must be chronological");
    this.time = at;
    while (
      this.index < this.model.events.length &&
      this.model.events[this.index].atMs <= at
    ) {
      const event = this.model.events[this.index++];
      if (event.kind === "checkpoint") {
        this.board.board = Object.fromEntries(
          event.items.map((/** @type {any} */ item) => [item.id, item]),
        );
        this.board.metadata = event.metadata;
        this.strokes.clear();
        this.activity = {
          at: event.atMs,
          order: event.order,
          point: event.metadata.chunks?.point || { x: 0, y: 0 },
        };
      } else if (event.kind === "settings") {
        this.board.metadata = event.metadata;
      } else if (event.kind === "mutation") {
        apply(this.board, event.mutation);
        const m = event.mutation;
        if (m.tool === 1 && m.type === 1) this.strokes.set(m.id, event.stroke);
        if (m.type === 6) this.strokes.clear();
        for (const child of m._children || [m])
          if (child.type === 3) this.strokes.delete(child.id);
        if (!event.stroke) {
          const point = mutationActivityPoint(this.board, m);
          if (point)
            this.activity = { at: event.atMs, order: event.order, point };
        }
      }
    }
    let activity = this.activity;
    const items = [];
    for (const id of this.board.paintOrder) {
      const item = this.board.get(id);
      if (!item) continue;
      const stroke = this.strokes.get(id);
      if (
        stroke &&
        stroke.points.length > stroke.prefix &&
        at > this.model.start
      ) {
        item.replayCurve = strokeSegments(stroke, at);
        item._children =
          at >= stroke.end ? stroke.points : segmentPoints(item.replayCurve);
        if (at >= stroke.end) item.replayPath = stroke.path;
        const segment = item.replayCurve[item.replayCurve.length - 1];
        const tip = segment && curveEndpoint(segment);
        const last = tip && {
          x: Number(tip.x.toFixed(6)),
          y: Number(tip.y.toFixed(6)),
        };
        const moment = Math.min(at, stroke.end);
        if (
          last &&
          (moment > activity.at ||
            (moment === activity.at && stroke.order > activity.order))
        ) {
          const b = MessageCommon.applyTransformToBounds(
            { minX: last.x, minY: last.y, maxX: last.x, maxY: last.y },
            item.transform,
          );
          if (b)
            activity = {
              at: moment,
              order: stroke.order,
              point: { x: Math.max(0, b.maxX), y: Math.max(0, b.maxY) },
            };
        }
      }
      if (item.tool === "pencil" && !item.replayCurve) {
        item.replayCurve =
          stroke?.curve?.prefix || pencilCurve(item._children || []).segments;
        if (stroke && stroke.points.length === stroke.prefix)
          item.replayPath = stroke.path;
      }
      items.push(item);
    }
    return { items, metadata: this.board.metadata, point: activity.point };
  }

  dispose() {
    this.board.dispose();
  }
}
