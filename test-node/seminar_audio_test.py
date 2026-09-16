"""Portable audio unit tests, also run by the Node suite and Windows CI.
SPDX-License-Identifier: AGPL-3.0-or-later
"""
import argparse
import io
import json
import math
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import seminar_audio as audio
import seminar_video
from seminar_audio_storage import AudioStorage, check_encoder, ogg_pages


class AudioTests(unittest.TestCase):
    def test_clock_uses_minimum_rtt_and_monotonic_time(self):
        ticks = iter([0, 100000000, 1000000000, 1010000000])
        responses = iter([2000, 3000])
        clock = audio.ServerClock("https://example.test/wbo", monotonic=lambda: next(ticks),
                                  opener=lambda *args, **kw: io.BytesIO(json.dumps({"now": next(responses)}).encode()))
        sample = clock.sync(2)
        self.assertEqual(sample["uncertaintyMs"], 5)
        self.assertEqual(clock.stamp(2005000000)["atMs"], 4000)
        self.assertEqual(clock.url, "https://example.test/wbo/time")
        with patch("time.time", return_value=-9999999999):
            self.assertEqual(clock.stamp(2005000000)["atMs"], 4000)
        for url in ("file:///etc/passwd", "https://user:password@example.test", "https://example.test/?token=secret"):
            with self.assertRaises(ValueError):
                audio.ServerClock(url)
        for value in (True, "123", -1, float("nan")):
            clock = audio.ServerClock("http://localhost", opener=lambda *a, **kw: io.BytesIO(json.dumps({"now": value}).encode()))
            with self.assertRaises(ValueError):
                clock.sync(1)

    def test_windows_packet_protocol_and_truncation(self):
        packet = struct.pack("<4sIQ", b"WBOA", 2, 987654321) + b"\x01\x02\x03\x04" * 2
        self.assertEqual(list(audio.packets(io.BytesIO(packet), True, 20)), [(packet[16:], 987654321)])
        for data in (packet[:8], packet[:-1], b"evil" + packet[4:], struct.pack("<4sIQ", b"WBOA", 99999999, 1)):
            with self.assertRaises(ValueError):
                list(audio.packets(io.BytesIO(data), True, 20))

    def test_linux_discovery_matches_pid_and_monitor(self):
        args = argparse.Namespace(pactl="pactl")
        for monitor in ({"monitor_source": "speaker.monitor"},
                        {"monitor_source_name": "speaker.monitor"},
                        {"monitor_source": 9},
                        {"monitor_source_name": None, "monitor_source": "speaker.monitor"}):
            with self.subTest(monitor=monitor):
                values = [
                    [{"index": 2, "name": "mic", "description": "Microphone"},
                     {"index": 9, "name": "speaker.monitor"}],
                    [{"index": 17, "sink": 3, "properties": {"application.process.id": "123", "application.name": "Meeting"}},
                     {"index": 18, "sink": 3, "properties": {"application.process.id": "456"}}],
                    [{"index": 3, **monitor}],
                ]
                with patch.object(audio.sys, "platform", "linux"), patch.object(audio, "command_json", side_effect=values):
                    choices, streams = audio.discover(args)
                self.assertEqual([row["id"] for row in choices], ["default", "mic", "speaker.monitor", 123, 456])
                self.assertEqual([row["stream"] for row in streams], [17, 18])
                self.assertTrue(all(row["device"] == "speaker.monitor" for row in streams))

    def test_linux_discovery_skips_unavailable_monitors(self):
        args = argparse.Namespace(pactl="pactl")
        for monitor in ({}, {"monitor_source": None}, {"monitor_source": ""},
                        {"monitor_source": 4294967295}):
            with self.subTest(monitor=monitor):
                values = [
                    [{"index": 2, "name": "mic"}],
                    [{"index": 17, "sink": 3, "properties": {"application.process.id": "123"}},
                     {"index": 18, "sink": 4, "properties": {"application.process.id": "456"}}],
                    [{"index": 3, **monitor}],
                ]
                with patch.object(audio.sys, "platform", "linux"), patch.object(audio, "command_json", side_effect=values):
                    choices, streams = audio.discover(args)
                self.assertEqual([row["id"] for row in choices], ["default", "mic"])
                self.assertEqual(streams, [])

    def test_interactive_selection_and_localization(self):
        args = argparse.Namespace(source=[], process=[])
        choices = [{"kind": "source", "id": "mic", "name": "Microphone"},
                   {"kind": "process", "id": 123, "name": "Meeting"}]
        with patch.object(audio.sys.stdin, "isatty", return_value=True), patch.object(audio, "discover", return_value=(choices, [])), patch("builtins.input", side_effect=["r", "0", "1,2"]), patch("builtins.print"):
            self.assertTrue(audio.select_interactively(args, audio.MESSAGES["en"]))
        self.assertEqual(args.source, ["mic"])
        self.assertEqual(args.process, [123])
        for messages in (audio.MESSAGES, seminar_video.MESSAGES):
            for language in ("zh-CN", "zh-TW"):
                self.assertEqual(set(messages["en"]), set(messages[language]))

    def test_windows_command_does_not_interpolate_source_as_code(self):
        args = argparse.Namespace(powershell="powershell.exe")
        target = "microphone; $(not-code)"
        command = audio.windows_command(args, "source", target)
        self.assertEqual(command[-1], target)
        self.assertIn("-File", command)
        self.assertNotIn("-Command", command)

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is required for encoding tests")
    def test_compressed_storage_streams_before_close_and_keeps_exact_sample_count(self):
        args = argparse.Namespace(audio_format="opus", ffmpeg="ffmpeg", audio_bitrate=64)
        # A non-round final packet checks that Opus padding/pre-skip do not move
        # server timestamps or add samples to the recording.
        frames = 48000 * 3 + 137
        samples = b"".join(struct.pack("<hh", *([int(5000 * math.sin(i * 2 * math.pi * 440 / 48000))] * 2))
                           for i in range(frames))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "test.opus"
            journal = Path(directory) / "test.audio.jsonl"
            with path.open("xb") as output, journal.open("xb") as metadata:
                with AudioStorage(output, metadata, args) as storage:
                    storage.journal({"kind": "start", "frames": 0, "atMs": 1000})
                    for index in range(3):
                        storage.write(samples[index * 192000:(index + 1) * 192000])
                        storage.journal({"kind": "checkpoint", "frames": (index + 1) * 48000,
                                         "atMs": 1000 + (index + 1) * 1000})
                    deadline = time.monotonic() + 5
                    while b'"checkpoint"' not in journal.read_bytes() and time.monotonic() < deadline:
                        time.sleep(0.01)
                    rows = [json.loads(line) for line in journal.read_bytes().splitlines()]
                    committed = next(row for row in reversed(rows) if row["kind"] == "checkpoint")
                    self.assertGreaterEqual(committed["frames"], 48000)
                    self.assertLessEqual(committed["audioBytes"], path.stat().st_size)
                    prefix = Path(directory) / "prefix.opus"
                    prefix.write_bytes(path.read_bytes()[:committed["audioBytes"]])
                    decoded = subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(prefix),
                                                       "-f", "s16le", "pipe:1"])
                    self.assertGreaterEqual(len(decoded), committed["frames"] * 4)
                    storage.write(samples[3 * 192000:])
                    storage.journal({"kind": "checkpoint", "frames": frames, "atMs": 4000 + 137 / 48})
                    storage.journal({"kind": "end", "frames": frames})
            decoded = subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(path), "-f", "s16le", "pipe:1"])
            self.assertEqual(len(decoded), frames * 4)
            self.assertLess(path.stat().st_size, len(samples) // 15)
            self.assertEqual(json.loads(journal.read_bytes().splitlines()[-1]), {"kind": "end", "frames": frames})
            pages = list(ogg_pages(io.BytesIO(path.read_bytes())))
            with self.assertRaisesRegex(ValueError, "Truncated"):
                list(ogg_pages(io.BytesIO(b"".join(pages)[:-1])))

    def test_pcm_storage_does_not_require_ffmpeg(self):
        with tempfile.TemporaryDirectory() as directory:
            with (Path(directory) / "test.pcm").open("xb") as output, (Path(directory) / "test.jsonl").open("xb") as metadata:
                args = argparse.Namespace(audio_format="pcm")
                check_encoder(args)
                with AudioStorage(output, metadata, args) as storage:
                    storage.write(b"\x01\x00\x02\x00")
                    storage.journal({"kind": "checkpoint", "frames": 1, "atMs": 1})
                    self.assertEqual((Path(directory) / "test.pcm").read_bytes(), b"\x01\x00\x02\x00")

    def test_missing_encoder_fails_before_creating_recording(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "recording"
            result = subprocess.run([sys.executable, str(Path(audio.__file__).with_name("seminar_helper.py")),
                                     "record", str(output), "--source", "default", "--ffmpeg",
                                     str(Path(directory) / "missing-ffmpeg")],
                                    capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 1)
            self.assertIn("--audio-format pcm", result.stderr)
            self.assertNotIn("Traceback", result.stderr)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
