"""Offline canvas replay command for seminar_helper.py.

SPDX-License-Identifier: AGPL-3.0-or-later
Seminar modifications, 2026-09-16.
"""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from seminar_common import MAX_HISTORY_BYTES, MAX_HISTORY_JSON_BYTES, parse_timestamp


MESSAGES = {
    "en": {
        "description": "Render a snapshot and matching history to a canvas-only MP4 video.",
        "output": "New .mp4 output file (never overwritten)",
        "snapshot": "Historical .wbo snapshot within the history interval",
        "history": "Downloaded .jsonl.gz history covering the snapshot and video interval",
        "snapshot_at": "Timestamp of a legacy snapshot without embedded time (Unix ms or ISO 8601 with timezone)",
        "start": "Video start, at or after the snapshot (Unix ms or ISO 8601 with timezone; default: snapshot time)",
        "end": "Video end, at or before history end (Unix ms or ISO 8601 with timezone; default: history end)",
        "resolution": "Video dimensions WIDTHxHEIGHT, even numbers (default: 1920x1080)",
        "fps": "Frames per second, 1–120 (default: 30)",
        "speed": "Playback speed multiplier (default: 1)",
        "camera": "latest: follow edited chunks; fixed: use view box; fit: show the entire replay",
        "view_box": "Fixed camera box in board units: X Y WIDTH HEIGHT",
        "initial": "Initial camera point in board units (otherwise saved point or origin)",
        "chunk_width": "Override chunk width in board units (100–100000)",
        "chunk_height": "Override chunk height in board units (100–100000)",
        "margin": "Override chunk/fit margin in board units (0–100000)",
        "transition": "Camera transition in milliseconds, 0 for cuts (default: 240)",
        "ffmpeg": "ffmpeg executable path (default: ffmpeg on PATH)",
        "node": "Node.js executable path (default: node on PATH)",
        "chromium": "Optional Chromium executable; otherwise use Playwright's installed browser",
        "compressed": "Maximum compressed bytes per input (default: 256 MiB)",
        "expanded": "Maximum decompressed bytes per input (default: 1 GiB)",
        "lang": "Help and status language",
        "invalid_resolution": "Resolution must be WIDTHxHEIGHT with even dimensions from 2 to 7680.",
        "started": "Rendering canvas replay…",
        "progress": "Rendered {frame}/{total} frames",
        "finished": "Saved {frames} frames to {output}",
        "incomplete": "{count} strokes have no completion record; their last recorded point bounds the replay interval.",
        "failed": "Replay failed: {detail}",
        "interrupted": "Replay cancelled; no partial output was published.",
        "exists": "Output already exists; choose a new path.",
    },
    "zh-CN": {
        "description": "将历史快照和对应的修改日志渲染为仅包含画布的 MP4 回放视频。",
        "output": "新建的 .mp4 输出文件（不会覆盖已有文件）",
        "snapshot": "时间位于日志区间内的历史 .wbo 快照",
        "history": "覆盖快照时间和视频区间的 .jsonl.gz 修改日志",
        "snapshot_at": "不含时间信息的旧版快照的时间戳（Unix 毫秒或带时区的 ISO 8601）",
        "start": "视频开始时间，不早于快照（Unix 毫秒或带时区的 ISO 8601；默认使用快照时间）",
        "end": "视频结束时间，不晚于日志结束（Unix 毫秒或带时区的 ISO 8601；默认使用日志结束时间）",
        "resolution": "视频分辨率：宽x高，必须为偶数（默认：1920x1080）",
        "fps": "每秒帧数，1–120（默认：30）",
        "speed": "回放速度倍数（默认：1）",
        "camera": "latest：跟随最新修改的分块；fixed：固定视野；fit：显示完整回放范围",
        "view_box": "固定视野，单位为画布坐标：X Y 宽 高",
        "initial": "初始视野中心点；默认使用保存的位置或原点",
        "chunk_width": "覆盖分块宽度，画布单位（100–100000）",
        "chunk_height": "覆盖分块高度，画布单位（100–100000）",
        "margin": "覆盖分块或完整视野的边距，画布单位（0–100000）",
        "transition": "视野过渡时间（毫秒），0 表示立即切换（默认：240）",
        "ffmpeg": "ffmpeg 可执行文件路径（默认从 PATH 查找）",
        "node": "Node.js 可执行文件路径（默认从 PATH 查找 node）",
        "chromium": "可选的 Chromium 路径；默认使用 Playwright 安装的浏览器",
        "compressed": "每个输入文件的压缩大小上限（默认：256 MiB）",
        "expanded": "每个输入文件的解压大小上限（默认：1 GiB）",
        "lang": "帮助和状态信息的语言",
        "invalid_resolution": "分辨率须为宽x高，宽高必须是 2 到 7680 之间的偶数。",
        "started": "正在渲染画布回放……",
        "progress": "已渲染 {frame}/{total} 帧",
        "finished": "已将 {frames} 帧保存到 {output}",
        "incomplete": "有 {count} 条笔画缺少结束记录，将使用最后记录的点作为回放结束边界。",
        "failed": "回放失败：{detail}",
        "interrupted": "回放已取消，未生成不完整的输出文件。",
        "exists": "输出文件已存在，请选择新路径。",
    },
    "zh-TW": {
        "description": "將歷史快照和對應的修改日誌算繪為僅包含畫布的 MP4 回放影片。",
        "output": "新建的 .mp4 輸出檔案（不會覆寫現有檔案）",
        "snapshot": "時間位於日誌區間內的歷史 .wbo 快照",
        "history": "涵蓋快照時間和影片區間的 .jsonl.gz 修改日誌",
        "snapshot_at": "不含時間資訊的舊版快照的時間戳記（Unix 毫秒或含時區的 ISO 8601）",
        "start": "影片開始時間，不早於快照（Unix 毫秒或含時區的 ISO 8601；預設使用快照時間）",
        "end": "影片結束時間，不晚於日誌結束（Unix 毫秒或含時區的 ISO 8601；預設使用日誌結束時間）",
        "resolution": "影片解析度：寬x高，必須為偶數（預設：1920x1080）",
        "fps": "每秒影格數，1–120（預設：30）",
        "speed": "回放速度倍數（預設：1）",
        "camera": "latest：跟隨最新修改的區塊；fixed：固定視野；fit：顯示完整回放範圍",
        "view_box": "固定視野，單位為畫布座標：X Y 寬 高",
        "initial": "初始視野中心點；預設使用儲存的位置或原點",
        "chunk_width": "覆寫區塊寬度，畫布單位（100–100000）",
        "chunk_height": "覆寫區塊高度，畫布單位（100–100000）",
        "margin": "覆寫區塊或完整視野的邊距，畫布單位（0–100000）",
        "transition": "視野過渡時間（毫秒），0 表示立即切換（預設：240）",
        "ffmpeg": "ffmpeg 執行檔路徑（預設從 PATH 尋找）",
        "node": "Node.js 執行檔路徑（預設從 PATH 尋找 node）",
        "chromium": "選用的 Chromium 路徑；預設使用 Playwright 安裝的瀏覽器",
        "compressed": "每個輸入檔案的壓縮大小上限（預設：256 MiB）",
        "expanded": "每個輸入檔案的解壓縮大小上限（預設：1 GiB）",
        "lang": "說明和狀態訊息的語言",
        "invalid_resolution": "解析度須為寬x高，寬高必須是 2 到 7680 之間的偶數。",
        "started": "正在算繪畫布回放……",
        "progress": "已算繪 {frame}/{total} 影格",
        "finished": "已將 {frames} 影格儲存至 {output}",
        "incomplete": "有 {count} 條筆畫缺少結束記錄，將使用最後記錄的點作為回放結束邊界。",
        "failed": "回放失敗：{detail}",
        "interrupted": "回放已取消，未產生不完整的輸出檔案。",
        "exists": "輸出檔案已存在，請選擇新路徑。",
    },
}


