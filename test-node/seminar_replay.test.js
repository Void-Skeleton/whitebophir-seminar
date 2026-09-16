// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-16: offline replay, validation and actual MP4 output.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { gzipSync } = require("node:zlib");
const test = require("node:test");
const {
  compileReplay,
  readCompressed,
  readHistoryLines,
  ReplayPlayer,
} = require("../scripts/seminar_replay.mjs");
const run = promisify(execFile);
const snapshot = {
  format: "whitebophir-board",
  version: 1,
  items: [],
  chunks: { width: 100, height: 100, margin: 10, viewMode: "latest" },
  replay: {
    board: "seminar",
    atMs: 1000,
    seq: 0,
    point: { x: 0, y: 0 },
    emptyPencils: [],
  },
};
/** @param {any[]} records @param {number} [from] @param {number} [to] */
function log(records, from = 1000, to = 2100) {
  return `${[
    {
      format: "whitebophir-history",
      version: 1,
      board: "seminar",
      from,
      to,
      availableFrom: 1000,
      timeUnit: "unix-ms",
      interval: "inclusive",
    },
    ...records,
  ]
    .map((row) => JSON.stringify(row))
    .join("\n")}\n`;
}
/** @param {number} atMs @param {number} seq @param {any} mutation */
const edit = (atMs, seq, mutation) => ({
  kind: "mutation",
  atMs,
  seq,
  mutation,
});
const pencil = { tool: 1, type: 1, id: "p1", color: "#000000", size: 10 };
const records = [
  edit(1100, 1, pencil),
  edit(1110, 2, { tool: 1, type: 4, parent: "p1", x: 20, y: 50 }),
  edit(1200, 3, { tool: 1, type: 4, parent: "p1", x: 40, y: 50 }),
  edit(1400, 4, { tool: 1, type: 4, parent: "p1", x: 220, y: 50 }),
  { kind: "stroke", id: "p1", startAtMs: 1100, endAtMs: 2100, atMs: 2100 },
];

test("replay uses distance-based stroke speed, preserves a partial snapshot and includes the final frame", async () => {
  const player = new ReplayPlayer(await compileReplay(snapshot, log(records)));
  try {
    assert.equal(player.frame(1000).items.length, 0);
    assert.deepEqual(player.frame(1600).items[0]?._children.at(-1), {
      x: 120,
      y: 50,
    });
    assert.deepEqual(player.frame(2100).items[0]?._children.at(-1), {
      x: 220,
      y: 50,
    });
    assert.throws(() => player.frame(1500), /chronological/);
  } finally {
    player.dispose();
  }
  const partial = {
    ...snapshot,
    items: [
      {
        id: pencil.id,
        color: pencil.color,
        size: pencil.size,
        tool: "pencil",
        _children: [
          { x: 20, y: 50 },
          { x: 40, y: 50 },
        ],
      },
    ],
    replay: { ...snapshot.replay, atMs: 1200, seq: 3 },
  };
  const tail = new ReplayPlayer(await compileReplay(partial, log(records)));
  try {
    assert.deepEqual(tail.frame(1200).items[0]?._children.at(-1), {
      x: 40,
      y: 50,
    });
    assert.deepEqual(tail.frame(1650).items[0]?._children.at(-1), {
      x: 130,
      y: 50,
    });
  } finally {
    tail.dispose();
  }
});

