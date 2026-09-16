// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-16: clock, durable capture and audible replay alignment.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { promisify } = require("node:util");
const { execFile, spawn } = require("node:child_process");
const { gzipSync } = require("node:zlib");
const http = require("node:http");
const { createServerApp } = require("../server/server.mjs");
const {
  createConfig,
  closeServer,
  getTcpAddress,
} = require("./test_helpers.js");
const {
  readRecording,
  audioArguments,
} = require("../scripts/seminar_audio_mix.mjs");
const run = promisify(execFile);

/** @param {import("node:test").TestContext} t */
async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wbo-audio-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("portable audio clock, discovery, TUI, localization and native packet tests", async () => {
  await run("python3", ["test-node/seminar_audio_test.py"]);
});

test("clock endpoint supports base paths and recorder streams separate, synchronized files", {
  timeout: 30000,
}, async (t) => {
  const directory = await temporary(t);
  const server = await createServerApp(
    createConfig({
      HOST: "127.0.0.1",
      PORT: 0,
      BASE_PATH: "/wbo",
      HISTORY_DIR: directory,
      AUTH_SECRET_KEY: "private-instance",
    }),
    { logStarted: false },
  );
  t.after(() => closeServer(server));
  // WBO_BASE_PATH deployments use a proxy that strips the public prefix.
  const proxy = http.createServer((request, response) => {
    const upstream = http.request(
      {
        hostname: "127.0.0.1",
        port: getTcpAddress(server).port,
        method: request.method,
        path: (request.url || "/").slice(4),
        headers: request.headers,
      },
      (result) => {
        response.writeHead(result.statusCode || 500, result.headers);
        result.pipe(response);
      },
    );
    upstream.on("error", () => response.destroy());
    request.pipe(upstream);
  });
  await new Promise((resolve) =>
    proxy.listen(0, "127.0.0.1", () => resolve(undefined)),
  );
  t.after(() => closeServer(proxy));
  const url = `http://127.0.0.1:${getTcpAddress(proxy).port}/wbo`;
  const before = Date.now();
  const response = await fetch(`${url}/time?nonce=123`);
  const value = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(value.now >= before && value.now <= Date.now());
  assert.equal((await fetch(`${url}/time`, { method: "POST" })).status, 405);
  for (const query of ["?nonce=a&nonce=b", "?unknown=x", "?nonce=%00"])
    assert.equal((await fetch(`${url}/time${query}`)).status, 400);
  const parec = path.join(directory, "synthetic-parec");
  await fs.writeFile(
    parec,
    `#!/usr/bin/env python3
import sys, time
while True:
    sys.stdout.buffer.write(b'\\x10\\x00\\x10\\x00'*960)
    sys.stdout.buffer.flush()
    time.sleep(0.02)
`,
    { mode: 0o700 },
  );
  const output = path.join(directory, "session");
  const result = await run("python3", [
    "scripts/seminar_helper.py",
    "record",
    output,
    "--server",
    url,
    "--source",
    "synthetic-one",
    "--source",
    "synthetic-two",
    "--parec",
    parec,
    "--duration",
    "6",
    "--sync-interval",
    "5",
  ]);
  assert.match(result.stdout, /Saved 2 source recordings/);
  const clocks = (await fs.readFile(path.join(output, "clock.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(clocks.length >= 2);
  for (const name of ["source-001", "source-002"]) {
    const recording = await readRecording(
      path.join(output, `${name}.audio.jsonl`),
    );
    assert.ok(recording.frames > 48000 * 4);
    assert.equal(recording.encoding, "opus");
    assert.ok(
      (await fs.stat(recording.file)).size < (recording.frames * 4) / 15,
    );
    assert.ok(recording.anchors.length >= 5);
    assert.ok((recording.anchors[0]?.atMs || 0) >= before - 100);
  }
  await assert.rejects(
    run("python3", [
      "scripts/seminar_helper.py",
      "record",
      output,
      "--server",
      url,
      "--source",
      "synthetic-one",
      "--parec",
      parec,
      "--duration",
      "1",
    ]),
    /exists/,
  );
});

/** @param {string} directory @param {string} name @param {number} from @param {number} duration @param {number} hz @param {boolean} [compressed] */
async function tone(directory, name, from, duration, hz, compressed = false) {
  const frames = Math.round(duration * 48);
  const pcm = Buffer.alloc(frames * 4);
  for (let frame = 0; frame < frames; frame++) {
    const sample = Math.round(
      4000 * Math.sin((2 * Math.PI * hz * frame) / 48000),
    );
    pcm.writeInt16LE(sample, frame * 4);
    pcm.writeInt16LE(sample, frame * 4 + 2);
  }
  await fs.writeFile(path.join(directory, `${name}.pcm`), pcm);
  if (compressed) {
    await run("ffmpeg", [
      "-v",
      "error",
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-i",
      path.join(directory, `${name}.pcm`),
      "-c:a",
      "libopus",
      "-b:a",
      "64k",
      "-vbr",
      "off",
      "-page_duration",
      "100000",
      path.join(directory, `${name}.opus`),
    ]);
    await fs.unlink(path.join(directory, `${name}.pcm`));
  }
  const file = path.join(directory, `${name}.audio.jsonl`);
  await fs.writeFile(
    file,
    `${[
      {
        format: "whitebophir-audio",
        version: compressed ? 2 : 1,
        audio: `${name}.${compressed ? "opus" : "pcm"}`,
        sampleRate: 48000,
        channels: 2,
        encoding: compressed ? "opus" : "s16le",
      },
      { kind: "start", frames: 0, atMs: from },
      {
        kind: "checkpoint",
        frames,
        atMs: from + duration,
        ...(compressed && {
          audioBytes: (await fs.stat(path.join(directory, `${name}.opus`)))
            .size,
        }),
      },
      { kind: "end", frames },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n")}\n`,
  );
  return file;
}

test("audio journals recover committed prefixes and reject corrupt or unsafe metadata", async (t) => {
  const directory = await temporary(t);
  const file = await tone(directory, "test", 1000, 1000, 440);
  const original = await fs.readFile(file, "utf8");
  await fs.writeFile(
    file,
    `${original.split("\n").slice(0, 3).join("\n")}\n{"kind":`,
  );
  assert.equal((await readRecording(file)).frames, 48000);
  for (const invalid of [
    original.replace('"audio":"test.pcm"', '"audio":"../secret.pcm"'),
    original.replace('"atMs":2000', '"atMs":999'),
    original.replace(/"frames":48000/g, '"frames":48001'),
  ]) {
    await fs.writeFile(file, invalid);
    await assert.rejects(readRecording(file), /format|chronological|shorter/);
  }
});

test("killed Opus recording recovers a durable prefix and rejects corrupt committed audio", {
  timeout: 15000,
}, async (t) => {
  const directory = await temporary(t);
  const file = path.join(directory, "crash.audio.jsonl");
  const child = spawn(
    "python3",
    [
      "-c",
      `
import argparse, math, struct, sys, time
from pathlib import Path
sys.path.insert(0, 'scripts')
from seminar_audio_storage import AudioStorage, write_row
root = Path(sys.argv[1])
args = argparse.Namespace(audio_format='opus', audio_bitrate=64, ffmpeg='ffmpeg')
data = b''.join(struct.pack('<hh', *([int(5000*math.sin(i*2*math.pi*440/48000))]*2)) for i in range(960))
with (root/'crash.opus').open('xb') as output, (root/'crash.audio.jsonl').open('xb') as metadata:
    write_row(metadata, dict(format='whitebophir-audio', version=2, audio='crash.opus', sampleRate=48000, channels=2, encoding='opus'))
    with AudioStorage(output, metadata, args) as storage:
        storage.journal(dict(kind='start', frames=0, atMs=1000))
        for i in range(1000):
            storage.write(data)
            if (i+1)%50 == 0:
                storage.journal(dict(kind='checkpoint', frames=(i+1)*960, atMs=1000+(i+1)*20))
            time.sleep(.02)
`,
      directory,
    ],
    { stdio: "ignore" },
  );
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  t.after(() => {
    child.kill("SIGKILL");
  });
  const deadline = Date.now() + 8000;
  let journal = "";
  while (!journal.includes('"checkpoint"')) {
    assert.ok(
      Date.now() < deadline && child.exitCode === null,
      "encoder should commit while recording",
    );
    journal = await fs.readFile(file, "utf8").catch(() => "");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  child.kill("SIGKILL");
  await exited;
  const crashedJournal = await fs.readFile(file, "utf8");
  const rows = crashedJournal
    .slice(0, crashedJournal.lastIndexOf("\n"))
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(rows.every((row) => row.kind !== "end"));
  const committed = rows.filter((row) => row.kind === "checkpoint").pop();
  const opus = path.join(directory, "crash.opus");
  const original = (await fs.readFile(opus)).subarray(0, committed.audioBytes);
  await fs.writeFile(
    opus,
    Buffer.concat([original, Buffer.from("OggS\0incomplete")]),
  );
  journal = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n{"kind":`;
  await fs.writeFile(file, journal);
  const recording = await readRecording(file);
  assert.ok(recording.frames >= 48000);
  const args = await audioArguments(
    [recording],
    1000,
    committed.atMs,
    1,
    2,
    directory,
  );
  const prefix = path.join(directory, "audio-1.opus");
  assert.deepEqual(await fs.readFile(prefix), original);
  assert.ok(args.inputs.includes(prefix));
  const decoded = (
    await run(
      "ffmpeg",
      ["-v", "error", "-i", prefix, "-f", "s16le", "pipe:1"],
      { encoding: "buffer", maxBuffer: 2 * 1024 * 1024 },
    )
  ).stdout;
  assert.ok(decoded.length >= recording.frames * 4);
  const corrupt = Buffer.from(original);
  corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] || 0) ^ 1;
  await fs.writeFile(opus, corrupt);
  await assert.rejects(readRecording(file), /Ogg Opus/);
  await fs.writeFile(opus, original);
  for (const bad of [original.length - 1, original.length + 1, -1]) {
    await fs.writeFile(
      file,
      journal.replace(
        `"audioBytes":${committed.audioBytes}`,
        `"audioBytes":${bad}`,
      ),
    );
    await assert.rejects(readRecording(file), /committed/);
  }
  await fs.writeFile(
    file,
    journal.replace(`"frames":${committed.frames}`, '"frames":9999999'),
  );
  await assert.rejects(readRecording(file), /shorter/);
});

test("real MP4 audio trims, delays, mixes, ends and changes speed with the video", {
  timeout: 60000,
}, async (t) => {
  const directory = await temporary(t);
  const snapshot = path.join(directory, "snapshot.wbo"),
    history = path.join(directory, "history.gz");
  await fs.writeFile(
    snapshot,
    gzipSync(
      JSON.stringify({ format: "whitebophir-board", version: 1, items: [] }),
    ),
  );
  await fs.writeFile(
    history,
    gzipSync(
      `${JSON.stringify({
        format: "whitebophir-history",
        version: 1,
        board: "audio",
        from: 1000,
        to: 5000,
        availableFrom: 1000,
        timeUnit: "unix-ms",
        interval: "inclusive",
      })}\n`,
    ),
  );
  const early = await tone(directory, "early", 500, 2000, 440, true);
  const late = await tone(directory, "late", 2000, 2000, 880);
  const outside = await tone(directory, "outside", 6000, 1000, 1320, true);
  const video = path.join(directory, "audio.mp4");
  const args = [
    "scripts/seminar_helper.py",
    "replay",
    video,
    "--snapshot",
    snapshot,
    "--history",
    history,
    "--resolution",
    "160x120",
    "--fps",
    "5",
    "--audio",
    early,
    "--audio",
    late,
    "--audio",
    outside,
  ];
  const result = await run("python3", args);
  assert.match(result.stdout, /Mixed 2 overlapping/);
  /** @param {string} file */
  const decode = async (file) =>
    (
      await run(
        "ffmpeg",
        [
          "-v",
          "error",
          "-i",
          file,
          "-vn",
          "-ar",
          "48000",
          "-ac",
          "1",
          "-f",
          "s16le",
          "pipe:1",
        ],
        { encoding: "buffer", maxBuffer: 2 * 1024 * 1024 },
      )
    ).stdout;
  /** @param {Buffer} pcm @param {number} seconds @param {number} frequency */
  function magnitude(pcm, seconds, frequency) {
    const start = Math.round(seconds * 48000),
      length = 4800;
    let real = 0,
      imaginary = 0;
    for (let i = 0; i < length; i++) {
      const sample = pcm.readInt16LE((start + i) * 2);
      real += sample * Math.cos((2 * Math.PI * frequency * i) / 48000);
      imaginary += sample * Math.sin((2 * Math.PI * frequency * i) / 48000);
    }
    return Math.hypot(real, imaginary) / length;
  }
  const pcm = await decode(video);
  assert.ok(magnitude(pcm, 0.2, 440) > 1000); // Clip audio that began before video.
  assert.ok(magnitude(pcm, 0.2, 880) < 30); // Late source is still silent.
  assert.ok(magnitude(pcm, 1.2, 440) > 1000 && magnitude(pcm, 1.2, 880) > 1000); // Mixed overlap.
  assert.ok(magnitude(pcm, 2.2, 440) < 30 && magnitude(pcm, 2.2, 880) > 1000); // Early source ended.
  assert.ok(magnitude(pcm, 3.5, 880) < 30); // All sources ended, video continues.
  assert.ok(magnitude(pcm, 0.2, 1320) < 30); // Outside recording was ignored.
  const fast = path.join(directory, "fast.mp4");
  await run("python3", [
    ...args.map((arg) => (arg === video ? fast : arg)),
    "--speed",
    "2",
  ]);
  const fastPcm = await decode(fast);
  assert.ok(magnitude(fastPcm, 0.2, 440) > 1000); // Pitch stays unchanged.
  assert.ok(magnitude(fastPcm, 0.6, 880) > 1000);
  assert.ok(magnitude(fastPcm, 1.8, 880) < 30);
});

test("encoded audio corrects clock drift and preserves capture gaps", async (t) => {
  const directory = await temporary(t);
  const file = await tone(directory, "drift", 1000, 3000, 440, true);
  const recording = await readRecording(file);
  recording.anchors = [
    { frames: 0, atMs: 1000 },
    { frames: 48000, atMs: 2010 },
    { frames: 48000, atMs: 3010 },
    { frames: 144000, atMs: 5030 },
  ];
  const result = await audioArguments(
    [recording],
    1000,
    5030,
    1,
    4.2,
    directory,
  );
  assert.equal(result.used, 1);
  const video = path.join(directory, "gap.mp4");
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=s=16x16:r=5:d=4.2",
    ...result.inputs,
    ...result.output,
    "-c:v",
    "libx264",
    video,
  ]);
  const pcm = (
    await run(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        video,
        "-vn",
        "-ar",
        "48000",
        "-ac",
        "1",
        "-f",
        "s16le",
        "pipe:1",
      ],
      { encoding: "buffer", maxBuffer: 1024 * 1024 },
    )
  ).stdout;
  /** @param {number} seconds */
  const energy = (seconds) => {
    let sum = 0;
    for (let i = 0; i < 2400; i++)
      sum += pcm.readInt16LE((Math.round(seconds * 48000) + i) * 2) ** 2;
    return Math.sqrt(sum / 2400);
  };
  assert.ok(energy(0.3) > 1000);
  assert.ok(energy(1.4) < 10); // The missing second is silence, not concatenated audio.
  assert.ok(energy(2.4) > 1000);
  assert.ok(energy(3.96) > 1000); // Corrected audio still reaches the mapped end.
  assert.ok(energy(4.1) < 10);
});