def add_parser(subcommands, argv):
    language = "en"
    arguments = list(sys.argv[1:] if argv is None else argv)
    for i, arg in enumerate(arguments):
        if arg == "--lang" and i + 1 < len(arguments):
            language = arguments[i + 1]
        elif arg.startswith("--lang="):
            language = arg.split("=", 1)[1]
    text = MESSAGES.get(language, MESSAGES["en"])
    parser = subcommands.add_parser("replay", help=text["description"], description=text["description"])
    parser.add_argument("file", type=Path, help=text["output"])
    parser.add_argument("--snapshot", type=Path, required=True, help=text["snapshot"])
    parser.add_argument("--history", type=Path, required=True, help=text["history"])
    parser.add_argument("--snapshot-at", help=text["snapshot_at"])
    parser.add_argument("--start", help=text["start"])
    parser.add_argument("--end", help=text["end"])
    parser.add_argument("--resolution", default="1920x1080", help=text["resolution"])
    parser.add_argument("--fps", type=int, default=30, help=text["fps"])
    parser.add_argument("--speed", type=float, default=1, help=text["speed"])
    parser.add_argument("--camera", choices=("latest", "fixed", "fit"), default="latest", help=text["camera"])
    parser.add_argument("--view-box", type=float, nargs=4, help=text["view_box"])
    parser.add_argument("--initial-point", type=float, nargs=2, help=text["initial"])
    parser.add_argument("--chunk-width", type=int, help=text["chunk_width"])
    parser.add_argument("--chunk-height", type=int, help=text["chunk_height"])
    parser.add_argument("--margin", type=int, help=text["margin"])
    parser.add_argument("--transition-ms", type=float, default=240, help=text["transition"])
    parser.add_argument("--ffmpeg", default="ffmpeg", help=text["ffmpeg"])
    parser.add_argument("--node", default="node", help=text["node"])
    parser.add_argument("--chromium", help=text["chromium"])
    parser.add_argument("--max-archive-bytes", type=int, default=MAX_HISTORY_BYTES, help=text["compressed"])
    parser.add_argument("--max-json-bytes", type=int, default=MAX_HISTORY_JSON_BYTES, help=text["expanded"])
    parser.add_argument("--lang", choices=tuple(MESSAGES), default="en", help=text["lang"])


