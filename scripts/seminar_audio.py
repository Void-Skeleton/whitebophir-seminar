"""Per-source streamed audio capture and server clock calibration.

SPDX-License-Identifier: AGPL-3.0-or-later
Seminar modifications, 2026-09-16. No third-party Python dependencies.
"""
import json
import math
from pathlib import Path
import signal
import struct
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler
import uuid

from seminar_audio_storage import AudioStorage, check_encoder, write_row

RATE = 48000
FRAME_BYTES = 4


class CaptureProcessError(ValueError):
    """An audio backend exited; distinct from write/metadata failures."""


MESSAGES = {
    "en": {
        "description": "Record separate microphone/application audio with server timestamps (Linux/Windows).",
        "directory": "New output directory; recordings are never overwritten",
        "source": "Microphone/source ID from --list-sources; repeat to select several (default selects the default microphone)",
        "process": "Application PID; repeat to select several (Windows includes child processes)",
        "list": "List available microphones/sources and applications without recording",
        "server": "WBO server URL, including any deployment base path",
        "duration": "Stop after this many seconds; otherwise stop with Ctrl+C",
        "sync": "Clock resampling interval in seconds, 5–3600 (default: 30)",
        "latency": "Requested Linux capture latency in milliseconds, 5–1000 (default: 20)",
        "format": "Audio storage: opus (compressed, default) or pcm (uncompressed)",
        "bitrate": "Opus bitrate in kbps, 16–256 (default: 64)",
        "ffmpeg": "ffmpeg executable with libopus, required for compressed recording",
        "encoder": "Compressed recording requires ffmpeg with libopus; install it, set --ffmpeg, or use --audio-format pcm. {detail}",
        "pactl": "Path to pactl (Linux)", "parec": "Path to parec (Linux)",
        "powershell": "Path to Windows PowerShell or pwsh", "lang": "Help and status language",
        "choose": "Select source numbers separated by commas, r to refresh, or q to cancel: ",
        "select": "Select at least one source. Without a terminal, use --source or --process.",
        "recording": "Recording to {directory}. Press Ctrl+C to stop.",
        "saved": "Saved {count} source recordings in {directory}",
        "failure": "Audio recording failed: {detail}",
        "sync_failed": "Clock refresh failed; continuing with the last calibration: {detail}",
        "sync_ok": "Clock synchronized; estimated network uncertainty ±{ms:.1f} ms.",
        "waiting": "Waiting for audio streams from PID {pid}…",
        "empty": "No audio samples were received; check the selected sources.",
        "invalid": "Invalid capture duration, clock interval, latency, bitrate, or process ID.",
    },
    "zh-CN": {
        "description": "分别录制麦克风和应用音频，并标记服务器时间（Linux/Windows）。",
        "directory": "新建输出目录，不会覆盖已有录音",
        "source": "--list-sources 列出的麦克风或音源 ID；可重复指定（default 为默认麦克风）",
        "process": "应用进程 PID；可重复指定（Windows 包含子进程）",
        "list": "列出可用麦克风、音源和应用，不开始录音",
        "server": "WBO 服务器地址，包含部署子路径",
        "duration": "录制指定秒数后停止；不指定时按 Ctrl+C 停止",
        "sync": "校准服务器时间的间隔秒数，5–3600（默认 30）",
        "latency": "Linux 音频采集请求延迟，5–1000 毫秒（默认 20）",
        "format": "音频存储：opus（压缩，默认）或 pcm（未压缩）",
        "bitrate": "Opus 比特率，16–256 kbps（默认 64）",
        "ffmpeg": "包含 libopus 编码器的 ffmpeg 路径，压缩录音时必需",
        "encoder": "压缩录音需要包含 libopus 的 ffmpeg；请安装、通过 --ffmpeg 指定路径，或使用 --audio-format pcm。{detail}",
        "pactl": "pactl 路径（Linux）", "parec": "parec 路径（Linux）",
        "powershell": "Windows PowerShell 或 pwsh 路径", "lang": "帮助和状态信息的语言",
        "choose": "输入音源编号（逗号分隔），r 刷新，q 取消：",
        "select": "请至少选择一个音源。非交互环境请使用 --source 或 --process。",
        "recording": "正在录制到 {directory}。按 Ctrl+C 停止。",
        "saved": "已将 {count} 个音源的录音保存到 {directory}",
        "failure": "录音失败：{detail}",
        "sync_failed": "时间校准失败，继续使用上次校准结果：{detail}",
        "sync_ok": "时间已校准；估计网络误差为 ±{ms:.1f} 毫秒。",
        "waiting": "正在等待 PID {pid} 的音频流……",
        "empty": "未收到音频采样，请检查所选音源。",
        "invalid": "录制时长、校准间隔、延迟、比特率或进程 ID 无效。",
    },
    "zh-TW": {
        "description": "分別錄製麥克風和應用程式音訊，並標記伺服器時間（Linux/Windows）。",
        "directory": "新建輸出目錄，不會覆寫現有錄音",
        "source": "--list-sources 列出的麥克風或音源 ID；可重複指定（default 為預設麥克風）",
        "process": "應用程式 PID；可重複指定（Windows 包含子程序）",
        "list": "列出可用麥克風、音源和應用程式，不開始錄音",
        "server": "WBO 伺服器位址，包含部署子路徑",
        "duration": "錄製指定秒數後停止；不指定時按 Ctrl+C 停止",
        "sync": "校準伺服器時間的間隔秒數，5–3600（預設 30）",
        "latency": "Linux 音訊擷取要求延遲，5–1000 毫秒（預設 20）",
        "format": "音訊儲存：opus（壓縮，預設）或 pcm（未壓縮）",
        "bitrate": "Opus 位元率，16–256 kbps（預設 64）",
        "ffmpeg": "包含 libopus 編碼器的 ffmpeg 路徑，壓縮錄音時必需",
        "encoder": "壓縮錄音需要包含 libopus 的 ffmpeg；請安裝、透過 --ffmpeg 指定路徑，或使用 --audio-format pcm。{detail}",
        "pactl": "pactl 路徑（Linux）", "parec": "parec 路徑（Linux）",
        "powershell": "Windows PowerShell 或 pwsh 路徑", "lang": "說明和狀態訊息的語言",
        "choose": "輸入音源編號（逗號分隔），r 重新整理，q 取消：",
        "select": "請至少選擇一個音源。非互動環境請使用 --source 或 --process。",
        "recording": "正在錄製到 {directory}。按 Ctrl+C 停止。",
        "saved": "已將 {count} 個音源的錄音儲存到 {directory}",
        "failure": "錄音失敗：{detail}",
        "sync_failed": "時間校準失敗，繼續使用上次校準結果：{detail}",
        "sync_ok": "時間已校準；估計網路誤差為 ±{ms:.1f} 毫秒。",
        "waiting": "正在等待 PID {pid} 的音訊串流……",
        "empty": "未收到音訊取樣，請檢查所選音源。",
        "invalid": "錄製時長、校準間隔、延遲、位元率或程序 ID 無效。",
    },
}


