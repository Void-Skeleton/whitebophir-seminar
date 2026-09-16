// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-16: canvas-only Chromium/ffmpeg video export.
import { spawn } from "node:child_process";
import { mkdtemp, link, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import {
  compileReplay,
  readCompressed,
  readHistoryLines,
  ReplayPlayer,
} from "./seminar_replay.mjs";
import { serializeStoredSvgItem } from "../server/persistence/stored_svg_item_codec.mjs";
import { DEFAULT_CHUNKS, chunkRect } from "../client-data/js/board_chunks.js";
import { THEME_SVG_RESOURCES } from "../client-data/js/board_theme.js";
import { audioArguments, readRecording } from "./seminar_audio_mix.mjs";

/** @typedef {{x:number,y:number,width:number,height:number}} Rect */
/** @typedef {import("./seminar_replay.mjs").ReplayTimes & {snapshot:string,history:string,output:string,width:number,height:number,fps:number,speed:number,camera:string,viewBox?:number[],initialPoint?:number[],chunkWidth?:number,chunkHeight?:number,margin?:number,transitionMs:number,ffmpeg:string,chromium?:string,maxArchiveBytes:number,maxJsonBytes:number,audio?:string[]}} Options */

/** @param {Rect} rect @param {number} ratio */
export function fitRect(rect, ratio) {
  const width = Math.max(rect.width, rect.height * ratio);
  const height = width / ratio;
  return {
    x: rect.x - (width - rect.width) / 2,
    y: rect.y - (height - rect.height) / 2,
    width,
    height,
  };
}

export class ReplayCamera {
  /** @param {Options} options @param {import("./seminar_replay.mjs").Bounds | null} bounds */
  constructor(options, bounds) {
    this.options = options;
    this.bounds = bounds;
    /** @type {Rect | null} */
    this.target = null;
    /** @type {Rect | null} */
    this.origin = null;
    this.changedAt = 0;
  }

  /** @param {any} settings */
  settings(settings) {
    return {
      ...DEFAULT_CHUNKS,
      ...settings,
      ...(this.options.chunkWidth !== undefined && {
        width: this.options.chunkWidth,
      }),
      ...(this.options.chunkHeight !== undefined && {
        height: this.options.chunkHeight,
      }),
      ...(this.options.margin !== undefined && { margin: this.options.margin }),
    };
  }

  /** @param {number} at @returns {Rect} */
  current(at) {
    if (!this.origin || !this.target) throw new Error("Camera not initialized");
    const f =
      this.options.transitionMs === 0
        ? 1
        : Math.min(
            1,
            Math.max(0, (at - this.changedAt) / this.options.transitionMs),
          );
    const eased = f * f * (3 - 2 * f);
    return {
      x: this.origin.x + (this.target.x - this.origin.x) * eased,
      y: this.origin.y + (this.target.y - this.origin.y) * eased,
      width:
        this.origin.width + (this.target.width - this.origin.width) * eased,
      height:
        this.origin.height + (this.target.height - this.origin.height) * eased,
    };
  }

  /** @param {number} at @param {{x:number,y:number}} point @param {any} settings */
  frame(at, point, settings) {
    const chunks = this.settings(settings);
    const margin = chunks.margin;
    let rect;
    if (this.options.camera === "fixed") {
      const [x = 0, y = 0, width = 1, height = 1] = this.options.viewBox || [];
      rect = { x, y, width, height };
    } else if (this.options.camera === "fit" && this.bounds) {
      rect = {
        x: this.bounds.minX - margin,
        y: this.bounds.minY - margin,
        width: Math.max(1, this.bounds.maxX - this.bounds.minX + 2 * margin),
        height: Math.max(1, this.bounds.maxY - this.bounds.minY + 2 * margin),
      };
    } else {
      const chunk = chunkRect(chunks, point);
      rect = {
        x: chunk.x - margin,
        y: chunk.y - margin,
        width: chunk.width + 2 * margin,
        height: chunk.height + 2 * margin,
      };
    }
    const target = fitRect(rect, this.options.width / this.options.height);
    if (!this.target) {
      this.target = target;
      this.origin = target;
    }
    if (
      Object.keys(target).some(
        (key) =>
          target[/** @type {keyof Rect} */ (key)] !==
          this.target?.[/** @type {keyof Rect} */ (key)],
      )
    ) {
      this.origin = this.current(at);
      this.target = target;
      this.changedAt = at;
    }
    return { rect: this.current(at), chunks };
  }
}

/** @param {{items:any[],metadata:any}} frame @param {Rect} rect @param {any} chunks @param {Options} options */
export function renderFrameSvg(frame, rect, chunks, options) {
  const dark = frame.metadata.theme === "dark";
  const theme = dark ? "dark" : "light";
  const box = `${rect.x} ${rect.y} ${rect.width} ${rect.height}`;
  const gridX = Math.max(0, rect.x),
    gridY = Math.max(0, rect.y);
  // Explicit world bounds keep filtering visible when the camera is far from
  // the origin or its margins extend into negative coordinates.
  const resources = THEME_SVG_RESOURCES.replace(
    'x="0" y="0" width="100%" height="100%"',
    `x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}"`,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${options.width}" height="${options.height}" viewBox="${box}" data-wbo-theme="${theme}" style="background:${dark ? "#202020" : "#ffffff"}">
${resources}<style>text {font-family:Arial,Helvetica,sans-serif} path,line {stroke-linecap:round;stroke-linejoin:round}</style>
<defs><pattern id="activityChunkGrid" width="${chunks.width}" height="${chunks.height}" patternUnits="userSpaceOnUse"><path d="M ${chunks.width} 0 L 0 0 0 ${chunks.height}" fill="none" stroke="${dark ? "#ffffff" : "#475569"}" stroke-width="8" vector-effect="non-scaling-stroke"/></pattern></defs>
<rect x="${gridX}" y="${gridY}" width="${Math.max(0, rect.x + rect.width - gridX)}" height="${Math.max(0, rect.y + rect.height - gridY)}" fill="url(#activityChunkGrid)"/>
<g id="drawingArea">${frame.items.map(serializeStoredSvgItem).join("")}</g></svg>`;
}

/** @param {Options} options */
function validateOptions(options) {
  for (const key of [
    "width",
    "height",
    "fps",
    "maxArchiveBytes",
    "maxJsonBytes",
  ]) {
    const n = options[/** @type {"width"} */ (key)];
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`Invalid ${key}`);
  }
  if (
    options.width > 7680 ||
    options.height > 7680 ||
    options.width % 2 ||
    options.height % 2 ||
    options.fps > 120
  )
    throw new Error(
      "Resolution must be even and at most 7680 per side; FPS must be 1–120",
    );
  if (
    !Number.isFinite(options.speed) ||
    options.speed <= 0 ||
    options.speed > 1000 ||
    !Number.isFinite(options.transitionMs) ||
    options.transitionMs < 0 ||
    options.transitionMs > 10000
  )
    throw new Error("Invalid playback speed or transition");
  for (const key of ["chunkWidth", "chunkHeight", "margin"]) {
    const n = options[/** @type {"margin"} */ (key)];
    if (
      n !== undefined &&
      (!Number.isSafeInteger(n) ||
        n < (key === "margin" ? 0 : 100) ||
        n > 100000)
    )
      throw new Error("Invalid chunk geometry");
  }
  if (!["latest", "fixed", "fit"].includes(options.camera))
    throw new Error("Invalid camera mode");
  if (
    options.camera === "fixed" &&
    (!Array.isArray(options.viewBox) ||
      options.viewBox.length !== 4 ||
      options.viewBox.some((n) => !Number.isFinite(n) || Math.abs(n) > 1e9) ||
      (options.viewBox[2] || 0) <= 0 ||
      (options.viewBox[3] || 0) <= 0)
  )
    throw new Error("Fixed camera requires --view-box X Y WIDTH HEIGHT");
  if (
    options.initialPoint &&
    (options.initialPoint.length !== 2 ||
      options.initialPoint.some((n) => !Number.isFinite(n) || n < 0 || n > 1e9))
  )
    throw new Error("Invalid initial camera point");
  if (path.extname(options.output).toLowerCase() !== ".mp4")
    throw new Error("Output must have an .mp4 extension");
}

/** @param {Options} options @param {AbortSignal} [signal] @param {(progress:{frame:number,total:number}) => void} [progress] */
export async function renderVideo(options, signal, progress = () => {}) {
  validateOptions(options);
  if (
    options.audio !== undefined &&
    (!Array.isArray(options.audio) || options.audio.length > 32)
  )
    throw new Error("At most 32 audio recordings may be supplied");
  const recordings = await Promise.all(
    [...new Set(options.audio || [])].map(readRecording),
  );
  try {
    await stat(options.output);
    throw new Error("Output file already exists");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT")
      throw error;
  }
  const snapshot = JSON.parse(
    await readCompressed(
      options.snapshot,
      options.maxArchiveBytes,
      options.maxJsonBytes,
    ),
  );
  const model = await compileReplay(
    snapshot,
    readHistoryLines(
      options.history,
      options.maxArchiveBytes,
      options.maxJsonBytes,
    ),
    options,
  );
  if (options.initialPoint)
    model.initialPoint = {
      x: options.initialPoint[0] || 0,
      y: options.initialPoint[1] || 0,
    };
  const count =
    Math.ceil(
      ((model.videoEnd - model.videoStart) * options.fps) /
        (1000 * options.speed),
    ) + 1;
  if (!Number.isSafeInteger(count) || count > 10000000)
    throw new Error(
      "Replay exceeds ten million frames; use a shorter history or higher speed",
    );
  const directory = await mkdtemp(
    path.join(path.dirname(path.resolve(options.output)), ".wbo-video-"),
  );
  const temporary = path.join(directory, "video.mp4");
  const player = new ReplayPlayer(model);
  const camera = new ReplayCamera(options, model.bounds);
  /** @type {import("playwright").Browser | undefined} */
  let browser;
  /** @type {import("node:child_process").ChildProcessWithoutNullStreams | undefined} */
  let encoder;
  /** @type {Promise<number | null> | undefined} */
  let completed;
  let encoderError = "";
  const abort = () => {
    encoder?.kill("SIGKILL");
    void browser?.close().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    const audio = await audioArguments(
      recordings,
      model.videoStart,
      model.videoEnd,
      options.speed,
      count / options.fps,
      directory,
      signal,
    );
    browser = await chromium.launch({
      headless: true,
      ...(options.chromium && { executablePath: options.chromium }),
    });
    const context = await browser.newContext({
      viewport: { width: options.width, height: options.height },
      deviceScaleFactor: 1,
      javaScriptEnabled: false,
    });
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    await page.setContent(
      "<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\"><style>html,body{margin:0;overflow:hidden}svg{display:block}</style><body></body>",
    );
    encoder = spawn(
      options.ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-n",
        "-f",
        "image2pipe",
        "-framerate",
        String(options.fps),
        "-vcodec",
        "png",
        "-i",
        "pipe:0",
        ...audio.inputs,
        ...audio.output,
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        temporary,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const child = encoder;
    child.stderr.on("data", (data) => {
      encoderError = (encoderError + data.toString()).slice(-16384);
    });
    child.stdout.resume();
    child.stdin.on("error", () => {});
    completed = new Promise((resolve) => {
      child.once("error", (error) => {
        encoderError = error.message;
        resolve(-1);
      });
      child.once("close", resolve);
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", () => resolve(undefined));
      child.once("error", reject);
    });
    let lastProgress = 0;
    for (let i = 0; i < count; i++) {
      signal?.throwIfAborted();
      if (child.exitCode !== null || child.stdin.destroyed)
        throw new Error(`ffmpeg failed: ${encoderError}`);
      const at = Math.min(
        model.videoEnd,
        model.videoStart + (i * 1000 * options.speed) / options.fps,
      );
      const frame = player.frame(at);
      const view = camera.frame(at, frame.point, frame.metadata.chunks);
      const svg = renderFrameSvg(frame, view.rect, view.chunks, options);
      await page.evaluate((html) => {
        document.body.innerHTML = html;
      }, svg);
      const png = await page.screenshot({
        type: "png",
        animations: "disabled",
        timeout: 30000,
      });
      await new Promise((resolve, reject) =>
        child.stdin.write(png, (error) =>
          error
            ? reject(
                new Error(`ffmpeg failed: ${encoderError || error.message}`),
              )
            : resolve(undefined),
        ),
      );
      if (Date.now() - lastProgress >= 1000) {
        progress({ frame: i + 1, total: count });
        lastProgress = Date.now();
      }
    }
    child.stdin.end();
    if ((await completed) !== 0)
      throw new Error(`ffmpeg failed: ${encoderError}`);
    // Publish only a complete video, without overwriting a concurrently created file.
    await link(temporary, path.resolve(options.output));
    return {
      frames: count,
      incompleteStrokes: model.incompleteStrokes,
      audioSources: audio.used,
    };
  } finally {
    signal?.removeEventListener("abort", abort);
    if (encoder && encoder.exitCode === null) encoder.kill("SIGKILL");
    await completed;
    await browser?.close().catch(() => {});
    player.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  try {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 65536) throw new Error("Invalid renderer options");
    }
    const result = await renderVideo(
      JSON.parse(input),
      controller.signal,
      (progress) => process.stdout.write(`${JSON.stringify(progress)}\n`),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
