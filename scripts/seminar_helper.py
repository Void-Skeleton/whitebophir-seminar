#!/usr/bin/env python3
"""WBO seminar helper: export/import compressed native board backups.

SPDX-License-Identifier: AGPL-3.0-or-later
Seminar modifications, 2026-09-14. Requires Python 3.10+, standard library only.
"""

import argparse
import gzip
import io
import json
import os
from pathlib import Path
import sys
import zlib
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen

MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_JSON_BYTES = 256 * 1024 * 1024


def validate_archive(data, max_archive_bytes=MAX_ARCHIVE_BYTES, max_json_bytes=MAX_JSON_BYTES):
    """Check the container; the server validates every item before importing."""
    if len(data) > max_archive_bytes:
        raise ValueError("Archive exceeds the configured compressed limit")
    with gzip.GzipFile(fileobj=io.BytesIO(data)) as stream:
        raw = stream.read(max_json_bytes + 1)
    if len(raw) > max_json_bytes:
        raise ValueError("Archive exceeds the configured decompressed limit")
    archive = json.loads(raw)
    if (not isinstance(archive, dict)
            or archive.get("format") != "whitebophir-board"
            or type(archive.get("version")) is not int
            or archive["version"] != 1
            or not isinstance(archive.get("items"), list)):
        raise ValueError("Unsupported WBO archive format or version")
    return archive


def archive_url(server, board, token=None):
    parts = urlsplit(server)
    if (parts.scheme not in ("http", "https") or not parts.netloc
            or parts.query or parts.fragment or parts.username):
        raise ValueError("--server must be an HTTP(S) base URL, optionally with a base path")
    path = parts.path.rstrip("/") + "/archive/" + quote(board, safe="")
    return urlunsplit((parts.scheme, parts.netloc, path,
                       urlencode({"token": token}) if token else "", ""))


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Export and import compressed native WBO board backups."
    )
    subcommands = parser.add_subparsers(dest="command", required=True)
    for name in ("export", "import"):
        command = subcommands.add_parser(name)
        command.add_argument("file", type=Path, help="Path to a .wbo archive")
        command.add_argument("--server", default="http://localhost:8080")
        command.add_argument("--board", required=True)
        command.add_argument("--max-archive-bytes", type=int, default=MAX_ARCHIVE_BYTES)
        command.add_argument("--max-json-bytes", type=int, default=MAX_JSON_BYTES)
        command.add_argument("--token", default=os.environ.get("WBO_TOKEN"), help="Existing board JWT (or WBO_TOKEN)")
        command.add_argument("--user-secret", default=os.environ.get("WBO_USER_SECRET"), help="Existing user-secret cookie (or WBO_USER_SECRET)")
        command.add_argument("--socket-id", help="Verified browser socket ID, needed for imports on Turnstile-protected boards")
    args = parser.parse_args(argv)
    try:
        if args.max_archive_bytes <= 0 or args.max_json_bytes <= 0:
            raise ValueError("Archive limits must be positive")
        url = archive_url(args.server, args.board, args.token)
        headers = {}
        if args.user_secret:
            if any(c in args.user_secret for c in "\r\n;"):
                raise ValueError("Invalid user-secret cookie")
            headers["Cookie"] = "wbo-user-secret-v1=" + args.user_secret
        if args.socket_id:
            headers["X-WBO-Socket-Id"] = args.socket_id
        if args.command == "export":
            if args.file.exists():
                raise ValueError("Output file already exists; choose a new path")
            with urlopen(Request(url, headers=headers), timeout=60) as response:
                data = response.read(args.max_archive_bytes + 1)
            validate_archive(data, args.max_archive_bytes, args.max_json_bytes)
            with args.file.open("xb") as output:
                output.write(data)
            print(f"Exported {args.board} to {args.file}")
        else:
            with args.file.open("rb") as source:
                data = source.read(args.max_archive_bytes + 1)
            validate_archive(data, args.max_archive_bytes, args.max_json_bytes)
            headers.update({"Content-Type": "application/gzip", "X-WBO-Archive": "1"})
            with urlopen(Request(url, data=data, headers=headers, method="POST"), timeout=60) as response:
                result = json.loads(response.read(65536))
            if (not isinstance(result, dict)
                    or type(result.get("imported")) is not int
                    or result["imported"] < 0):
                raise ValueError("Invalid import response from server")
            print(f"Imported {result['imported']} objects into {args.board}")
        return 0
    except HTTPError as error:
        try:
            payload = json.loads(error.read(65536))
            reason = payload.get("error", error.reason) if isinstance(payload, dict) else error.reason
        except (ValueError, UnicodeError):
            reason = error.reason
        print(f"HTTP {error.code}: {reason}", file=sys.stderr)
    except (OSError, ValueError, EOFError, URLError, zlib.error, RecursionError) as error:
        print(f"Error: {error}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
