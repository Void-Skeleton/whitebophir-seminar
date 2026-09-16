"""Shared seminar CLI timestamps and history input limits.

SPDX-License-Identifier: AGPL-3.0-or-later
Seminar modifications, 2026-09-16.
"""

from datetime import datetime, timezone
import re

# Two hours at 240 points/s measures ~366 MiB JSON / 48 MiB gzip, including
# stroke records. These defaults leave headroom above that stress case.
MAX_HISTORY_BYTES = 256 * 1024 * 1024
MAX_HISTORY_JSON_BYTES = 1024 * 1024 * 1024


def parse_timestamp(value):
    """Unix milliseconds or an ISO 8601 date with an explicit UTC offset."""
    if re.fullmatch(r"[0-9]+", value):
        result = int(value)
    else:
        date = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if date.tzinfo is None:
            raise ValueError("Timestamps require a timezone, for example 2026-09-16T10:00:00.123Z")
        elapsed = date - datetime(1970, 1, 1, tzinfo=timezone.utc)
        result = (elapsed.days * 86400 + elapsed.seconds) * 1000 + elapsed.microseconds // 1000
    if not 0 <= result <= 8640000000000000:
        raise ValueError("Invalid timestamp")
    return result
