# WBO

WBO is an online collaborative whiteboard that allows many users to draw simultaneously on a large virtual board.
The board is updated in real time for all connected users, and its state is always persisted. It can be used for many different purposes, including art, entertainment, design, teaching.

A demonstration server is available at [wbo.ophir.dev](https://wbo.ophir.dev)

## Seminar fork modifications — 2026-09-16

This modified version adds compressed native whiteboard export/import, a Python
command-line helper, Ed25519 moderator authentication, per-board display
names, moderator-controlled canvas chunks with activity following, board dark
mode, personal scroll controls, durable timestamped edit history with
historical snapshots, offline canvas replay videos, and separately recorded
microphone/application audio synchronized to the board's server clock.
See [NOTICE.md](NOTICE.md) for modification and license notices.

Use the existing **Download** button (previously Save to SVG) to export an SVG or
a **WBO backup**. Board moderators also see **Import WBO backup** in the same
dialog, which opens a file picker to upload a saved board. Uploads require board
moderator access on the server as well. Configured board moderators, board-scoped
moderator JWTs, and active temporary moderators are supported, including on
read-only boards. Reopening the menu reflects moderator grants and revocations.

A `.wbo` file is gzip-compressed UTF-8 JSON containing WBO's internal
item records, with string tool IDs, geometry, stroke points, text, opacity and
affine transforms in paint order. Imported objects remain editable. Imports add
objects with fresh IDs to the current board; use an empty board to restore only
the backup's contents. Access settings, identities, cursor positions and the
source board's mutation sequence are not transferred.

Exports include accepted edits, saving a consistent snapshot before downloading.
The server validates the complete import before adding anything. Existing board
access, edit bans, blocked tools and geometry limits apply. Imports that would
exceed the destination's item limit are rejected without removing existing
objects. Bulk import has a separate admission limit of one attempt per IP every
10 seconds, with at most 1,000,000 generated live mutations per archive.

The default limits are **64 MiB compressed** and **256 MiB decompressed**. Set
`WBO_MAX_ARCHIVE_BYTES` and `WBO_MAX_ARCHIVE_JSON_BYTES` to change them (byte
counts, each between 1 and 1,073,741,824). For example:

```sh
WBO_MAX_ARCHIVE_BYTES=134217728 WBO_MAX_ARCHIVE_JSON_BYTES=536870912 npm start
```

The browser uses the configured compressed limit. Reverse proxies may also need
their request-body limit increased. Destination `WBO_MAX_ITEM_COUNT`,
`WBO_MAX_CHILDREN`, and the current drawing field limits still apply.

### Display names

Enter a display name on the homepage before opening a named, public, recent, or
random board, or add `?name=Alice` to a board URL. Names support Unicode; URL
values must be URL-encoded. The helper can generate the link:

```sh
python3 scripts/seminar_helper.py join-url --server http://localhost:8080 \
  --board seminar --name '张三'
```

On your first visit without a supplied or saved name, a dialog proposes the old
generated name. Save your preferred name, or dismiss the dialog to keep the
proposed name. The `wbo-board-name-v1` cookie remembers the choice for one year;
each board has its own cookie path, including the deployment's base path.
Returning without `name` reuses the saved choice. A supplied URL name takes
precedence and is removed from the address after acceptance, so later reloads
retain edits made through the UI.

Open **Users** and use the pencil button to change your own name. Permanent and
temporary moderators can also rename any connected user, including moderators.
Renames update every connected tab sharing that authenticated identity on the
same board, including their saved cookies. Users remain free to change their own
name afterward. Another board's name is unaffected. Clearing cookies resets the
saved choice; disconnected clients cannot receive moderator changes.

Names contain 1–64 UTF-16 code units (the browser's input-length convention).
Control characters, directional overrides and unpaired surrogates are rejected;
names are rendered as plain text. Names do not grant permissions or change the
stable user identity used by friends, bans, or moderator grants. The server
limits rename attempts to ten per socket per ten seconds. All name controls
work over HTTP and HTTPS and are translated in every supported language.

### Board dark mode

Moderators can use **Board dark mode** beside the chunk controls to change the
canvas for everyone. The setting is saved with board data and native `.wbo`
backups, survives restarts, and appears in SVG downloads and previews. Temporary
moderators can also change it. Ordinary viewers and editors follow the board's
theme.

The dark canvas is `#202020`. New sessions default to black ink in light mode
and white ink in dark mode; existing color preferences are retained. Switching
modes preserves hues: black becomes white, white matches the background, and
light red becomes dark red. Original stroke colors remain intact, so switching
back restores them exactly. The color picker, swatches, and active pencil stroke
show the current appearance. Chunk borders and the optional grid and dots are
white in dark mode. The surrounding controls keep their existing appearance.

```sh
python3 scripts/seminar_helper.py theme --server http://localhost:8080 --board seminar
python3 scripts/seminar_helper.py theme --server http://localhost:8080 \
  --board seminar --user-secret "$WBO_USER_SECRET" --mode dark
```

The helper also accepts `--private-key-file` or `--token`. `GET /theme/{board}`
returns `{ "theme": "light" }` or `{ "theme": "dark" }`. Moderator-only POST
accepts that same object with `X-WBO-Theme: 1` and `Content-Type: application/json`.
V2 requests sign the exact body and work over HTTP and HTTPS. Updates share the
chunk-settings rate limit. Backups can contain an optional `theme` field;
older backups without it preserve the destination's theme.

### Edit history and historical snapshots

Moderators can open **Download** and choose **Download historical board** or
**Download modification log**. Time fields use the browser's local timezone and
accept milliseconds. A historical board is an ordinary `.wbo` backup that can be
uploaded through the existing import action. Downloading does not change the
live board. Logs are gzip-compressed UTF-8 JSON Lines (`.jsonl.gz`), readable with
`gzip -dc` and standard JSON tools.

The server records accepted persistent changes: stroke points, text, shapes,
transforms, copies, erases, clears, imports, and chunk/theme settings. Cursors
and rejected edits are excluded. Timestamps are integer Unix milliseconds from
the server clock. Each mutation has `startAtMs` and `endAtMs` equal to its
acceptance time; a separate `stroke` record describes the complete Pencil
interval and cubic Bézier control points (`curve: {version: 1, segments: [...]}`).
The controls use the same smoothing as the live Pencil tool. Active curves remain
in memory across SVG saves and are journaled once when the stroke closes;
accepted point mutations still stream durably for recovery and older readers.
Release is reported after the final point is accepted. Disconnects,
interrupted processes, and older clients use the last accepted point as the
bounded end, with an explicit reason. These are server observation times, so
network latency and queued writes affect them.

Snapshots include all changes accepted at or before the selected timestamp;
an unfinished stroke contains its accepted points. Operations in the same
millisecond retain sequence order. Empty Pencil placeholders are omitted.
Ranges include both endpoints and select records by `atMs`; a completed stroke
record may refer to a start before the requested range. Snapshots include chunk
and theme settings. Log headers describe the format, board, range, and earliest
available time; each subsequent line is a `mutation`, `settings`, `stroke`, or
`checkpoint` record.

History begins when a board is first loaded by this version. An initial SVG
checkpoint preserves existing content; earlier edits cannot be reconstructed.
The dialog shows the earliest available time. There is no automatic retention
limit, so provision disk space for the full log. History retains erased content
and is downloadable only by current permanent or temporary moderators.

Each board has an append-only `*.svg.history.jsonl.gz` file beside its SVG in
`WBO_HISTORY_DIR`. Transactions are complete gzip members whose `WB` extra
field stores the compressed length. Appends are synchronized before accepted
changes are broadcast or saved to SVG. Restart recovery replays accepted edits
missing from SVG and truncates only an incomplete final member. Corrupt complete
members stop loading; append failures stop new edits for that loaded board.
An externally replaced SVG with a newer sequence adds an explicit checkpoint;
its intermediate edits are unknown. Keep SVG and journal together in filesystem
backups. Native `.wbo` files transfer state without the source history.

```sh
# Returns availableFrom and now as Unix milliseconds.
python3 scripts/seminar_helper.py history-info --server http://localhost:8080 \
  --board seminar --private-key-file moderator.json

python3 scripts/seminar_helper.py export snapshot.wbo --server http://localhost:8080 \
  --board seminar --private-key-file moderator.json --at 2026-09-16T10:00:00.123Z

python3 scripts/seminar_helper.py history edits.jsonl.gz --server http://localhost:8080 \
  --board seminar --private-key-file moderator.json \
  --from 2026-09-16T09:00:00Z --to 2026-09-16T10:00:00Z
```

CLI timestamps accept Unix milliseconds or ISO 8601 with a timezone. Existing
`--user-secret` and `--token` authentication also work. Output files are never
overwritten. History downloads default to 256 MiB compressed / 1 GiB decompressed;
`--max-archive-bytes` and `--max-json-bytes` override these limits. Native snapshot
downloads retain their separate 64 MiB / 256 MiB defaults.
`GET /history/{board}` returns `{availableFrom, now}`; add `?at=<ms>` for a
snapshot or `?from=<ms>&to=<ms>` for a log. Times before history starts return
416; malformed, reversed, or future times return 400. Requests require `canBan`,
support v2 proofs over HTTP/HTTPS, and are not cached. At most two exports run
concurrently per server runtime. Log exports stream with backpressure and a
fixed upper file offset so ongoing edits cannot change the selected result.

### Canvas replay video

The Python helper's `replay` command renders a historical `.wbo` snapshot and a
downloaded `.jsonl.gz` history into an MP4 video. The snapshot time must fall
within the history interval. It renders only the canvas, including
chunk borders, colors, text, shapes, transforms, copies, erasures, clears, and
later chunk/theme changes. It runs locally without a running WBO server.

The renderer uses the repository's Node.js code and Playwright Chromium to keep
the drawing appearance consistent with WBO. Install the repository's npm
dependencies and Chromium with `npm install` and `npx playwright install chromium`.
Install **ffmpeg** with the `libx264` encoder on PATH, or pass `--ffmpeg /path/to/ffmpeg`.
Use `--node` or `--chromium` to select other executable paths. Fonts are supplied
by the rendering machine; install fonts for the languages used on the board.

```sh
# Download matching inputs (use the same authentication options as history/export).
python3 scripts/seminar_helper.py export start.wbo --server http://localhost:8080 \
  --board seminar --private-key-file moderator.json --at 2026-09-16T09:15:00Z
python3 scripts/seminar_helper.py history edits.jsonl.gz --server http://localhost:8080 \
  --board seminar --private-key-file moderator.json \
  --from 2026-09-16T09:00:00Z --to 2026-09-16T11:00:00Z

python3 scripts/seminar_helper.py replay seminar.mp4 \
  --snapshot start.wbo --history edits.jsonl.gz --resolution 1920x1080 --fps 30

# Render a selected interval from those same inputs.
python3 scripts/seminar_helper.py replay excerpt.mp4 \
  --snapshot start.wbo --history edits.jsonl.gz \
  --start 2026-09-16T09:30:00Z --end 2026-09-16T10:30:00Z

# Override the board's chunk dimensions and margins.
python3 scripts/seminar_helper.py replay custom.mp4 \
  --snapshot start.wbo --history edits.jsonl.gz \
  --chunk-width 10000 --chunk-height 7000 --margin 500

# Other camera choices: a fixed region, or a stable view of all replayed content.
python3 scripts/seminar_helper.py replay fixed.mp4 --snapshot start.wbo \
  --history edits.jsonl.gz --camera fixed --view-box 0 0 16000 9000
python3 scripts/seminar_helper.py replay overview.mp4 --snapshot start.wbo \
  --history edits.jsonl.gz --camera fit --speed 4

python3 scripts/seminar_helper.py replay --lang zh-CN --help
python3 scripts/seminar_helper.py replay --lang zh-TW --help
```

`--start` defaults to the snapshot time; `--end` defaults to the history end.
Both accept Unix milliseconds or ISO 8601 with a timezone. Bounds are inclusive:
`history start ≤ snapshot time ≤ video start ≤ video end ≤ history end`.
Edits through the snapshot time are already present and are not reapplied.
Edits between the snapshot and video start are applied before the first frame.
Cutting a video in the middle of a stroke preserves its original timing, using
completion records later in the supplied history.

The default `--camera latest` follows the last edited chunk, like a participant
using latest-edit focus. Geometry defaults to the saved board settings and
follows changes in the log; explicit width, height, or margin overrides remain
in effect. Without saved chunk settings, WBO's 10000 × 7000, margin 500 defaults
apply. Camera changes ease over 240 ms; `--transition-ms 0` makes immediate cuts.
`fixed` preserves a region given in board coordinates, and `fit` keeps all content
seen during the replay in view. Aspect ratios are preserved by extending the
visible region. Borders remain visible in every camera mode, white in dark mode.

Pencil strokes render as cubic Bézier curves, using saved controls or deriving
the same smoothing from older point-only logs and snapshots. Replay advances at
constant distance along the curves between the stroke's start and end timestamps;
partial strokes keep a curved tip instead of joining samples with straight lines.
A snapshot taken mid-stroke stays intact; its remaining curve animates over the
remaining interval. Fit mode includes curve overshoot and stroke width. If a log
ends before a completion record, the last recorded point bounds that stroke and
the helper reports this fallback. Other edits occur at their recorded timestamps.
The selected final state is included as a frame; duration is rounded
up to the frame interval, with one final frame. `--speed` changes playback speed.

New historical snapshots carry optional `replay` context (board, timestamp,
sequence, activity point, and empty Pencil placeholders) in the existing version-1
`.wbo` format. Ordinary imports ignore it. Replay checks that context against the
log. For older snapshots without an embedded timestamp, `--snapshot-at` supplies
their time in the same format; if omitted, the history start is assumed. It cannot
override a known embedded timestamp. Their initial camera defaults to the origin,
overridable with `--initial-point X Y`.
An older snapshot omitting a pending empty Pencil may need to be downloaded again.

Replay never overwrites output files and publishes the MP4 only after encoding
succeeds. Replay input limits default to **256 MiB compressed and 1 GiB decompressed
per file**, adjustable with `--max-archive-bytes` and `--max-json-bytes`. History
parsing streams lines instead of keeping the entire decompressed text in memory.
Images are piped to ffmpeg with backpressure rather than saved as a directory of
frames. Resolution
dimensions must be even, 2–7680; frame rate is 1–120. The renderer rejects malformed
history, sequence gaps, mismatched snapshots, histories exceeding four million
records, and jobs exceeding ten million frames.
Rendering time and memory depend on board complexity, duration, and resolution.
The parsed timeline and board still occupy memory while rendering.

For capacity planning, a synthetic two-hour run using the actual history record
format, 3,600 two-second Pencil strokes, randomized integer coordinates, and
conservatively long IDs measured:

| Point rate | Points | Uncompressed JSON | Downloaded gzip |
| --- | ---: | ---: | ---: |
| 50/second (approximately the default write-rate ceiling) | 360,000 | 91.8 MiB | 15.5 MiB |
| 240/second (stress case above the default rate) | 1,728,000 | 436.9 MiB | 72.9 MiB |

These totals include stroke creation, completion and Bézier controls, but exclude
any pre-existing board checkpoint or bulk imports. The limits leave over 2.3×
decompressed and 3.5× compressed headroom over the stress case; its 1,735,200
records also fit below the record limit. Ordinary writing with pauses is smaller.

### Seminar audio recording and replay

The helper's `record` command captures selected microphones and application
audio on **Linux and Windows**. With no `--source` or `--process`, it opens a
numbered terminal selection menu; choose multiple numbers separated by commas,
`r` to refresh, or `q` to cancel. `--list-sources` lists IDs without recording.
No audio is uploaded to WBO. Clock synchronization alone contacts the server.

- **Linux:** install `pactl` and `parec` (usually `pulseaudio-utils`) and use a
  running PulseAudio or PipeWire PulseAudio-compatible server. `--source` accepts
  a source name or `default`. `--process` accepts an application's audio PID from
  the list. Only its matching playback streams are monitored; output routing is
  unchanged. Streams opened later by the same PID are discovered once per second.
  Each stream gets a separate recording; reopening a stream starts a new file.
  Discovery handles monitor names or source indices in `pactl` JSON; missing
  monitors omit affected playback streams while microphone choices remain available.
  Start application playback if its PID is absent from the list. A restarted
  application with a new PID must be selected in a new recording session.
- **Windows:** use Python 3.10+ and Windows PowerShell 5.1 or PowerShell 7. The
  bundled C# WASAPI bridge compiles automatically with PowerShell `Add-Type`;
  Visual Studio and additional Python packages are unnecessary. `--source`
  accepts a capture endpoint ID or `default`. Process capture includes the PID's
  child processes and requires **Windows build 20348 or newer**, including Windows
  11, following the [Microsoft process-loopback API](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/).
  Older Windows versions can record microphones but reject process loopback.
  Allow microphone access for desktop apps in Windows settings. Avoid selecting
  both a parent process and its child, which would duplicate their shared audio.

Examples below use `python3`; on Windows use `python`:

```sh
python3 scripts/seminar_helper.py record --list-sources
python3 scripts/seminar_helper.py record seminar-audio --server http://localhost:8080
python3 scripts/seminar_helper.py record seminar-audio-cli --server http://localhost:8080 --source default --process 12345 --duration 7200
python3 scripts/seminar_helper.py record --lang zh-CN --help
python3 scripts/seminar_helper.py record --lang zh-TW --help
```

Repeat `--source` and `--process` to select more inputs (up to 32 selections).
Omit `--duration` to record until Ctrl+C. The output directory must not already
exist. `--pactl`, `--parec`, and `--powershell` override capture executable paths.
Compressed recording requires **ffmpeg with the libopus encoder** on PATH on
both platforms; `record --ffmpeg PATH` overrides its location. Replay has the
same executable option. `--list-sources` does not require ffmpeg.

Each source now streams to `source-NNN.opus` plus `source-NNN.audio.jsonl` timing
metadata. The default is **64 kbps stereo Opus**, a lossy audio codec: two hours
uses about **60 MB per source**, plus roughly 1–2 MB of timing metadata, instead
of 1.38 GB of PCM. A microphone and one meeting stream together use about
120–124 MB. `--audio-bitrate 32` reduces audio to about 31 MB per source at lower
quality; the allowed range is 16–256 kbps. `--audio-format pcm` retains the old
uncompressed 48 kHz stereo 16-bit format and needs no ffmpeg during recording.
Existing PCM recordings remain compatible with replay and can be mixed with
Opus recordings. History archive limits do not apply to audio.

Keep audio and timing files together with their original basenames. The encoder
runs continuously, writing Ogg pages about every 100 ms. Once per second, the
helper queues a timing checkpoint; it commits that checkpoint only after all
its samples have been encoded and the corresponding complete pages flushed to
disk. An interrupted session remains replayable through its last committed
checkpoint, normally losing about a second of recent audio plus encoder/disk
buffering. No final container index or successful shutdown is required. Replay
checks page integrity, accounts for Opus encoder delay, and ignores uncommitted
trailing bytes. It uses a temporary copy of the compressed committed prefix,
without expanding a whole recording to PCM on disk. `clock.jsonl` records clock
calibration samples. This storage path is shared by Linux and Windows.

The new public `GET /time` endpoint returns only `{now: <Unix milliseconds>}`,
with caching disabled, and works behind the existing deployment base path.
The helper takes five samples, chooses the lowest round-trip time, and maps
capture timestamps through a monotonic clock. It refreshes every 30 seconds
(`--sync-interval` changes this). A failed initial calibration stops recording;
later outages report a warning and retain the last calibration. No moderator
credentials are required to read the clock. Windows uses WASAPI packet timestamps;
Linux estimates capture time from delivery and the requested `--latency-ms`
(default 20). Reported network uncertainty excludes device and scheduling latency.

Supply timing files to replay with repeated `--audio`:

```sh
python3 scripts/seminar_helper.py replay seminar-with-audio.mp4 \
  --snapshot start.wbo --history edits.jsonl.gz \
  --start 2026-09-16T09:30:00Z --end 2026-09-16T10:30:00Z \
  --audio seminar-audio/source-001.audio.jsonl \
  --audio seminar-audio/source-002.audio.jsonl
```

Replay ignores recordings outside the video interval, trims excess audio, leaves
silence before a source starts and after it ends, and mixes overlapping sources
with clipping protection. Timing checkpoints correct clock drift and preserve
capture gaps. `--speed` changes audio tempo with the video while preserving pitch.
Up to 32 recording files can be supplied; duplicate paths are used once. Audio
metadata is bounded to 16 MiB and 100,000 records per source. Replay validates
timestamps and committed sample counts before rendering, ignores an incomplete
last journal line, and never overwrites the output video.

### Personal scroll controls

Use the scroll selector beside the view-mode selector to choose:

- **Scroll: zoom** (default): scroll up/down to zoom in/out.
- **Scroll: move · Ctrl: zoom**: scroll up/down acts like the Up/Down arrow
  keys; hold Ctrl while scrolling to zoom.

This is your personal browser preference, remembered across boards and reloads.
It does not change anyone else's controls or the saved board settings. In Free
view, scrolling moves 64 screen pixels; in chunk focus, it moves one chunk with
the usual smooth animation. In latest-edit focus, pause briefly and scroll in
the same direction again within two seconds to switch to chunk focus and move.
A continuous wheel/trackpad gesture cannot confirm that switch. Shift+scroll
panning and S/O+scroll size/opacity shortcuts remain available. Focused views
retain their existing fit-to-chunk zoom; choose Free to zoom manually.

### Canvas chunks and following activity

Choose a view mode beside the Users control:

| Mode | Arrow keys | Ctrl+Arrow keys |
| --- | --- | --- |
| **Free** | Move 64 screen pixels | Move one configured chunk, preserving zoom |
| **Focused on chunk** | Move one chunk | Move one chunk |
| **Focused on last edited chunk** | Show a navigation reminder | Show a navigation reminder |

Free mode allows normal panning and zooming. Both focused modes center and fit
an entire chunk with its configured margin. Chunk focus stays on the selected
chunk when other content changes; latest-edit focus follows accepted edits.
In latest-edit focus, press the same arrow shortcut again within two seconds to
switch to chunk focus and move one chunk. The direction and Ctrl modifier must
match; holding a key does not confirm the change. Shortcuts leave forms and text
editing alone. View mode and selected chunk are remembered for this board and
browser. Cursor movement and rejected edits do not move the camera.

Chunk changes ease into position. When your pencil stroke reaches another
chunk, your camera waits until you finish the stroke. If another user's edit
moves your camera, your current stroke ends first. Pencil input is blocked
throughout the transition; release and press again to start a new stroke once
the camera stops. Reduced-motion preferences disable the animation.

Board moderators can open **Chunk settings** to set width, height, and the
margin around each chunk, in unscaled board units. Width and height accept
100–100,000; the margin accepts 0–100,000. Defaults are 10,000 × 7,000 with a
500-unit margin. Chunk boundaries start at (0, 0) and appear as thick, dark gray
lines once configured or using a focused mode. Configured boundaries remain
visible in every view mode, including when Grid is off. The camera fits the whole
chunk plus the margin and leaves the tool rail clear, including on resize and
near the canvas origin.

**View mode for other users** applies the selected mode to ordinary viewers and
editors once when a moderator saves settings. Everyone remains free to change
their mode immediately, including through the double-press override. Moderator
locking has been removed. Other moderators keep their own view mode. New users
start with the current board setting; personal choices survive reconnects unless
a new moderator revision applies another setting. Temporary moderators can
manage these settings while their grant is active. Previously saved follow/lock
settings migrate to the corresponding freely changeable view mode.

Activity uses the last accepted stroke point, or the center of the modified
object's bounding box for shapes, text, transforms, copies, and erases. A batch
uses its last spatial edit; clearing returns to the first chunk. Configured settings and
the latest activity position are stored in the board SVG, including for empty
boards. Native `.wbo` backups also save chunk dimensions, margin, and the board's
default view mode. Uploading a backup restores these settings and updates
connected viewers. Older backups without chunk settings retain the destination's
current settings.

The Python helper reads settings with no options, or updates selected fields:

```sh
python3 scripts/seminar_helper.py chunks --server http://localhost:8080 --board seminar
python3 scripts/seminar_helper.py chunks --server http://localhost:8080 \
  --board seminar --private-key-file moderator.json \
  --width 10000 --height 7000 --margin 500 --view-mode latest
```

The API is `GET` / `POST /chunks/{board}`. POST requires moderator permission,
`Content-Type: application/json`, `X-WBO-Chunks: 1`, and all four settings:
`{"width":10000,"height":7000,"margin":500,"viewMode":"latest"}`.
`viewMode` accepts `free`, `chunk`, or `latest`; the helper's `--view-mode`
replaces its previous `--follow` and `--locked` options.
The server assigns a revision and activity position; clients cannot supply them.
Requests are limited to 2 KiB and ten updates per board per ten seconds.
Existing JWT, v1, and v2 authentication work over HTTP and HTTPS; v2 signatures
bind POSTs to their exact bodies. `--user-secret` / `WBO_USER_SECRET` and
`--token` / `WBO_TOKEN` also work with the helper.

### Moderator authentication over HTTP or HTTPS

`WBO_BOARD_MODERATORS` accepts space-separated `board:value[,value]` groups.
Values can be mixed on the same board:

- **32 hexadecimal characters:** an existing v1 cookie secret.
- **64 hexadecimal characters:** a 32-byte Ed25519 **public** key. The client must
  prove possession of the corresponding private key by signing a fresh server
  challenge. Sending the public key alone never grants access.

For example, replace the placeholders with real keys before starting the server:

```sh
WBO_BOARD_MODERATORS='seminar:<v1-secret>,<v2-public-key> other-board:<another-v2-public-key>' npm start
```

The browser stores the 32-byte private seed as 64 hex characters in **localStorage**
under `wbo-user-secret-v2-private`. It is never put in a cookie or sent to the
server. Only `wbo-user-secret-v2-public` is a cookie. This deliberately avoids a
private-key cookie, which browsers would automatically transmit. On board
startup, the browser automatically generates a random pair if either key is
missing or malformed, or if the stored keys do not match. It preserves a valid
matching pair across reloads. Replacing a pair changes the public key; update
the moderator configuration if the previous key had moderator access. Existing
v1 and JWT authentication continue to work. Remove old v1 values from the
moderator configuration when you want to retire them.

To retrieve your identity's public key, open a board URL and run the following in
its developer console. It works on HTTP as well as HTTPS, and returns the public
key to add to `WBO_BOARD_MODERATORS`:

```js
const auth = await import(new URL('../js/board_auth_v2.js', location.href).href);
await auth.createIdentity();
```

This also creates or repairs the pair when needed. To use a key generated by the
Python helper below, run `await auth.setIdentity('...')` with the **privateKey**
field from your local key file, then reload the board. Keep that key file locally;
uploading it to the whiteboard server is unnecessary. Browser storage is scoped
to the origin, so another hostname, port, or protocol has separate storage.
V2 presence and temporary moderator grants use the verified public-key identity.

The browser uses the bundled [TweetNaCl.js signer](client-data/vendor/tweetnacl/README.md),
without requiring Web Crypto's secure-context-only APIs. V2 sockets require
WebSocket support (`ws://` on HTTP, `wss://` on HTTPS); proxies must pass WebSocket
upgrades. HTTP polling is rejected for v2 because its session ID could otherwise
be reused as a bearer credential. Normal v1 connections retain their transports.
Reverse proxies should preserve the public Host, or supply `X-Forwarded-Host`
and `X-Forwarded-Proto`, consistently with WBO's existing URL handling.

V2 keeps reusable private credentials off the network and server. It does **not**
encrypt board traffic or make an actively intercepted HTTP connection secure:
an attacker who can change delivered JavaScript can steal or use browser-local
keys, and an on-path attacker can alter unencrypted traffic. A malicious host
serving the app's JavaScript has the same limitation. HTTPS and trusted client
code remain necessary against those threats.

### V2 challenge protocol

`POST /auth/v2/challenge` (under `WBO_BASE_PATH`) accepts `application/json`:

```json
{"board":"seminar","publicKey":"<64 hex characters>","scope":"socket","bodyHash":""}
```

For HTTP, `scope` is the uppercase method, a colon, and the **public pathname**,
such as `GET:/archive/seminar` or `POST:/wbo/archive/seminar`. POST archive proofs
include the SHA-512 hash of the exact compressed body as 128 lowercase hex
characters in `bodyHash`; other requests use an empty string. The response is
`{"challenge":"<string to sign verbatim as UTF-8>"}`. The string encodes the JSON
array `["wbo-auth-v2", audience, board, scope, publicKey, bodyHash, nonce, expiresAt]`,
where the audience is the public origin plus base path, the nonce is 32 random
bytes in hex, and expiry is Unix milliseconds.

Clients check that the challenge matches their intended origin, board, operation,
and body before signing. Send `<nonce>.<128-hex-signature>` in `X-WBO-Auth-V2`
for HTTP or Socket.IO's handshake `auth: {v2: "<proof>"}` for sockets. Private
board navigation uses a small authentication shell and a one-use `authV2` query
parameter, removed from the address bar as the board boots. Authenticated HTTP
responses use `Cache-Control: no-store`; no v2 bearer-session cookie is issued.
Proofs expire after 60 seconds, are consumed on verification attempts, and cannot
be reused for another operation or board. At most 4,096 challenges are pending
per server, with at most 32 per IP; excess requests receive HTTP 429. Challenge
state is process-local and is discarded on restart.

### Python helper

The helper requires Python 3.10 or newer. Legacy v1/JWT archive operations use
only the standard library:

```sh
python3 scripts/seminar_helper.py export seminar.wbo --server http://localhost:8080 --board seminar
python3 scripts/seminar_helper.py import seminar.wbo --server http://localhost:8080 --board restored-seminar
```

For imports, supply a moderator identity for the destination board.
`--server` accepts an installation base path, such as `https://example.org/wbo`.
Use `--token` (or `WBO_TOKEN`) for an existing board JWT, and `--user-secret` (or
`WBO_USER_SECRET`) for an existing `wbo-user-secret-v1` cookie. The helper does not
overwrite existing export files. `--max-archive-bytes` and `--max-json-bytes`
override its matching 64/256 MiB local limits when the server permits more.

Moderators retain their normal Turnstile bypass on protected public boards.

For v2 key generation and authentication, install the optional dependency:

```sh
python3 -m pip install -r scripts/requirements-seminar.txt
python3 scripts/seminar_helper.py keygen moderator-key.json
python3 scripts/seminar_helper.py export seminar.wbo --server http://localhost:8080 --board seminar --private-key-file moderator-key.json
python3 scripts/seminar_helper.py import seminar.wbo --server http://localhost:8080 --board seminar --private-key-file moderator-key.json
```

Add the public key printed by `keygen` to the destination's moderator configuration
before importing. Key files are created with owner-only permissions and are never
overwritten. The helper signs each HTTP operation locally and refuses redirects.
The server receives the public key, a fresh signature, and the requested archive
data; it never receives the key file or private seed.

The HTTP interface is `GET /archive/{board}` for download and
`POST /archive/{board}` for import, under `WBO_BASE_PATH` when configured. POST
takes the gzip file directly with `Content-Type: application/gzip` and
`X-WBO-Archive: 1`. POST requires a board moderator; GET requires board viewing
access. The optional `token` query parameter carries the existing board JWT, or
the request can carry the configured moderator's v1 cookie or a v2 signature.
Success is
JSON `{ "imported": <object count>, "seq": <latest sequence> }`; errors are JSON
`{ "error": "<reason>" }`. The archive envelope is:

```json
{
  "format": "whitebophir-board",
  "version": 1,
  "items": [],
  "chunks": { "width": 4000, "height": 3000, "margin": 800, "viewMode": "free" }
}
```

`chunks` is optional and appears only when the board has configured chunk settings.
It excludes personal camera choices, source activity, and permissions.

The archive, HTTP, and Python round-trip tests run in `npm run test-node` (Python
3.10+ and `scripts/requirements-seminar.txt` are therefore required for the full
test suite). Browser coverage is in `playwright/tests/archive.spec.ts` and
`playwright/tests/auth_v2.spec.ts`, including a non-secure HTTP origin.

### Corresponding source

This fork retains the project's AGPL-3.0-or-later license and upstream notices.
When deploying the modified version, publish its complete corresponding source,
including these changes, under the same license and set `WBO_SOURCE_URL` to that
source URL. This updates the source links on the homepage and in the board's
Download dialog. The default URL points to upstream and must be replaced for a
deployment of this modified version.

## Screenshots

<table>
 <tr>
  <td> The <i><a href="https://wbo.ophir.dev/boards/anonymous">anonymous</a></i> board
  <td> <img width="300" src="https://user-images.githubusercontent.com/552629/59885574-06e02b80-93bc-11e9-9150-0670a1c5d4f3.png">
  <td> collaborative diagram editing
  <td> <img alt="Screenshot of WBO's user interface: architecture" width="300" src="https://user-images.githubusercontent.com/552629/59915054-07101380-941c-11e9-97c9-4980f50d302a.png" />
  
  <tr>
   <td> teaching math on <b>WBO</b>
   <td> <img alt="wbo teaching" width="300" src="https://user-images.githubusercontent.com/552629/59915737-a386e580-941d-11e9-81ff-db9e37f140db.png" />
   <td> drawing art
   <td> <img alt="kawai cats on WBO" width="300" src="https://user-images.githubusercontent.com/552629/120919822-dc2c3200-c6bb-11eb-94cd-57a4254fbe0a.png"/>
</table>

## Running your own instance of WBO

If you have your own web server, and want to run a private instance of WBO on it, you can. It should be very easy to get it running on your own server.

### Running the code in a container (safer)

If you use the [docker](https://www.docker.com/) containerization service, you can easily run WBO as a container.
An official docker image for WBO is hosted on dockerhub as [`lovasoa/wbo`](https://hub.docker.com/r/lovasoa/wbo): [![WBO 1M docker pulls](https://img.shields.io/docker/pulls/lovasoa/wbo?style=flat)](https://hub.docker.com/repository/docker/lovasoa/wbo).

You can run the following bash command to launch WBO on port 5001, while persisting the boards outside of docker:

```bash
mkdir wbo-boards # Create a directory that will contain your whiteboards
chown -R 1000:1000 wbo-boards # Make this directory accessible to WBO
docker run -it --publish 5001:80 --volume "$(pwd)/wbo-boards:/opt/app/server-data" lovasoa/wbo:latest # run wbo
```

You can then access WBO at `http://localhost:5001`.

The official Docker image does not force an IP source. By default the application uses `WBO_IP_SOURCE=remoteAddress`. If you run the container behind a trusted proxy or CDN, set `-e WBO_IP_SOURCE=...` explicitly, for example `X-Forwarded-For`, `Forwarded`, or `CF-Connecting-IP`.

### Running the code without a container

Alternatively, you can run the code with [node.js](https://nodejs.org/) directly, without docker.

First, download the sources:

```
git clone https://github.com/lovasoa/whitebophir.git
cd whitebophir
```

Then [install node.js](https://nodejs.org/en/download/) (v22 or superior)
if you don't have it already, then install WBO's dependencies:

```
npm install --production
```

Finally, you can start the server:

```
PORT=5001 npm start
```

This will run WBO directly on your machine, on port 5001, without any isolation from the other services. You can also use an invokation like

```
PORT=5001 HOST=127.0.0.1 npm start
```

to make whitebophir only listen on the loopback device. This is useful if you want to put whitebophir behind a reverse proxy.

### Running WBO on a subfolder

By default, WBO launches its own web server and serves all of its content at the root of the server (on `/`).
If you want to make the server accessible with a different path like `https://your.domain.com/wbo/` you have to setup a reverse proxy.
Set `WBO_BASE_PATH=/wbo` so generated links, redirects, and canonical URLs point at the external subfolder.
See instructions on our Wiki about [how to setup a reverse proxy for WBO](https://github.com/lovasoa/whitebophir/wiki/Setup-behind-Reverse-Proxies).

## Translations

WBO is available in multiple languages. The translations are stored in [`server/http/translations.json`](./server/http/translations.json).
If you feel like contributing to this collaborative project, you can [translate WBO into your own language](https://github.com/lovasoa/whitebophir/wiki/How-to-translate-WBO-into-your-own-language).

## Authentication

WBO supports authentication using [Json Web Tokens](https://jwt.io/introduction). Pass the token as a `token` query parameter, for example `http://myboard.com/boards/test?token={token}`.

The `AUTH_SECRET_KEY` variable in [`configuration.mjs`](./server/configuration.mjs) should be filled with the secret key for the JWT.

### Board Capabilities

WBO evaluates board access as three capabilities:

- `canOpen`: the user may load or connect to the board.
- `canEdit`: the user may send normal board changes.
- `canClear`: the user may use the Clear tool, which wipes all content from the board.

JWT role strings can define these capabilities. They are declared in the JWT payload:

```json
{
  "iat": 1516239022,
  "exp": 1516298489,
  "roles": ["editor"]
}
```

### Board Visibility / Access

If `AUTH_SECRET_KEY` is not set, any valid board URL has `canOpen`.

If `AUTH_SECRET_KEY` is set, `canOpen` requires a valid token. You can restrict which board names a token may open by adding `:<boardName>` to a claim:

```json
{
  "roles": ["editor:board-a", "moderator:board-b", "reader:board-c"]
}
```

- `reader:<boardName>` grants `canOpen` for that board.
- `editor:<boardName>` grants `canOpen` for that board and is edit-capable on read-only boards.
- `moderator:<boardName>` grants `canOpen` for that board, is edit-capable on read-only boards, and grants `canClear`.

For example, `http://myboard.com/boards/mySecretBoardName?token={token}` with:

```json
{
  "iat": 1516239022,
  "exp": 1516298489,
  "roles": ["moderator:mySecretBoardName"]
}
```

If a token contains any board-scoped claims, it can only open the boards named in those claims.

Phase 1 of the capability refactor does not add new permission types, board owners, administrators, sharing controls, or permission management UI. Existing JWT claim syntax remains unchanged.

### Board Editability / Read-Only

Board visibility and board editability are separate.

- On a read-only board, only `editor` and `moderator` claims still grant `canEdit`.
- On instances without JWT authentication, a read-only board does not grant `canEdit` because there is no authenticated edit-capable claim.
- Without JWT authentication, `canClear` is never granted.
- With JWT authentication, only `moderator` claims grant `canClear`.

Read-only state is stored on the persisted board SVG root as `data-wbo-readonly`:

```xml
<svg id="canvas" ... data-wbo-readonly="true">
```

Legacy `.json` board files may still use `__wbo_meta__.readonly`; when they are loaded, WBO migrates that metadata into the stored SVG format.

### How To Change Board Visibility

- Without JWT auth: visibility is controlled by sharing or not sharing the board URL.
- With JWT auth: visibility is controlled by the token you issue. Add or remove board-scoped claims to decide which boards a token may open.
- Use `editor` or `moderator` claims for users who should edit read-only boards.
- Use `reader:<boardName>` for users who should only view a read-only board.

### How To Change A Board Between Writable And Read-Only

1. Find the board SVG file in `WBO_HISTORY_DIR`. The filename is `board-${boardName}.svg`.
2. Add or update the root `data-wbo-readonly` attribute in that file.
3. Reload the board after it is unloaded from memory, or restart the server, so the new state is picked up.
4. Set the attribute to `false` to make the board writable.

## Configuration

When you start a WBO server, it loads its configuration from several environment variables.
You can see a list of these variables in [`configuration.mjs`](./server/configuration.mjs).
Some important environment variables are :

- `WBO_HISTORY_DIR` : configures the directory where the boards are saved. Defaults to `./server-data/`.
- `WBO_BASE_PATH` : optional external URL path prefix, such as `/wbo`, for deployments mounted under a reverse-proxy subfolder.
- `WBO_HTML_HEAD_SNIPPET_PATH` : optional path to an HTML snippet inserted raw before `</head>` on rendered HTML pages. This is useful for adding user analytics scripts or similar trusted snippets. The file is read once at server startup; relative paths resolve from the server working directory.
- `WBO_MAX_EMIT_COUNT` : the general per-IP socket write limit profile. Use compact entries such as `*:250/5s anonymous:125/5s`. Increase this if you want smoother drawings, at the expense of making denial-of-service bursts cheaper for clients. The default is `*:250/5s`.
- `WBO_MAX_CONSTRUCTIVE_ACTIONS_PER_IP` : the constructive per-IP write limit profile. Use compact entries such as `*:40/10s anonymous:20/10s`.
- `WBO_MAX_DESTRUCTIVE_ACTIONS_PER_IP` : the destructive per-IP write limit profile. Use compact entries such as `*:190/60s anonymous:95/60s`.
- `WBO_IP_SOURCE` : which request attribute to trust for client IP based limits and logs. Supports `remoteAddress`, `X-Forwarded-For`, `Forwarded`, or a custom header such as `CF-Connecting-IP`. The default is `remoteAddress`.
- `AUTH_SECRET_KEY` : If you would like to authenticate your boards using jwt, this declares the secret key.

## Troubleshooting

If a stored board SVG becomes unreadable, WBO quarantines the broken file and
falls back to any readable board state it can still load.

If you experience an issue or want to propose a new feature in WBO, please [open a github issue](https://github.com/lovasoa/whitebophir/issues/new).

## Monitoring

If you are self-hosting a WBO instance, you may want to monitor its load,
the number of connected users, request latency, and board lifecycle events.

WBO now uses OpenTelemetry for metrics, logs, and traces on the server side.
Configure a standard OTLP exporter with the usual `OTEL_*` environment variables.

Example:

```sh
docker run \
  -e OTEL_SERVICE_NAME=whitebophir-server \
  -e OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318 \
  lovasoa/wbo
```

Common settings:

- `OTEL_SERVICE_NAME`
- `OTEL_RESOURCE_ATTRIBUTES`
- `OTEL_EXPORTER_OTLP_ENDPOINT`
- `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`
- `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`
- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
- `OTEL_EXPORTER_OTLP_HEADERS`

Socket connection replay is reported with `wbo.socket.connection_replay` and
`wbo.socket.connection_replay.gap`. The replay outcome attribute distinguishes
empty replays, sent replay batches, stale baselines, future baselines, and
internal errors.

Traces default to a 5% parent-based sample rate when no standard
`OTEL_TRACES_SAMPLER*` setting is provided. For short debugging sessions, force
full trace capture explicitly:

```sh
OTEL_TRACES_SAMPLER=parentbased_traceidratio \
OTEL_TRACES_SAMPLER_ARG=1.0 \
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318 \
npm start
```

If no OTLP endpoint is configured, WBO still emits canonical server log lines to stdout/stderr but does not attempt remote export.

## Download SVG preview

To download a preview of a board in SVG format you can got to `/preview/{boardName}`, e.g. change https://wbo.ophir.dev/board/anonymous to https://wbo.ophir.dev/preview/anonymous. The renderer is not 100% faithful, but it's often good enough.
