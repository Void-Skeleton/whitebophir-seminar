// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-16: validate recordings and align them to server time.
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";

/** @typedef {{frames:number,atMs:number}} Anchor */
/** @typedef {{file:string,anchors:Anchor[],frames:number,encoding:string,bytes:number}} Recording */
const RATE = 48000;

// Ogg uses an unreflected CRC-32 with polynomial 0x04c11db7.
const CRC = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index << 24;
  for (let bit = 0; bit < 8; bit++)
    value = (value << 1) ^ (value < 0 ? 0x04c11db7 : 0);
  return value >>> 0;
});

/** Validate only the committed prefix; an uncommitted torn tail is recoverable.
 * @param {string} file @param {number} bytes @param {number} frames
 */
async function validateOpus(file, bytes, frames) {
  let pending = Buffer.alloc(0),
    sequence = 0,
    serial = 0,
    preSkip = 0,
    granule = 0,
    ended = false;
  for await (const chunk of createReadStream(file, {
    start: 0,
    end: bytes - 1,
  })) {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 27) {
      const segments = pending[26] || 0;
      if (pending.length < 27 + segments) break;
      const lacing = pending.subarray(27, 27 + segments);
      const length =
        27 + segments + lacing.reduce((sum, size) => sum + size, 0);
      if (pending.length < length) break;
      const page = pending.subarray(0, length);
      pending = pending.subarray(length);
      let crc = 0;
      for (let i = 0; i < page.length; i++) {
        const byte = i >= 22 && i < 26 ? 0 : page[i] || 0;
        crc = ((crc << 8) ^ (CRC[((crc >>> 24) ^ byte) & 255] || 0)) >>> 0;
      }
      const flags = page[5] || 0;
      const nextGranule = Number(page.readBigUInt64LE(6));
      const body = page.subarray(27 + segments);
      if (
        ended ||
        page.toString("ascii", 0, 4) !== "OggS" ||
        page[4] !== 0 ||
        (flags & ~6) !== 0 ||
        !!(flags & 2) !== (sequence === 0) ||
        !segments ||
        lacing[segments - 1] === 255 ||
        page.readUInt32LE(18) !== sequence ||
        page.readUInt32LE(22) !== crc ||
        !Number.isSafeInteger(nextGranule) ||
        nextGranule < granule ||
        nextGranule > 1e12 + 65535
      )
        throw new Error("Invalid committed Ogg Opus page");
      if (sequence === 0) {
        if (
          body.length !== 19 ||
          body.toString("ascii", 0, 8) !== "OpusHead" ||
          body[8] !== 1 ||
          body[9] !== 2 ||
          body[18] !== 0
        )
          throw new Error("Invalid Opus audio header");
        serial = page.readUInt32LE(14);
        preSkip = body.readUInt16LE(10);
      } else if (
        page.readUInt32LE(14) !== serial ||
        (sequence === 1 && body.toString("ascii", 0, 8) !== "OpusTags")
      ) {
        throw new Error("Invalid Opus stream headers");
      }
      sequence++;
      granule = nextGranule;
      ended = !!(flags & 4);
    }
  }
  if (pending.length || sequence < 3 || granule - preSkip < frames)
    throw new Error("Opus audio is shorter than its committed metadata");
}

