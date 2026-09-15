#!/usr/bin/env python3
"""WBO seminar helper: native backups, local keys and named board links.

SPDX-License-Identifier: AGPL-3.0-or-later
Seminar modifications, 2026-09-15. Python 3.10+; v2 keys require cryptography.
"""

import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sys
import unicodedata
import zlib
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit, urlunsplit
from urllib.request import Request, HTTPRedirectHandler, build_opener

MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_JSON_BYTES = 256 * 1024 * 1024


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


urlopen = build_opener(NoRedirect).open


def ed25519_key_class():
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    except ImportError as error:
        raise ValueError("V2 authentication requires: pip install -r scripts/requirements-seminar.txt") from error
    return Ed25519PrivateKey


def generate_key_file(destination):
    key = ed25519_key_class().generate()
    public_key = key.public_key().public_bytes_raw().hex()
    data = {"format": "whitebophir-ed25519", "version": 1,
            "privateKey": key.private_bytes_raw().hex(), "publicKey": public_key}
    with os.fdopen(os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as output:
        json.dump(data, output)
        output.write("\n")
    print(f"Public key: {public_key}")
    print(f"Private key saved locally in {destination}")


def read_key_file(source):
    with source.open("rb") as key_file:
        data = json.loads(key_file.read(2048))
    if (not isinstance(data, dict) or data.get("format") != "whitebophir-ed25519"
            or data.get("version") != 1 or not isinstance(data.get("privateKey"), str)
            or len(data["privateKey"]) != 64):
        raise ValueError("Invalid v2 key file")
    key = ed25519_key_class().from_private_bytes(bytes.fromhex(data["privateKey"]))
    if key.public_key().public_bytes_raw().hex() != data.get("publicKey"):
        raise ValueError("V2 public and private keys do not match")
    return key


def authentication_v2(args, url, body=None):
    key = read_key_file(args.private_key_file)
    public_key = key.public_key().public_bytes_raw().hex()
    parts = urlsplit(args.server)
    audience = urlunsplit((parts.scheme, parts.netloc, parts.path.rstrip("/"), "", ""))
    scope = ("POST:" if body is not None else "GET:") + urlsplit(url).path
    body_hash = hashlib.sha512(body).hexdigest() if body is not None else ""
    request = Request(audience + "/auth/v2/challenge", method="POST",
                      headers={"Content-Type": "application/json"},
                      data=json.dumps({"board": args.board, "scope": scope,
                                       "publicKey": public_key, "bodyHash": body_hash}).encode())
    with urlopen(request, timeout=60) as response:
        result = json.loads(response.read(4096))
    if not isinstance(result, dict) or not isinstance(result.get("challenge"), str):
        raise ValueError("Invalid v2 challenge")
    challenge = result["challenge"]
    fields = json.loads(challenge)
    if (not isinstance(fields, list) or len(fields) != 8
            or fields[:6] != ["wbo-auth-v2", audience, args.board, scope, public_key, body_hash]
            or not isinstance(fields[6], str) or len(fields[6]) != 64
            or any(c not in "0123456789abcdef" for c in fields[6])
            or type(fields[7]) is not int):
        raise ValueError("Invalid v2 challenge context")
    return {"X-WBO-Auth-V2": fields[6] + "." + key.sign(challenge.encode()).hex()}


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


def named_board_url(server, board, name, token=None):
    """Build an entry URL without transmitting credentials or joining a socket."""
    if (len(name.encode("utf-16-le", errors="surrogatepass")) > 128
            or any(unicodedata.category(c) in ("Cc", "Cs")
                   or c in "\u2028\u2029\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069" for c in name)):
        raise ValueError("Name must be 1–64 characters without control characters")
    name = re.sub(r"^[\s\ufeff]+|[\s\ufeff]+$", "", unicodedata.normalize("NFC", name))
    if not name or len(name.encode("utf-16-le")) > 128:
        raise ValueError("Name must be 1–64 characters after normalization")
    parts = urlsplit(archive_url(server, board, token))
    path = urlsplit(server).path.rstrip("/") + "/boards/" + quote(board, safe="")
    query = {"name": name}
    if token:
        query["token"] = token
    return urlunsplit((parts.scheme, parts.netloc, path, urlencode(query), ""))


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Manage WBO backups, local identities, and named board links."
    )
    subcommands = parser.add_subparsers(dest="command", required=True)
    keygen = subcommands.add_parser("keygen", help="Generate a local Ed25519 identity")
    keygen.add_argument("file", type=Path, help="New local key file (contains the private key)")
    join = subcommands.add_parser("join-url", help="Print a board URL with a display name")
    join.add_argument("--server", default="http://localhost:8080")
    join.add_argument("--board", required=True)
    join.add_argument("--name", required=True)
    join.add_argument("--token", help="Optional board JWT to include in the URL")
    for name in ("export", "import"):
        command = subcommands.add_parser(name)
        command.add_argument("file", type=Path, help="Path to a .wbo archive")
        command.add_argument("--server", default="http://localhost:8080")
        command.add_argument("--board", required=True)
        command.add_argument("--max-archive-bytes", type=int, default=MAX_ARCHIVE_BYTES)
        command.add_argument("--max-json-bytes", type=int, default=MAX_JSON_BYTES)
        command.add_argument("--token", default=os.environ.get("WBO_TOKEN"), help="Existing board JWT (or WBO_TOKEN)")
        command.add_argument("--user-secret", default=os.environ.get("WBO_USER_SECRET"), help="Existing user-secret cookie (or WBO_USER_SECRET)")
        command.add_argument("--private-key-file", type=Path, help="Local Ed25519 key file for v2 authentication")
        command.add_argument("--socket-id", help="Verified browser socket ID, needed for imports on Turnstile-protected boards")
    args = parser.parse_args(argv)
    try:
        if args.command == "keygen":
            generate_key_file(args.file)
            return 0
        if args.command == "join-url":
            print(named_board_url(args.server, args.board, args.name, args.token))
            return 0
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
            if args.private_key_file:
                headers.update(authentication_v2(args, url))
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
            if args.private_key_file:
                headers.update(authentication_v2(args, url, data))
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