def add_parser(subcommands, argv):
    arguments = list(sys.argv[1:] if argv is None else argv)
    language = "en"
    for i, arg in enumerate(arguments):
        if arg == "--lang" and i + 1 < len(arguments):
            language = arguments[i + 1]
        elif arg.startswith("--lang="):
            language = arg.split("=", 1)[1]
    text = MESSAGES.get(language, MESSAGES["en"])
    parser = subcommands.add_parser("record", help=text["description"], description=text["description"])
    parser.add_argument("directory", type=Path, nargs="?", help=text["directory"])
    parser.add_argument("--server", default="http://localhost:8080", help=text["server"])
    parser.add_argument("--source", action="append", default=[], help=text["source"])
    parser.add_argument("--process", type=int, action="append", default=[], help=text["process"])
    parser.add_argument("--list-sources", action="store_true", help=text["list"])
    parser.add_argument("--duration", type=float, help=text["duration"])
    parser.add_argument("--sync-interval", type=float, default=30, help=text["sync"])
    parser.add_argument("--latency-ms", type=int, default=20, help=text["latency"])
    parser.add_argument("--audio-format", choices=("opus", "pcm"), default="opus", help=text["format"])
    parser.add_argument("--audio-bitrate", type=int, default=64, help=text["bitrate"])
    parser.add_argument("--ffmpeg", default="ffmpeg", help=text["ffmpeg"])
    parser.add_argument("--pactl", default="pactl", help=text["pactl"])
    parser.add_argument("--parec", default="parec", help=text["parec"])
    parser.add_argument("--powershell", default="powershell.exe", help=text["powershell"])
    parser.add_argument("--lang", choices=tuple(MESSAGES), default="en", help=text["lang"])


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class ServerClock:
    """Minimum-RTT clock sample, mapped through a monotonic clock, not local wall time."""
    def __init__(self, server, opener=None, monotonic=time.perf_counter_ns):
        parts = urlsplit(server)
        if (parts.scheme not in ("http", "https") or not parts.netloc or parts.username
                or parts.password or parts.query or parts.fragment):
            raise ValueError("Invalid server URL")
        self.url = urlunsplit((parts.scheme, parts.netloc, parts.path.rstrip("/") + "/time", "", ""))
        self.open = opener or build_opener(NoRedirect).open
        self.monotonic = monotonic
        self.sample = None
        self.lock = threading.Lock()

    def sync(self, samples=5):
        candidates = []
        for _ in range(samples):
            before = self.monotonic()
            request = Request(self.url + "?nonce=" + uuid.uuid4().hex, headers={"Cache-Control": "no-cache"})
            with self.open(request, timeout=5) as response:
                result = json.loads(response.read(4097))
            after = self.monotonic()
            now = result.get("now") if isinstance(result, dict) else None
            if type(now) is not int or not 0 <= now <= 8640000000000000:
                raise ValueError("Invalid server clock response")
            candidates.append({"monoNs": (before + after) // 2, "serverMs": now,
                               "uncertaintyMs": (after - before) / 2000000})
        sample = min(candidates, key=lambda row: row["uncertaintyMs"])
        with self.lock:
            self.sample = sample
        return sample

    def stamp(self, mono_ns):
        with self.lock:
            sample = self.sample
        if sample is None:
            raise ValueError("Server clock has not been calibrated")
        return {"atMs": sample["serverMs"] + (mono_ns - sample["monoNs"]) / 1000000,
                "uncertaintyMs": sample["uncertaintyMs"], "syncMonoNs": sample["monoNs"]}