test("video intervals replay earlier edits and keep the original stroke timing across a cut", async () => {
  const model = await compileReplay(snapshot, log(records), {
    startMs: 1600,
    endMs: 1800,
  });
  assert.equal(model.videoStart, 1600);
  assert.equal(model.videoEnd, 1800);
  const player = new ReplayPlayer(model);
  try {
    assert.deepEqual(
      player.frame(model.videoStart).items[0]?._children.at(-1),
      { x: 120, y: 50 },
    );
    assert.deepEqual(player.frame(model.videoEnd).items[0]?._children.at(-1), {
      x: 160,
      y: 50,
    });
  } finally {
    player.dispose();
  }
  const completed = {
    ...snapshot,
    items: [
      {
        id: "p1",
        tool: "pencil",
        color: "#000000",
        size: 10,
        _children: [
          { x: 20, y: 50 },
          { x: 40, y: 50 },
          { x: 220, y: 50 },
        ],
      },
    ],
    replay: { ...snapshot.replay, atMs: 2100, seq: 4 },
  };
  const last = await compileReplay(completed, log(records), {
    startMs: 2100,
    endMs: 2100,
  });
  assert.equal(last.events.length, 0);
  const legacy = /** @type {any} */ ({ ...completed });
  delete legacy.replay;
  assert.equal(
    (await compileReplay(legacy, log(records), { snapshotAtMs: 2100 })).start,
    2100,
  );
  for (const range of [
    { startMs: 999 },
    { endMs: 2101 },
    { startMs: 1700, endMs: 1600 },
    { startMs: NaN },
    { snapshotAtMs: 1200 },
  ])
    await assert.rejects(
      compileReplay(snapshot, log(records), range),
      /timestamp|snapshot|video start/i,
    );
  await assert.rejects(
    compileReplay(
      { ...completed, replay: { ...completed.replay, seq: 3 } },
      log(records),
    ),
    /sequence mismatch/,
  );
});

test("history streaming enforces byte limits, preserves split UTF-8, and closes on early validation failure", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "wbo-stream-history-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, "history.gz");
  const rows = [
    JSON.stringify({ text: "中文".repeat(20000) }),
    JSON.stringify({ text: "尾部" }),
  ];
  const text = `${rows.join("\n")}\n`;
  const data = gzipSync(text);
  await fs.writeFile(input, data);
  /** @param {AsyncIterable<string>} lines */
  const collect = async (lines) => {
    const result = [];
    for await (const line of lines) result.push(line);
    return result;
  };
  assert.deepEqual(
    await collect(
      readHistoryLines(input, data.length, Buffer.byteLength(text)),
    ),
    rows,
  );
  await assert.rejects(
    collect(readHistoryLines(input, data.length - 1, Buffer.byteLength(text))),
    /compressed limit/,
  );
  await assert.rejects(
    collect(readHistoryLines(input, data.length, Buffer.byteLength(text) - 1)),
    /decompressed limit/,
  );
  let closed = false;
  async function* invalidInterval() {
    try {
      yield log([]).split("\n")[0] || "";
      yield "unread";
    } finally {
      closed = true;
    }
  }
  await assert.rejects(
    compileReplay(snapshot, invalidInterval(), { startMs: 999 }),
    /video start/,
  );
  assert.equal(closed, true);
});

test("history and replay defaults have headroom for two hours at 240 points per second", async () => {
  const code =
    'import sys, json, argparse; sys.path.insert(0, "scripts"); import seminar_video, seminar_common; p=argparse.ArgumentParser(); seminar_video.add_parser(p.add_subparsers(), []); a=p.parse_args(["replay", "out.mp4", "--snapshot", "in.wbo", "--history", "in.gz"]); print(json.dumps([a.max_archive_bytes,a.max_json_bytes,seminar_common.MAX_HISTORY_BYTES,seminar_common.MAX_HISTORY_JSON_BYTES]))';
  const limits = JSON.parse((await run("python3", ["-c", code])).stdout);
  assert.equal(limits[0], limits[2]);
  assert.equal(limits[1], limits[3]);
  // 1,728,000 points + 3,600 creates + 3,600 completions. Budget 512 bytes
  // per JSON record, over twice the measured 221-byte average.
  assert.ok(limits[1] > (240 * 7200 + 7200) * 512);
  assert.ok(limits[0] > 49444174 * 4); // Four times the measured gzip size.
});