/** @param {string} filename @returns {Promise<Recording>} */
export async function readRecording(filename) {
  if (typeof filename !== "string" || !filename.endsWith(".audio.jsonl"))
    throw new Error("Audio input must be a .audio.jsonl timing file");
  const info = await stat(filename);
  if (!info.isFile() || info.size > 16 * 1024 * 1024)
    throw new Error("Audio metadata exceeds 16 MiB");
  const text = await readFile(filename, "utf8");
  // Only complete, durable journal lines count after an interrupted recording.
  const rows = text.slice(0, text.lastIndexOf("\n")).split("\n");
  if (!text.includes("\n") || rows.length > 100000)
    throw new Error("Invalid audio timing journal");
  const header = JSON.parse(rows.shift() || "null");
  const opus = header?.version === 2 && header.encoding === "opus";
  const expected = path
    .basename(filename)
    .replace(/\.audio\.jsonl$/, opus ? ".opus" : ".pcm");
  if (
    header?.format !== "whitebophir-audio" ||
    (!opus && header.version !== 1) ||
    header.audio !== expected ||
    header.sampleRate !== RATE ||
    header.channels !== 2 ||
    (!opus && header.encoding !== "s16le")
  )
    throw new Error("Unsupported audio recording format");
  const directory = await realpath(path.dirname(filename));
  const file = await realpath(path.join(directory, expected));
  if (path.dirname(file) !== directory)
    throw new Error("Audio file must stay beside its timing journal");
  const audio = await stat(file);
  if (!audio.isFile()) throw new Error("Invalid audio file");
  /** @type {Anchor[]} */
  const anchors = [];
  let ended = false,
    bytes = 0;
  for (const line of rows) {
    const row = JSON.parse(line);
    const previous = anchors[anchors.length - 1];
    if (
      !row ||
      ended ||
      !Number.isSafeInteger(row.frames) ||
      row.frames < 0 ||
      row.frames > 1e12
    )
      throw new Error("Invalid audio frame count");
    if (row.kind === "end") {
      if (row.frames !== (previous?.frames || 0))
        throw new Error("Audio final frame mismatch");
      ended = true;
      continue;
    }
    if (
      !Number.isFinite(row.atMs) ||
      row.atMs < 0 ||
      row.atMs > 8640000000000000
    )
      throw new Error("Invalid audio timestamp");
    if (!previous) {
      if (row.kind !== "start" || row.frames !== 0)
        throw new Error("Missing audio start");
    } else if (
      row.atMs <= previous.atMs ||
      (row.kind === "checkpoint"
        ? row.frames <= previous.frames
        : row.kind !== "resume" || row.frames !== previous.frames)
    )
      throw new Error("Audio anchors must be chronological");
    anchors.push({ frames: row.frames, atMs: row.atMs });
    if (opus && row.kind === "checkpoint") {
      if (
        !Number.isSafeInteger(row.audioBytes) ||
        row.audioBytes <= 0 ||
        row.audioBytes < bytes ||
        row.audioBytes > audio.size
      )
        throw new Error("Invalid committed Opus byte count");
      bytes = row.audioBytes;
    }
  }
  const frames = anchors[anchors.length - 1]?.frames || 0;
  if (!opus && frames * 4 > audio.size)
    throw new Error("Audio is shorter than its committed metadata");
  if (opus && frames) await validateOpus(file, bytes, frames);
  return {
    file,
    anchors,
    frames,
    encoding: header.encoding,
    bytes: opus ? bytes : frames * 4,
  };
}

/** Map samples to the video's server clock. Balanced branches bound expression depth.
 * @param {{first:Anchor,last:Anchor}[]} segments @param {number} skip @param {number} start
 * @returns {string}
 */
function timestampExpression(segments, skip, start) {
  if (segments.length === 1) {
    const { first, last } = /** @type {{first:Anchor,last:Anchor}} */ (
      segments[0]
    );
    const slope =
      ((last.atMs - first.atMs) * RATE) / (1000 * (last.frames - first.frames));
    const base = ((first.atMs - start) * RATE) / 1000;
    return `(${base}+(N+${skip - first.frames})*${slope})`;
  }
  const middle = Math.floor(segments.length / 2);
  const boundary =
    /** @type {{first:Anchor}} */ (segments[middle]).first.frames - skip;
  return `if(lt(N,${boundary}),${timestampExpression(segments.slice(0, middle), skip, start)},${timestampExpression(segments.slice(middle), skip, start)})`;
}