def command_json(command):
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", timeout=30, check=True)
    if len(result.stdout) > 4 * 1024 * 1024:
        raise ValueError("Audio device listing is too large")
    return json.loads(result.stdout.lstrip("\ufeff"))


def windows_command(args, mode, target="default"):
    return [args.powershell, "-Mta", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-File", str(Path(__file__).with_name("audio") / "windows_capture.ps1"),
            "-Mode", mode, "-Target", str(target)]


def discover(args):
    if sys.platform == "win32":
        result = command_json(windows_command(args, "list"))
        return ([{"kind": "source", **row} for row in result["sources"]]
                + [{"kind": "process", **row} for row in result["processes"]]), []
    if not sys.platform.startswith("linux"):
        raise ValueError("Audio capture supports Linux and Windows")
    sources = command_json([args.pactl, "-f", "json", "list", "sources"])
    streams = command_json([args.pactl, "-f", "json", "list", "sink-inputs"])
    sinks = command_json([args.pactl, "-f", "json", "list", "sinks"])
    source_names = {row["index"]: row["name"] for row in sources if "index" in row}
    monitors = {}
    for sink in sinks:
        # pactl JSON puts the monitor name in monitor_source, unlike the
        # libpulse structure's separate monitor_source_name field.
        monitor = sink.get("monitor_source_name") or sink.get("monitor_source")
        if type(monitor) is int:
            monitor = source_names.get(monitor)
        if isinstance(monitor, str) and monitor:
            monitors[sink["index"]] = monitor
    choices = [{"kind": "source", "id": "default", "name": "@DEFAULT_SOURCE@"}]
    choices += [{"kind": "source", "id": row["name"], "name": row.get("description", row["name"])} for row in sources]
    processes, captures = {}, []
    for row in streams:
        properties = row.get("properties", {})
        pid = str(properties.get("application.process.id", ""))
        if not pid.isdigit() or row.get("sink") not in monitors:
            continue
        name = properties.get("application.name", properties.get("application.process.binary", pid))
        processes[int(pid)] = {"kind": "process", "id": int(pid), "name": name}
        captures.append({"kind": "process", "id": int(pid), "name": name,
                         "stream": row["index"], "device": monitors[row["sink"]]})
    return choices + list(processes.values()), captures