test("replay handles empty Pencil context, inclusive start, transforms, copies, text, delete, clear and settings", async () => {
  const base = {
    ...snapshot,
    replay: {
      ...snapshot.replay,
      seq: 1,
      emptyPencils: [
        { id: "p1", tool: "pencil", color: "#000000", size: 10, _children: [] },
      ],
    },
  };
  const changes = [
    edit(1000, 1, pencil),
    edit(1050, 2, { tool: 1, type: 4, parent: "p1", x: 20, y: 50 }),
    { kind: "stroke", id: "p1", startAtMs: 1000, endAtMs: 1100, atMs: 1100 },
    edit(1200, 3, {
      tool: 7,
      _children: [
        {
          type: 2,
          id: "p1",
          transform: { a: 1, b: 0, c: 0, d: 1, e: 200, f: 0 },
        },
        { type: 7, id: "p1", newid: "p2" },
      ],
    }),
    edit(1300, 4, {
      tool: 5,
      type: 1,
      id: "t1",
      color: "#000000",
      size: 20,
      x: 100,
      y: 100,
    }),
    edit(1400, 5, {
      tool: 5,
      type: 2,
      id: "t1",
      txt: '<script>alert("unsafe")</script>中文',
    }),
    {
      kind: "settings",
      atMs: 1500,
      metadata: {
        theme: "dark",
        chunks: {
          width: 200,
          height: 100,
          margin: 20,
          viewMode: "free",
          revision: "r",
          point: { x: 300, y: 100 },
        },
      },
    },
    edit(1600, 6, { tool: 6, type: 3, id: "p1" }),
    edit(1800, 7, { tool: 11, type: 6 }),
  ];
  const player = new ReplayPlayer(await compileReplay(base, log(changes)));
  try {
    assert.equal(player.frame(1000).items[0]?._children.length, 0);
    const copied = player.frame(1200);
    assert.deepEqual(
      copied.items.map((item) => item.id),
      ["p1", "p2"],
    );
    assert.equal(copied.items[1]?.transform.e, 200);
    const changed = player.frame(1600);
    assert.deepEqual(
      changed.items.map((item) => item.id),
      ["p2", "t1"],
    );
    assert.equal(changed.metadata.theme, "dark");
    assert.equal(changed.metadata.chunks?.width, 200);
    assert.match(changed.items[1]?.txt, /中文/);
    assert.deepEqual(player.frame(2100).items, []);
  } finally {
    player.dispose();
  }
});

test("replay rejects mismatched, incomplete or malicious archives before rendering", async () => {
  await assert.rejects(
    compileReplay(
      { ...snapshot, replay: { ...snapshot.replay, atMs: 999 } },
      log(records),
    ),
    /does not match/,
  );
  await assert.rejects(
    compileReplay(snapshot, log([records[0], records[2]])),
    /sequence gap/,
  );
  await assert.rejects(
    compileReplay(snapshot, log([...records].reverse())),
    /out of order/,
  );
  await assert.rejects(
    compileReplay(
      snapshot,
      log([edit(1100, 1, { ...pencil, color: 'url("https://example.org")' })]),
    ),
    /mutation/,
  );
  await assert.rejects(
    compileReplay(
      snapshot,
      log([edit(1100, 1, { tool: 1, type: 4, parent: "missing", x: 1, y: 1 })]),
    ),
    /mismatch/,
  );
  await assert.rejects(
    compileReplay(
      snapshot,
      log([
        {
          kind: "stroke",
          id: "p1",
          startAtMs: 2000,
          endAtMs: 1100,
          atMs: 2100,
        },
      ]),
    ),
    /interval/,
  );
});

test("camera follows chunks smoothly, honors geometry overrides, and supports fixed and fit views", async () => {
  const { ReplayCamera } = await import("../scripts/seminar_render.mjs");
  const options = {
    width: 320,
    height: 240,
    camera: "latest",
    transitionMs: 240,
    margin: 0,
    chunkWidth: 100,
    chunkHeight: 100,
  };
  const camera = new ReplayCamera(/** @type {any} */ (options), null);
  const first = camera.frame(1000, { x: 20, y: 20 }, null).rect;
  assert.deepEqual(camera.frame(1100, { x: 220, y: 20 }, null).rect, first);
  const middle = camera.frame(1220, { x: 220, y: 20 }, null).rect;
  assert.ok(middle.x > first.x && middle.x < first.x + 200);
  assert.equal(
    camera.frame(1340, { x: 220, y: 20 }, null).rect.x,
    first.x + 200,
  );
  const fixed = new ReplayCamera(
    /** @type {any} */ ({
      ...options,
      camera: "fixed",
      viewBox: [0, 0, 320, 240],
    }),
    null,
  );
  assert.deepEqual(fixed.frame(0, { x: 1000, y: 1000 }, null).rect, {
    x: 0,
    y: 0,
    width: 320,
    height: 240,
  });
  const fit = new ReplayCamera(
    /** @type {any} */ ({ ...options, camera: "fit" }),
    { minX: 10, minY: 20, maxX: 500, maxY: 300 },
  );
  const view = fit.frame(0, { x: 0, y: 0 }, null).rect;
  assert.ok(
    view.x <= 10 &&
      view.y <= 20 &&
      view.x + view.width >= 500 &&
      view.y + view.height >= 300,
  );
});