/** @param {number} speed */
function tempo(speed) {
  const filters = [];
  while (speed < 0.5) {
    filters.push("atempo=0.5");
    speed /= 0.5;
  }
  while (speed > 2) {
    filters.push("atempo=2");
    speed /= 2;
  }
  filters.push(`atempo=${speed}`);
  return filters.join(",");
}

/** @param {Recording[]} recordings @param {number} start @param {number} end
 * @param {number} speed @param {number} duration @param {string} directory @param {AbortSignal} [signal]
 */
export async function audioArguments(
  recordings,
  start,
  end,
  speed,
  duration,
  directory,
  signal,
) {
  /** @type {string[]} */
  const inputs = [],
    filters = [],
    labels = [];
  let used = 0;
  for (const recording of recordings) {
    const segments = recording.anchors.slice(1).flatMap((last, i) => {
      const first = /** @type {Anchor} */ (recording.anchors[i]);
      return last.frames > first.frames && first.atMs < end && last.atMs > start
        ? [{ first, last }]
        : [];
    });
    if (!segments.length || !recording.frames) continue;
    const first = /** @type {{first:Anchor,last:Anchor}} */ (segments[0]);
    const last = /** @type {{first:Anchor,last:Anchor}} */ (
      segments[segments.length - 1]
    );
    /** @param {{first:Anchor,last:Anchor}} segment @param {number} at */
    const frameAt = (segment, at) =>
      segment.first.frames +
      ((at - segment.first.atMs) *
        (segment.last.frames - segment.first.frames)) /
        (segment.last.atMs - segment.first.atMs);
    const skip = Math.max(
      first.first.frames,
      Math.floor(frameAt(first, Math.max(start, first.first.atMs))),
    );
    const through = Math.min(
      last.last.frames,
      Math.ceil(frameAt(last, Math.min(end, last.last.atMs))),
    );
    if (through <= skip) continue;
    used++;
    let trim = "";
    if (recording.encoding === "opus") {
      // Keep recovery independent of any partial page or junk after the last
      // checkpoint, without expanding the recording into a temporary PCM file.
      const committed = path.join(directory, `audio-${used}.opus`);
      await pipeline(
        createReadStream(recording.file, {
          start: 0,
          end: recording.bytes - 1,
        }),
        createWriteStream(committed, { flags: "wx" }),
        { signal },
      );
      inputs.push("-f", "ogg", "-i", committed);
      trim = `atrim=start_sample=${skip}:end_sample=${through},`;
    } else
      inputs.push(
        "-f",
        "s16le",
        "-ar",
        String(RATE),
        "-ac",
        "2",
        "-skip_initial_bytes",
        String(skip * 4),
        "-t",
        String((through - skip) / RATE),
        "-i",
        recording.file,
      );
    const expression = timestampExpression(segments, skip, start);
    const label = `audio${used}`;
    filters.push(
      `[${used}:a]${trim}asetnsamples=n=480:p=0,asettb=1/${RATE},asetpts='${expression}',` +
        // Apply measured gaps promptly; the default 100 ms hard-compensation
        // threshold can carry that much stale audio past a source's endpoint.
        `aresample=${RATE}:async=1000:min_hard_comp=0.001:first_pts=0,atrim=end=${(end - start) / 1000},` +
        `${tempo(speed)},apad,atrim=end=${duration}[${label}]`,
    );
    labels.push(`[${label}]`);
  }
  if (!used) return { inputs, output: ["-an"], used };
  // Fixed gain while mixing avoids audible volume pumping as sources start/end.
  filters.push(
    `${labels.join("")}amix=inputs=${used}:normalize=0,alimiter=limit=0.95:level=0:latency=1[mixed]`,
  );
  const script = path.join(directory, "audio-filters.txt");
  await writeFile(script, filters.join(";\n"), { flag: "wx" });
  return {
    inputs,
    output: [
      "-filter_complex_script",
      script,
      "-map",
      "0:v:0",
      "-map",
      "[mixed]",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-t",
      String(duration),
    ],
    used,
  };
}
