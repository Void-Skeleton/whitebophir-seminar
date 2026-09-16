"""Durable PCM/Opus output, independent of the platform capture backend.

SPDX-License-Identifier: AGPL-3.0-or-later
Seminar modifications, 2026-09-16.
"""
from collections import deque
import json
import os
import struct
import subprocess
import sys
import tempfile
import threading


def write_row(file, row):
    file.write((json.dumps(row, ensure_ascii=True, separators=(",", ":")) + "\n").encode())
    file.flush()
    os.fsync(file.fileno())


def check_encoder(args):
    if args.audio_format == "pcm":
        return
    result = subprocess.run([args.ffmpeg, "-hide_banner", "-encoders"],
                            capture_output=True, text=True, timeout=15, check=True)
    if not any("libopus" in line.split() for line in result.stdout.splitlines()):
        raise ValueError("ffmpeg must include the libopus encoder")


def ogg_pages(stream):
    """Read complete bounded pages. A torn page is never published to disk."""
    def read(size):
        result = bytearray()
        while len(result) < size:
            part = stream.read(size - len(result))
            if not part:
                raise ValueError("Truncated Opus encoder output")
            result.extend(part)
        return bytes(result)

    while True:
        first = stream.read(1)
        if not first:
            return
        header = first + read(26)
        if header[:5] != b"OggS\x00":
            raise ValueError("Invalid Opus encoder output")
        sizes = read(header[26])
        yield header + sizes + read(sum(sizes))


class AudioStorage:
    """Journal only frames that have reached a complete, fsynced Ogg page.

    Encoding runs continuously; the reader drains stdout while capture feeds
    stdin. Pending timing anchors keep capture time independent of encode delay.
    """
    def __init__(self, audio, metadata, args):
        self.audio, self.metadata, self.args = audio, metadata, args
        self.process, self.reader, self.errors = None, None, None
        self.lock = threading.Lock()
        self.pending = deque()
        self.frames = 0
        self.error = None

    def __enter__(self):
        if self.args.audio_format == "opus":
            self.errors = tempfile.TemporaryFile()
            try:
                self.process = subprocess.Popen([
                    self.args.ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin",
                    "-f", "s16le", "-ar", "48000", "-ac", "2",
                    "-probesize", "32", "-analyzeduration", "0", "-i", "pipe:0",
                    "-c:a", "libopus", "-b:a", f"{self.args.audio_bitrate}k", "-vbr", "off",
                    "-frame_duration", "20", "-page_duration", "100000",
                    "-flush_packets", "1", "-f", "opus", "pipe:1",
                ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.errors,
                   start_new_session=sys.platform != "win32",
                   creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0)
            except Exception:
                self.errors.close()
                raise
            self.reader = threading.Thread(target=self._read, daemon=True)
            self.reader.start()
        return self

    def _read(self):
        try:
            pre_skip = None
            for page in ogg_pages(self.process.stdout):
                body = page[27 + page[26]:]
                if pre_skip is None:
                    if len(body) < 19 or body[:10] != b"OpusHead\x01\x02":
                        raise ValueError("Invalid Opus identification header")
                    pre_skip = struct.unpack_from("<H", body, 10)[0]
                granule = struct.unpack_from("<Q", page, 6)[0]
                with self.lock:
                    self.audio.write(page)
                    if granule != 0xffffffffffffffff:
                        self.frames = max(self.frames, granule - pre_skip)
                    self._publish()
        except Exception as error:
            self.error = error
            self.abort()

    def _publish(self):
        while self.pending and self.pending[0]["frames"] <= self.frames:
            row = self.pending.popleft()
            if row["kind"] == "checkpoint":
                self.audio.flush()
                os.fsync(self.audio.fileno())
                row = {**row, "audioBytes": self.audio.tell()}
            write_row(self.metadata, row)

    def write(self, data):
        if self.error:
            raise self.error
        if self.process:
            self.process.stdin.write(data)
            self.process.stdin.flush()
        else:
            self.audio.write(data)

    def journal(self, row):
        if self.error:
            raise self.error
        if self.process:
            with self.lock:
                self.pending.append(row)
                self._publish()
        else:
            if row["kind"] == "checkpoint":
                self.audio.flush()
                os.fsync(self.audio.fileno())
            write_row(self.metadata, row)

    def abort(self):
        if self.process and self.process.poll() is None:
            self.process.kill()

    def __exit__(self, kind, error, traceback):
        if not self.process:
            return
        try:
            try:
                self.process.stdin.close()
            except BrokenPipeError:
                pass  # Report the encoder or disk error below.
            code = self.process.wait(timeout=5)
            self.reader.join(timeout=5)
            if self.reader.is_alive():
                raise ValueError("Opus encoder did not finish")
            if self.error:
                raise self.error
            if code:
                self.errors.seek(0)
                raise ValueError("Opus encoding failed: " + self.errors.read(16384).decode("utf-8", errors="replace"))
            if self.pending:
                raise ValueError("Opus encoder ended before all audio was committed")
        finally:
            self.abort()
            self.process.wait()
            self.reader.join(timeout=5)
            self.process.stdout.close()
            self.errors.close()