test("checkpoints replace the canvas at their timestamp and compressed inputs are bounded", async (t) => {
  const {
    serializeStoredSvgItem,
  } = require("../server/persistence/stored_svg_item_codec.mjs");
  const shape = {
    id: "rect",
    tool: "rectangle",
    color: "#123456",
    size: 10,
    x: 10,
    y: 10,
    x2: 100,
    y2: 100,
  };
  const changes = [
    ...records.slice(0, -1),
    {
      kind: "checkpoint",
      atMs: 1500,
      seq: 10,
      metadata: { theme: "dark" },
      svg: `<svg><g id="drawingArea">${serializeStoredSvgItem(shape)}</g></svg>`,
    },
    edit(1600, 11, {
      tool: 3,
      type: 2,
      id: "rect",
      x: 10,
      y: 10,
      x2: 200,
      y2: 100,
    }),
  ];
  const player = new ReplayPlayer(await compileReplay(snapshot, log(changes)));
  try {
    assert.equal(player.frame(1400).items[0]?.id, "p1");
    assert.deepEqual(
      player.frame(1500).items.map((item) => item.id),
      ["rect"],
    );
    const frame = player.frame(1600);
    assert.equal(frame.items[0]?.x2, 200);
    assert.equal(frame.metadata.theme, "dark");
  } finally {
    player.dispose();
  }
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "wbo-replay-limits-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, "large.gz");
  await fs.writeFile(input, gzipSync("x".repeat(4096)));
  await assert.rejects(readCompressed(input, 1, 8192), /compressed limit/);
  await assert.rejects(readCompressed(input, 1024, 100), /larger than|buffer/i);
});