def render(args):
    text = MESSAGES[args.lang]
    child = None
    try:
        try:
            width, height = map(int, args.resolution.lower().split("x"))
            if any(n < 2 or n > 7680 or n % 2 for n in (width, height)):
                raise ValueError()
        except ValueError as error:
            raise ValueError(text["invalid_resolution"]) from error
        if args.file.exists():
            raise ValueError(text["exists"])
        options = {
            "snapshot": str(args.snapshot.resolve()), "history": str(args.history.resolve()),
            "output": str(args.file.resolve()), "width": width, "height": height,
            "fps": args.fps, "speed": args.speed, "camera": args.camera,
            "viewBox": args.view_box, "initialPoint": args.initial_point,
            "chunkWidth": args.chunk_width, "chunkHeight": args.chunk_height,
            "margin": args.margin, "transitionMs": args.transition_ms, "ffmpeg": args.ffmpeg,
            "chromium": args.chromium, "maxArchiveBytes": args.max_archive_bytes,
            "maxJsonBytes": args.max_json_bytes,
            "snapshotAtMs": parse_timestamp(args.snapshot_at) if args.snapshot_at is not None else None,
            "startMs": parse_timestamp(args.start) if args.start is not None else None,
            "endMs": parse_timestamp(args.end) if args.end is not None else None,
        }
        options = {key: value for key, value in options.items() if value is not None}
        payload = json.dumps(options, allow_nan=False)
        renderer = Path(__file__).with_name("seminar_render.mjs")
        print(text["started"], flush=True)
        with tempfile.TemporaryFile(mode="w+b") as errors:
            child = subprocess.Popen([args.node, str(renderer)], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=errors, text=True,
                                     encoding="utf-8", env={**os.environ, "WBO_SILENT": "true"})
            child.stdin.write(payload)
            child.stdin.close()
            result = None
            for line in child.stdout:
                message = json.loads(line)
                if "frame" in message:
                    print(text["progress"].format(**message), flush=True)
                else:
                    result = message
            child.stdout.close()
            if child.wait() != 0 or not isinstance(result, dict) or "frames" not in result:
                errors.seek(max(0, errors.tell() - 16384))
                raise ValueError(errors.read().decode("utf-8", errors="replace").strip())
        print(text["finished"].format(frames=result["frames"], output=args.file))
        if result.get("incompleteStrokes"):
            print(text["incomplete"].format(count=result["incompleteStrokes"]), file=sys.stderr)
        return 0
    except KeyboardInterrupt:
        print(text["interrupted"], file=sys.stderr)
    except (OSError, ValueError) as error:
        print(text["failed"].format(detail=error), file=sys.stderr)
    finally:
        if child and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=15)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
    return 1