def show_choices(choices):
    for i, source in enumerate(choices, 1):
        # Device/application names are untrusted terminal text.
        name = "".join(c if c.isprintable() else " " for c in str(source["name"]))
        print(f"{i:3}. [{source['kind']} {source['id']}] {name}")


def select_interactively(args, text):
    if not sys.stdin.isatty():
        raise ValueError(text["select"])
    while True:
        choices, _ = discover(args)
        show_choices(choices)
        answer = input(text["choose"]).strip()
        if answer.lower() == "q":
            return False
        if answer.lower() == "r":
            continue
        try:
            indices = {int(part.strip()) - 1 for part in answer.split(",")}
            if not indices or min(indices) < 0 or max(indices) >= len(choices):
                raise ValueError()
            for index in sorted(indices):
                choice = choices[index]
                (args.source if choice["kind"] == "source" else args.process).append(choice["id"])
            return True
        except ValueError:
            print(text["select"], file=sys.stderr)


def read_exact(stream, count):
    chunks = bytearray()
    while len(chunks) < count:
        data = stream.read(count - len(chunks))
        if not data:
            if chunks:
                raise ValueError("Truncated native audio packet")
            return None
        chunks.extend(data)
    return bytes(chunks)


def packets(stream, native, latency_ms):
    if native:
        while True:
            header = read_exact(stream, 16)
            if header is None:
                return
            magic, frames, mono_ns = struct.unpack("<4sIQ", header)
            if magic != b"WBOA" or not 0 < frames <= RATE * 2:
                raise ValueError("Invalid native audio packet")
            data = read_exact(stream, frames * FRAME_BYTES)
            if data is None:
                raise ValueError("Missing native audio samples")
            yield data, mono_ns
    else:
        pending = b""
        while True:
            data = stream.read1(8192)
            received = time.perf_counter_ns()
            if not data:
                if pending:
                    raise ValueError("Incomplete PCM sample frame")
                return
            data = pending + data
            size = len(data) // FRAME_BYTES * FRAME_BYTES
            pending = data[size:]
            if size:
                duration = (size // FRAME_BYTES) * 1000000000 // RATE
                yield data[:size], received - duration - latency_ms * 1000000


class Recording:
    def __init__(self, directory, number, source, args, clock):
        self.source, self.clock, self.frames = source, clock, 0
        self.error, self.stopping, self.process = None, False, None
        self.expected_end = False
        self.path = directory / f"source-{number:03}.{args.audio_format}"
        self.sidecar = self.path.with_suffix(".audio.jsonl")
        self.args = args
        self.storage = None
        self.thread = threading.Thread(target=self.run, daemon=True)

    def run(self):
        try:
            native = sys.platform == "win32"
            command = windows_command(self.args, self.source["kind"], self.source["id"]) if native else [
                self.args.parec, "--raw", "--format=s16le", "--rate=48000", "--channels=2",
                f"--latency-msec={self.args.latency_ms}", "--process-time-msec=10",
                "--client-name=WBO seminar recorder",
                "--device=" + (self.source.get("device") or ("@DEFAULT_SOURCE@" if self.source["id"] == "default" else str(self.source["id"]))),
            ]
            if not native and self.source["kind"] == "process":
                command.append("--monitor-stream=" + str(self.source["stream"]))
            with self.path.open("xb") as audio, self.sidecar.open("xb") as metadata, tempfile.TemporaryFile() as errors:
                write_row(metadata, {"format": "whitebophir-audio", "version": 2 if self.args.audio_format == "opus" else 1,
                                     "audio": self.path.name, "sampleRate": RATE, "channels": 2,
                                     "encoding": "opus" if self.args.audio_format == "opus" else "s16le",
                                     "source": self.source, "clockUrl": self.clock.url,
                                     "captureLatencyMs": 0 if native else self.args.latency_ms})
                with AudioStorage(audio, metadata, self.args) as storage:
                    self.storage = storage
                    self.process = subprocess.Popen(command, stdout=subprocess.PIPE, stdin=subprocess.PIPE, stderr=errors,
                                                    start_new_session=not native,
                                                    creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if native else 0)
                    if self.stopping:
                        self.process.terminate()
                    last_saved, last_at, end_ns = 0, None, None

                    def checkpoint():
                        nonlocal last_saved, last_at
                        if self.frames == last_saved or end_ns is None:
                            return
                        stamp = self.clock.stamp(end_ns)
                        if last_at is not None and stamp["atMs"] <= last_at:
                            raise ValueError("Server audio timestamps moved backwards")
                        storage.journal({"kind": "checkpoint", "frames": self.frames, **stamp})
                        last_saved, last_at = self.frames, stamp["atMs"]

                    for data, start_ns in packets(self.process.stdout, native, self.args.latency_ms):
                        if self.frames == 0:
                            stamp = self.clock.stamp(start_ns)
                            storage.journal({"kind": "start", "frames": 0, **stamp})
                            last_at = stamp["atMs"]
                        elif end_ns is not None and start_ns - end_ns > 100000000:
                            checkpoint()
                            stamp = self.clock.stamp(start_ns)
                            if last_at is not None and stamp["atMs"] <= last_at:
                                raise ValueError("Server audio timestamps moved backwards")
                            storage.journal({"kind": "resume", "frames": self.frames, **stamp})
                            last_at = stamp["atMs"]
                        storage.write(data)
                        self.frames += len(data) // FRAME_BYTES
                        end_ns = start_ns + len(data) // FRAME_BYTES * 1000000000 // RATE
                        if self.frames - last_saved >= RATE:
                            checkpoint()
                    checkpoint()
                    code = self.process.wait()
                    if code and not self.stopping:
                        errors.seek(0)
                        raise CaptureProcessError(errors.read(16384).decode("utf-8", errors="replace"))
                    storage.journal({"kind": "end", "frames": self.frames})
        except Exception as error:
            self.error = error
        finally:
            if self.process:
                if self.process.poll() is None:
                    self.process.kill()
                self.process.wait()
                self.process.stdout.close()
                self.process.stdin.close()

    def stop(self):
        self.stopping = True
        if self.process and self.process.poll() is None:
            if sys.platform == "win32":
                try:
                    self.process.stdin.write(b"q\n")
                    self.process.stdin.flush()
                except (OSError, ValueError):
                    pass
            else:
                self.process.terminate()


def record(args):
    text = MESSAGES[args.lang]
    recordings, stop = [], threading.Event()
    sync_thread, clock_file = None, None
    previous_signals = {}
    try:
        if (not math.isfinite(args.sync_interval) or not 5 <= args.sync_interval <= 3600
                or not 5 <= args.latency_ms <= 1000
                or not 16 <= args.audio_bitrate <= 256
                or (args.duration is not None and (not math.isfinite(args.duration) or args.duration <= 0))
                or any(pid <= 0 or pid > 2147483647 for pid in args.process)):
            raise ValueError(text["invalid"])
        if args.list_sources:
            show_choices(discover(args)[0])
            return 0
        if not args.source and not args.process and not select_interactively(args, text):
            return 0
        if args.directory is None:
            raise ValueError(text["directory"])
        if len(set(args.source)) + len(set(args.process)) > 32:
            raise ValueError("At most 32 audio sources may be selected")
        try:
            check_encoder(args)
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            raise ValueError(text["encoder"].format(detail=error)) from error
        clock = ServerClock(args.server)
        first = clock.sync()
        print(text["sync_ok"].format(ms=first["uncertaintyMs"]), flush=True)
        args.directory.mkdir(mode=0o700, parents=False, exist_ok=False)
        clock_file = (args.directory / "clock.jsonl").open("xb")
        write_row(clock_file, first)

        def refresh_clock():
            while not stop.wait(args.sync_interval):
                try:
                    sample = clock.sync()
                    write_row(clock_file, sample)
                except (OSError, ValueError) as error:
                    print(text["sync_failed"].format(detail=error), file=sys.stderr, flush=True)

        sync_thread = threading.Thread(target=refresh_clock, daemon=True)
        sync_thread.start()
        for signum in (signal.SIGINT, signal.SIGTERM):
            previous_signals[signum] = signal.signal(signum, lambda *_: stop.set())

        def begin(source):
            recording = Recording(args.directory, len(recordings) + 1, source, args, clock)
            recordings.append(recording)
            recording.thread.start()

        for source in dict.fromkeys(args.source):
            begin({"kind": "source", "id": source, "name": source})
        if sys.platform == "win32":
            for pid in dict.fromkeys(args.process):
                begin({"kind": "process", "id": pid, "name": str(pid)})
        elif not sys.platform.startswith("linux"):
            raise ValueError("Audio capture supports Linux and Windows")
        for pid in dict.fromkeys(args.process):
            print(text["waiting"].format(pid=pid), flush=True)
        print(text["recording"].format(directory=args.directory), flush=True)
        started, streams = time.monotonic(), {}
        while not stop.is_set():
            if args.duration is not None and time.monotonic() - started >= args.duration:
                break
            if sys.platform.startswith("linux") and args.process:
                current = {row["stream"]: row for row in discover(args)[1] if row["id"] in args.process}
                for index in list(streams):
                    if index not in current or streams[index].source != current[index]:
                        recording = streams.pop(index)
                        recording.expected_end = True
                        recording.stop()
                for index, source in current.items():
                    if index not in streams:
                        begin(source)
                        streams[index] = recordings[-1]
            for recording in recordings:
                if recording.error and not (recording.expected_end and isinstance(recording.error, CaptureProcessError)):
                    raise recording.error
                if not recording.thread.is_alive() and not recording.stopping:
                    raise ValueError("Audio capture ended unexpectedly")
            stop.wait(0.2 if not args.process else 1)
    except KeyboardInterrupt:
        stop.set()
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(text["failure"].format(detail=error), file=sys.stderr)
        return 1
    finally:
        stop.set()
        for recording in recordings:
            recording.stop()
        for recording in recordings:
            recording.thread.join(timeout=5)
            if recording.thread.is_alive() and recording.process:
                recording.process.kill()
                if recording.storage:
                    recording.storage.abort()
                recording.thread.join(timeout=5)
        if sync_thread:
            sync_thread.join(timeout=26)
        if clock_file:
            clock_file.close()
        for signum, previous in previous_signals.items():
            signal.signal(signum, previous)
    errors = [recording.error for recording in recordings if recording.error
              and not (recording.expected_end and isinstance(recording.error, CaptureProcessError))]
    if errors:
        print(text["failure"].format(detail=errors[0]), file=sys.stderr)
        return 1
    count = sum(recording.frames > 0 for recording in recordings)
    if not count:
        print(text["empty"], file=sys.stderr)
        return 1
    print(text["saved"].format(count=count, directory=args.directory))
    return 0