test("Python replay exports a real MP4 with progressive strokes, white dark-mode borders, final state and no overwrite", {
  timeout: 60000,
}, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wbo-video-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const snap = path.join(directory, "saved board.wbo"),
    history = path.join(directory, "history.jsonl.gz"),
    video = path.join(directory, "replay video.mp4");
  await fs.writeFile(snap, gzipSync(JSON.stringify(snapshot)));
  const historyRecords = [
    ...records.slice(0, -1),
    { kind: "settings", atMs: 1800, metadata: { theme: "dark" } },
    records[records.length - 1],
  ];
  await fs.writeFile(history, gzipSync(log(historyRecords)));
  const args = [
    "scripts/seminar_helper.py",
    "replay",
    video,
    "--snapshot",
    snap,
    "--history",
    history,
    "--resolution",
    "320x240",
    "--fps",
    "10",
    "--camera",
    "fixed",
    "--view-box",
    "0",
    "0",
    "320",
    "240",
    "--chunk-width",
    "100",
    "--chunk-height",
    "100",
    "--lang",
    "zh-TW",
  ];
  const result = await run("python3", args, {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.match(result.stdout, /已將 12 影格/);
  const probe = JSON.parse(
    (
      await run("ffprobe", [
        "-v",
        "error",
        "-show_streams",
        "-of",
        "json",
        video,
      ])
    ).stdout,
  ).streams[0];
  assert.equal(probe.width, 320);
  assert.equal(probe.height, 240);
  assert.equal(probe.nb_frames, "12");
  const raw = (
    await run(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        video,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      { encoding: "buffer", maxBuffer: 5 * 1024 * 1024 },
    )
  ).stdout;
  /** @param {number} frame @param {number} x @param {number} y */
  const pixel = (frame, x, y) =>
    raw[(frame * 320 * 240 + y * 320 + x) * 3] || 0;
  assert.ok(pixel(0, 70, 50) > 240);
  assert.ok(pixel(6, 70, 50) < 20); // Halfway along the path.
  assert.ok(pixel(6, 180, 50) > 240); // Future part is still hidden.
  assert.ok(pixel(11, 180, 50) > 240); // Completed stroke is white in dark mode.
  assert.ok(pixel(11, 70, 70) >= 25 && pixel(11, 70, 70) <= 40);
  assert.ok(pixel(11, 100, 130) > 230); // Chunk border stays white.
  const partialFile = path.join(directory, "partial.wbo");
  await fs.writeFile(
    partialFile,
    gzipSync(
      JSON.stringify({
        ...snapshot,
        items: [
          {
            id: "p1",
            tool: "pencil",
            color: "#000000",
            size: 10,
            _children: [
              { x: 20, y: 50 },
              { x: 40, y: 50 },
            ],
          },
        ],
        replay: { ...snapshot.replay, atMs: 1200, seq: 3 },
      }),
    ),
  );
  const clipped = path.join(directory, "clipped.mp4");
  const clipArgs = args.map((arg) =>
    arg === video ? clipped : arg === snap ? partialFile : arg,
  );
  const clipResult = await run("python3", [
    ...clipArgs,
    "--start",
    "1970-01-01T00:00:01.650Z",
    "--end",
    "1800",
  ]);
  assert.match(clipResult.stdout, /已將 3 影格/);
  const clipPixels = (
    await run(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        clipped,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      { encoding: "buffer", maxBuffer: 1024 * 1024 },
    )
  ).stdout;
  /** @param {number} frame @param {number} x */
  const clipPixel = (frame, x) =>
    clipPixels[(frame * 320 * 240 + 50 * 320 + x) * 3] || 0;
  assert.equal(clipPixels.length, 3 * 320 * 240 * 3);
  assert.ok(clipPixel(0, 120) < 20); // Warmed up past the snapshot before first frame.
  assert.ok(clipPixel(0, 180) > 240);
  assert.ok(clipPixel(2, 140) > 240); // Theme change at the exact end is included.
  assert.ok(clipPixel(2, 180) < 45); // Cutting must not accelerate the remaining stroke.
  await assert.rejects(
    run("python3", [
      ...clipArgs.map((arg) =>
        arg === clipped ? path.join(directory, "invalid.mp4") : arg,
      ),
      "--start",
      "1100",
    ]),
    /video start/,
  );
  const before = await fs.readFile(video);
  await assert.rejects(run("python3", args), /已存在/);
  assert.deepEqual(await fs.readFile(video), before);
  const failed = args.map((value) =>
    value === video ? path.join(directory, "failed.mp4") : value,
  );
  await assert.rejects(
    run("python3", [
      ...failed,
      "--ffmpeg",
      path.join(directory, "missing-ffmpeg"),
    ]),
    /ENOENT/,
  );
  assert.equal(
    (await fs.readdir(directory)).some(
      (name) => name.startsWith(".wbo-video-") || name === "failed.mp4",
    ),
    false,
  );
  const { renderVideo } = await import("../scripts/seminar_render.mjs");
  const controller = new AbortController();
  const cancelled = path.join(directory, "cancelled.mp4");
  await assert.rejects(
    renderVideo(
      {
        snapshot: snap,
        history,
        output: cancelled,
        width: 320,
        height: 240,
        fps: 10,
        speed: 1,
        camera: "latest",
        transitionMs: 240,
        ffmpeg: "ffmpeg",
        maxArchiveBytes: 1000000,
        maxJsonBytes: 1000000,
      },
      controller.signal,
      () => controller.abort(),
    ),
    /abort/i,
  );
  assert.equal(
    (await fs.readdir(directory)).some(
      (name) => name.startsWith(".wbo-video-") || name === "cancelled.mp4",
    ),
    false,
  );
});
