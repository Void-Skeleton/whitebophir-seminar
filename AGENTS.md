# wbo online whiteboard

WBO is an online collaborative drawing app. This file is the working guide for
agents changing the repository.

## general instructions

- Keep changes narrow, readable, and consistent with nearby code.
- Treat HTTP and socket input as hostile. Malformed requests and socket messages must be rejected deterministically and must not crash the process.
- When behavior, paths, protocol shape, test commands, or ownership documented here changes, update this file.

## project contract

- CI is the source of truth for required checks: [.github/workflows/CI.yml](./.github/workflows/CI.yml).
- Local baseline: `npm install`, `python3 -m pip install -r scripts/requirements-seminar.txt`, `npx playwright install chromium`, ffmpeg/ffprobe on PATH, then `npm test`.
- `npm test` runs the Node suite, Playwright suite, and Biome lint. It does not run typecheck or benchmarks.
- Use `npm run typecheck` for the unified JS typecheck.
- Use `npm run bench` before and after changes, only for suspected hot-path, persistence, replay, or broadcast-throughput changes.

## source of truth

Read this section as the normal flow of a board page and a board write. Use
these files as the first place to look, and avoid duplicating owned behavior in
other modules.

### server startup and HTTP routing

Server startup begins in the [server entrypoint](./server/server.mjs), which
defines the HTTP route list and passes it with a runtime from
[create_runtime.mjs](./server/runtime/create_runtime.mjs) into
[boot.mjs](./server/runtime/boot.mjs). Boot owns the Node HTTP server,
history-directory checks, Socket.IO startup, listen, shutdown, and client-error
handling.

Startup configuration is parsed by [configuration.mjs](./server/configuration.mjs)
with shared env helpers from [helpers.mjs](./server/configuration/helpers.mjs).
Runtime logging, metrics, and tracing start from
[observability/index.mjs](./server/observability/index.mjs), with setup details
in [logging.mjs](./server/observability/logging.mjs) and metric utilities in
[metric_helpers.mjs](./server/observability/metric_helpers.mjs).
`WBO_BASE_PATH` public path handling lives with request URL parsing.

Every HTTP request passes through [dispatch.mjs](./server/http/dispatch.mjs),
where URL validation, route matching, route-level access checks, request
observation, and error responses are wired together. Supporting HTTP behavior is
kept beside it: [cache_policy.mjs](./server/http/cache_policy.mjs) chooses cache
headers, [compression.mjs](./server/http/compression.mjs) wraps compressed
responses, [templating.mjs](./server/http/templating.mjs) renders HTML shells,
and [observation.mjs](./server/http/observation.mjs) records and reports
request outcomes.

### serving a board page

Serving `/boards/{board}` is handled by
[board_page.mjs](./server/routes/board_page.mjs), with shared normalization,
ETag, cookie, and replay-baseline helpers in
[board_http_helpers.mjs](./server/routes/board_http_helpers.mjs). That route
normalizes the board name, checks board access, handles redirects and ETags,
reads the stored board document, pins the served baseline sequence for replay,
sets the user-secret cookie, and streams the board HTML shell around the SVG
baseline. Board SVG, preview, export, and download routes are in
[board_assets.mjs](./server/routes/board_assets.mjs); index redirects,
random-board redirects, and static fallbacks are in
[static.mjs](./server/routes/static.mjs).

Native compressed backups use `GET` and `POST /archive/{board}` in
[board_archive.mjs](./server/routes/board_archive.mjs). The codec and validation
live in [archive.mjs](./server/board/archive.mjs). Export saves a snapshot under
the board session queue before reading its SVG and encoding internal items.
Import validates the entire archive, creates fresh IDs, and atomically adds
objects under the same queue, then records and broadcasts ordinary sequenced
mutations. It preserves existing content and rejects capacity overflow. Import
requires board moderator access (`permissions.canBan()`), rechecked under the
session queue. It also enforces HTTP editing permissions, blocked-tool settings,
and existing Turnstile policy. Permanent and active temporary moderators are
supported. Its separate bulk admission limit is one attempt per IP every
10 seconds; imports require `X-WBO-Archive: 1` and
`Content-Type: application/gzip`. Limits default to 64 MiB compressed and
256 MiB decompressed, configured by `WBO_MAX_ARCHIVE_BYTES` and
`WBO_MAX_ARCHIVE_JSON_BYTES` (positive byte counts, at most 1 GiB each).
Archives are bounded to 1,000,000 generated live mutations. Native `.wbo`
files are gzip-compressed JSON `{format: "whitebophir-board", version: 1,
items: [...]}` using string tool IDs and complete item payloads in paint order.
The optional `chunks: {width,height,margin,viewMode}` field snapshots configured
board settings alongside items. Import validates it before any mutation, restores
it with a fresh revision and destination activity point, and emits `chunk_state`
to connected viewers. Settings-only archives also persist on empty boards.
Older archives without `chunks` retain the destination's current settings.
Archives may also carry `theme: "light" | "dark"`; importing it restores the
board theme and emits `theme_state`. Without `theme`, destination mode is kept.
Item colors remain canonical light-palette values in both modes.
Archive metadata never grants access or replaces destination permissions.
Timestamped history uses moderator-only `GET /history/{board}` in
[board_history.mjs](./server/routes/board_history.mjs): no time parameters returns
`{availableFrom,now}`, `at=<Unix milliseconds>` exports an ordinary `.wbo`, and
`from=<ms>&to=<ms>` streams gzip JSON Lines with inclusive bounds. Invalid or
future times return 400; times before the initial checkpoint return 416. Current
`canBan` is checked before reading and before export; v2 uses the existing GET
proof. Two exports may run concurrently per runtime.

[history.mjs](./server/board/history.mjs) owns compressed journaling and replay.
Cold socket-board load creates an initial SVG checkpoint and recovers accepted
mutations missing from SVG. Paths append `.history.jsonl.gz` to the board SVG
path. Transactions are standard concatenated gzip members with a 20-byte header:
the `WB` extra field holds total compressed member length as uint32 little-endian.
Contents are JSON Lines. Appends are datasync'd before publication. Incomplete
final members are truncated; corrupt complete members reject loading. Append
failures dispose the board and prevent SVG saves of unjournaled state. Newer SVGs
written externally add a `checkpoint` record with `reason: external_snapshot`.
No retention/deletion policy is imposed. Native `.wbo` transfers state, not logs.
Archive encoding shared with history lives in
[archive_codec.mjs](./server/board/archive_codec.mjs), without startup configuration
imports; archive API defaults/validation remain in archive.mjs.

Sessions journal mutations and eviction effects before broadcast; imports journal
mutations and settings together; chunk/theme changes journal before saving SVG.
SVG saves wait for pending journal writes. Connection replay captures state under
the session queue. Snapshot exports replay in an isolated in-memory board and
omit empty Pencil placeholders. Mutation/settings records have server `atMs`,
`startAtMs`, `endAtMs`; `stroke` records carry whole Pencil intervals and optional
`curve: {version:1,segments:[{type,values}]}` cubic geometry. Geometry uses the
live Pencil's smoothing through [curve.js](./client-data/tools/pencil/curve.js).
Active curves are maintained independently of evictable SVG point payloads and
written once on release, supersession or disconnect. Recovery rebuilds unfinished
curves from accepted point mutations before closing their intervals. Point
mutations and native snapshots remain compatible with existing readers. Internal
`active_stroke` records preserve interruption timing and are excluded from
downloads. Ranges select by `atMs`. The Python helper adds `history-info`,
`history FILE --from ... --to ...`, and `export FILE --at ...`. Coverage lives in
`test-node/board_history*.test.js` and `playwright/tests/history.spec.ts`.
Historical `.wbo` snapshots also include optional `replay` context:
`{board,atMs,seq,point,emptyPencils}`. Imports ignore it; the offline renderer uses
it to validate the starting time/sequence and preserve pending empty Pencils.
The native format/version and import capabilities are unchanged.

The helper's offline `replay OUTPUT.mp4 --snapshot ... --history ...` command is
owned by [seminar_video.py](./scripts/seminar_video.py), with English, Simplified
Chinese and Traditional Chinese CLI help/status. It invokes
[seminar_render.mjs](./scripts/seminar_render.mjs) through Node, which owns the
headless Chromium canvas, camera, SVG frame rendering, and ffmpeg PNG pipe.
[seminar_replay.mjs](./scripts/seminar_replay.mjs) validates bounded gzip inputs,
uses native archive validation and BoardData's mutation engine, and builds the
timeline. It never saves a BoardData or connects to a live board. SVG serializers,
theme resources, activity geometry, and chunk fitting use existing owners.
Chromium makes no network requests and embedded scripts are disabled.

Shared timestamp parsing and history/replay size defaults belong to
[seminar_common.py](./scripts/seminar_common.py): 256 MiB compressed and 1 GiB
decompressed per file, overridable by CLI. Native snapshot downloads retain their
64/256 MiB limits. Python history validation and Node replay history parsing
decompress incrementally; replay retains parsed future events, not a full text
copy. Replay caps histories at four million records and output at ten million
frames. README documents measured two-hour 50/240-point-per-second sizes.

Replay requires `history start <= snapshot <= video start <= video end <= history
end`. `--start`/`--end` accept Unix milliseconds or timezone-bearing ISO timestamps,
defaulting to snapshot/history end. `--snapshot-at` supplies missing legacy time;
it cannot contradict embedded time. Edits through the inclusive snapshot are
validated and skipped; intervening edits are applied before the first video frame.
Sequence checks still cover the full log and its boundary with the snapshot.
Pencil animation follows cubic Bézier arc length through
[seminar_curves.mjs](./scripts/seminar_curves.mjs), preserving any snapshot prefix;
the animated tip is split with De Casteljau subdivision. Replay validates saved
controls and endpoint agreement; older logs, snapshots and incomplete strokes
derive the same smoothing from their samples. Repeated snapshot points need not
survive SVG round trips. Completed paths are cached, and fit bounds include curve
control hulls, stroke widths and observed transforms. No extra browser boot module
is loaded. The history and replay tests cover saved controls across SVG saves and
restarts, legacy logs, partial snapshots, malformed curves, arc-length timing and
actual MP4 pixels.
Clip boundaries use the original stroke interval, including later completion
records in the supplied log. Missing completion records fall back to the last
point time and are reported.
Other edits keep their timestamp/order. Metadata and explicit SVG checkpoints
are replayed. `latest` follows chunks with a 240 ms easing, `fixed` uses a view
box, and `fit` uses all observed content bounds. Geometry defaults to board
settings (or DEFAULT_CHUNKS), with persistent CLI overrides. Borders render in
all modes. Output resolution, FPS, speed, transition, and executable paths are
configurable. Output is published without overwrite only after ffmpeg succeeds;
temporary files and child processes are cleaned up on failure/cancellation.
`test-node/seminar_replay.test.js` exercises timeline/camera validation, invokes
the Python CLI with real Chromium/ffmpeg, and decodes the MP4 to verify pixels,
frame count, dimensions and failure cleanup. CI installs ffmpeg explicitly.

Audio recording belongs to [seminar_audio.py](./scripts/seminar_audio.py).
`record DIRECTORY` selects repeatable `--source`/`--process` IDs, or opens a
numbered interactive terminal menu. `--list-sources` does not capture. Linux
uses pactl discovery and parec per-source/per-sink-input monitoring, including
new streams from selected PIDs. Discovery accepts `monitor_source` names or
source indices and the separate `monitor_source_name` field; unavailable
monitors omit affected playback streams without hiding microphone choices.
Windows uses the bundled PowerShell/C# WASAPI
bridge in `scripts/audio`; process-tree loopback requires build 20348+. It emits
`WBOA` packets: little-endian uint32 frame count, uint64 QPC nanoseconds, then
stereo s16le PCM at 48 kHz. The Python parser bounds packets to two seconds.
Capture has no third-party Python dependencies and does not upload recordings.
Compressed capture requires ffmpeg with libopus on Linux and Windows; `--ffmpeg`
overrides its path. `--audio-format opus|pcm` defaults to Opus; `--audio-bitrate`
accepts 16–256 kbps (default 64). Source listing and PCM capture do not need ffmpeg.

Each source has an `.opus` (default) or `.pcm` and `.audio.jsonl` pair.
[seminar_audio_storage.py](./scripts/seminar_audio_storage.py) owns streaming
encoding and durable journal publication. Version-2 `whitebophir-audio` headers
use `encoding: "opus"`; version 1 retains `encoding: "s16le"`. Both name the
sibling file, 48 kHz sample rate and two channels. A persistent ffmpeg process
encodes constant-bitrate Opus into Ogg pages with a 100 ms target duration.
The output reader drains complete pages independently of the capture writer.
`start {frames:0,atMs}` precedes audio; `checkpoint {frames,atMs}` commits audio
after fsync once per second. Opus checkpoints wait until the granule position
minus pre-skip covers their sample count, and add `audioBytes`, the committed
page boundary. Capture timestamps are retained while waiting for the encoder.
`resume` at the previous frame count preserves
capture gaps; `end {frames}` closes clean sessions. Timestamps are server Unix
milliseconds; checkpoints also include network uncertainty and calibration ID.
Neither format requires successful finalization; replay uses complete journal
records only. Encoder errors stop recording and preserve committed prefixes.
`clock.jsonl` contains periodic minimum-RTT calibrations of the monotonic clock.
Initial sync failure aborts; refresh failure retains the last calibration and
warns. SIGINT/SIGTERM stop capture, drain workers and preserve committed data.

[time.mjs](./server/routes/time.mjs) owns public `GET /time[?nonce=...]`, returning
only `{now}` without board access, authentication or cacheability. It accepts
bounded nonces, rejects other/duplicate query fields and non-GET methods. The
helper preserves the deployment base path and refuses clock redirects.

`replay --audio FILE.audio.jsonl` is repeatable up to 32 files. Validation and
ffmpeg alignment belong to [seminar_audio_mix.mjs](./scripts/seminar_audio_mix.mjs):
16 MiB/100,000-row metadata bounds, sibling audio paths, monotonic server anchors
and durable byte counts are checked before Chromium starts. Opus validation
streams the committed prefix and checks Ogg CRCs, sequence, headers and granules.
Replay copies only that compressed prefix into its cleaned-up temporary directory
and trims by decoded sample count, retaining compatibility with PCM recordings.
Balanced sample-to-
timestamp expressions plus resampling align recordings; trimming, silence,
mixing, limiting and pitch-preserving tempo follow the requested video interval.
No audio supplied/overlapping preserves video-only output. Windows compilation
and portable audio tests run in a dedicated CI job; the Node suite invokes
`test-node/seminar_audio_test.py` and tests synthetic recording against the real
clock route, then decodes actual MP4 audio for timing/mixing assertions. Tests
cover live encoder checkpoints, sample-exact finalization, a forcibly killed
recorder, torn tails, damaged pages, compression size, and mixed Opus/PCM replay.
V2 archive requests carry a one-use signature through `X-WBO-Auth-V2`; imports
also verify the SHA-512 digest of the exact compressed body before validation
or board mutation.

Board access decisions belong to
[board_capabilities.mjs](./server/auth/board_capabilities.mjs). Board-scoped
JWTs use [board_jwt.mjs](./server/auth/board_jwt.mjs) and the generic helpers in
[jwt.mjs](./server/auth/jwt.mjs). `WBO_BOARD_MODERATORS` grants the existing
moderator role to board-specific user-secret cookies through
[board_moderators.mjs](./server/auth/board_moderators.mjs). Its values can mix
32-hex v1 cookie secrets and 64-hex Ed25519 public keys. Only a verified v2
signature may turn a public key into moderator access. Challenge issuance and
verification live in [user_key_v2.mjs](./server/auth/user_key_v2.mjs), exposed by
`POST /auth/v2/challenge` in [auth_v2.mjs](./server/routes/auth_v2.mjs). HTTP board
permission helpers consume proofs before reading board data. The ordinary
user-secret cookie is handled by
[user_secret_cookie.mjs](./server/auth/user_secret_cookie.mjs), and board-name
normalization shared with the browser is in
[board_name.js](./client-data/js/board_name.js).

V2 private keys are 32-byte Ed25519 seeds stored as 64 hex characters in browser
localStorage under `wbo-user-secret-v2-private`; they must never be cookies or
network payloads. The public-key cookie `wbo-user-secret-v2-public` is only a
hint for the private-board authentication shell, never proof of access. The
lazy [board_auth_v2.js](./client-data/js/board_auth_v2.js) module uses the bundled
[TweetNaCl.js](./client-data/vendor/tweetnacl/README.md) signer on HTTP and HTTPS.
It loads during socket startup, after the initial viewport is restored, or for
explicit key setup. Before signing, it preserves a valid matching local seed and
public cookie, or generates and stores a fresh random pair when either half is
missing, malformed, or mismatched. An empty IndexedDB store serializes key
replacement across tabs on HTTP and HTTPS; it never stores key material.
Private board pages first serve [auth-v2.html](./client-data/auth-v2.html) without
board contents,
then [board_auth_gate.js](./client-data/js/board_auth_gate.js) signs a one-use
navigation proof. Signed HTTP responses are not cacheable. Native SVG baseline
refresh and backup requests use the connection module's `fetchBoard` helper.

The board HTML shell in [board.html](./client-data/board.html) carries the
chrome, embedded configuration/translations/board state, and inline
authoritative `<svg id="canvas">` baseline with `<g id="drawingArea">`.

### browser boot and runtime

The browser starts in [board_main.js](./client-data/js/board_main.js). It uses
[board_bootstrap.js](./client-data/js/board_bootstrap.js) and
[app_tools_core.js](./client-data/js/app_tools_core.js) to create a minimal
runtime shell, then [board_dom_bootstrap.js](./client-data/js/board_dom_bootstrap.js)
attaches the server-rendered board DOM and reads the inline baseline sequence.
After the viewport is restored, [board.js](./client-data/js/board.js) hydrates
the full runtime.
The board boot process is carefully crafted to prioritize which assets are loaded first in order to arrive at an interactive zoom+pan board ASAP. Be careful never to add unnecessary cruft on the critical path. Adding a new frontend file that has to be carefully considered for boot time impact.

[app_tools.js](./client-data/js/app_tools.js) assembles that full runtime from
modules in [board_full_runtime_modules.js](./client-data/js/board_full_runtime_modules.js)
and shared classes in [board_runtime_core.js](./client-data/js/board_runtime_core.js).
Once hydrated, viewport, zoom, pan, and canvas growth are handled by
[board_viewport.js](./client-data/js/board_viewport.js) and
[board_extent.js](./client-data/js/board_extent.js). Page chrome, status, board
access, and presence are handled by
[board_shell_module.js](./client-data/js/board_shell_module.js),
[board_status_module.js](./client-data/js/board_status_module.js),
[board_access_module.js](./client-data/js/board_access_module.js), and
[board_presence_module.js](./client-data/js/board_presence_module.js). The
frontend-only friend list is keyed by the stable, secret-derived presence
`userId`, independently of the chosen display name. Resilient local persistence
and cross-tab synchronization belong to
[board_friend_store.js](./client-data/js/board_friend_store.js), while presence
owns friend decoration and display order. Socket
connection, replay, received-message dispatch, optimistic state, and outgoing
writes are handled by
[board_connection_module.js](./client-data/js/board_connection_module.js),
[board_replay_module.js](./client-data/js/board_replay_module.js),
[board_message_module.js](./client-data/js/board_message_module.js),
[board_optimistic_module.js](./client-data/js/board_optimistic_module.js), and
[board_write_module.js](./client-data/js/board_write_module.js).

Canvas chunk settings, view modes, and arrow shortcuts are owned by
[board_chunks_module.js](./client-data/js/board_chunks_module.js), loaded with the
full runtime. Shared validation and chunk geometry live in
[board_chunks.js](./client-data/js/board_chunks.js). The viewport controller alone
fits and locks the camera, using a uniform page inset while following so the
origin can have margins; page-to-board conversion subtracts that inset. The
chunk grid stays outside drawingArea and is never a persistent board item.
Configured chunk borders stay prominent regardless of the Grid tool's fill mode
or the user's view mode. Focus changes and keyboard camera movement always ease
over 240 ms regardless of OS or browser reduced-motion settings. The animation
clock starts on its first rendered frame and caps each elapsed step at 50 ms,
so slow remote-edit rendering cannot consume the transition before it is
displayed. Pencil holds a viewport lease to defer its own camera movement until the
stroke ends. Other camera changes interrupt and commit the active stroke before
moving. Pencil ignores input while the follow camera moves and requires a fresh
press after an interruption; a held pointer must never restart drawing. The
chunks module uses the accepted frame's authoritative `mutation.socket` to
identify the drawer.
Pencil's local SVG preview follows `wbo:viewport-layout` while selected, keeping
its dimensions and dark-theme filter bounds aligned after canvas growth or zoom.
Pen-input pixel coverage is in `playwright/tests/pencil-preview.spec.ts`; delayed
camera frames and remote-viewer transitions are covered by the viewport Node
tests and `playwright/tests/chunks.spec.ts`.
The view modes are `free`, `chunk`, and `latest`. Free-mode arrows move 64 screen
pixels; Ctrl+Arrow moves one configured chunk without changing zoom. Both arrow
forms move one chunk in chunk focus. Latest-edit focus shows a status reminder
on the first press; the same direction and Ctrl modifier pressed again within
two seconds switches to chunk focus and moves. Auto-repeat does not confirm the
mode change. Inputs, editable content, dialogs and extra modifiers are excluded.
The viewport owns keyboard movement, easing, bounds and cancellation; all
keyboard camera moves interrupt Pencil and block it throughout the transition.
Chunk focus retains its chosen chunk through edits, resize and reconnect.

The personal scroll selector uses `wbo.wheelMode` in localStorage across boards;
`zoom` is the default and `navigate` maps vertical wheel input to the same
Up/Down actions via `ChunksModule.navigateByArrow`. Ctrl+wheel keeps viewport
zoom; Shift+wheel pan and S/O+wheel styling are preserved. The viewport reads
the preference during core boot, and the shell binds its selector after
hydration. Storage failures retain the session choice. This preference is
neither board metadata nor a moderator setting. Navigation wheel events are
limited to one per 120 ms, with a 180 ms gap separating gestures. Continuous
events cannot confirm leaving latest focus; a separate same-direction gesture
within two seconds can. Keyboard and wheel confirmations remain separate.
`playwright/tests/chunks.spec.ts` covers wheel navigation and user isolation.

Moderator settings use `GET` / `POST /chunks/{board}` in
[board_chunks.mjs](./server/routes/board_chunks.mjs). POST checks `canBan`, requires
`X-WBO-Chunks: 1` plus JSON, and accepts only `{width,height,margin,viewMode}`.
Dimensions are integer board units 100–100000; margin is 0–100000. Bodies are
bounded to 2 KiB, v2 proofs bind the exact body, and updates are limited to ten per
board per ten seconds. Changes save under the board session queue before publishing.
Settings use a server-generated revision; each change applies `viewMode` to
non-moderators once. All users remain free to change modes or double-press out
of latest-edit focus; moderator locks no longer exist. Moderators retain their
own mode. Personal mode and focused point are stored per board pathname and
revision in localStorage, migrating the previous local follow boolean.
The Python helper exposes `chunks --view-mode free|chunk|latest` and dimension
options. Stored legacy `follow`/`locked` metadata is migrated by
`parseStoredChunks`; HTTP updates reject those obsolete fields.

Shared canvas themes live in [board_theme.js](./client-data/js/board_theme.js),
with moderator controls in [board_theme_module.js](./client-data/js/board_theme_module.js)
loaded after initial viewport boot. `GET` / `POST /theme/{board}` shares the
bounded, moderator-authorized settings handler in `board_chunks.mjs`. POST
requires `X-WBO-Theme: 1`, JSON `{theme: "light" | "dark"}`, and a body-bound v2
proof when applicable. Chunk and theme updates share the ten-per-board-per-ten-
seconds limit and save under the session queue before broadcasting. Permanent
and temporary moderators can set the theme. The Python helper exposes
`theme --mode light|dark`; omit `--mode` to read it.

Theme metadata persists as `data-wbo-theme`, including on empty boards. Stored
SVG embeds its filter and styles, so previews and SVG exports share the board's
appearance. Only presentation changes: canonical object colors, sequence, IDs,
and geometry stay intact. Board HTML and SVG ETags include the configured theme
so a theme-only save invalidates cached appearances. A hue-preserving lightness
inversion maps black to white, white to `#202020`, and pale colors to darker
versions of the same hue.
The SVG filter works on groups and the local Pencil overlay without traversing
items; user-space filter bounds keep horizontal and vertical strokes visible.
Text caret, color picker, swatches, and style preview follow the mode. Fresh
preferences default to canonical black (white when dark); stored choices remain.
Chunk borders and regular grid/dot patterns become white in dark mode.

[server/board/chunks.mjs](./server/board/chunks.mjs) derives activity from accepted
mutations and cached canonical bounds without hydrating pencil payloads or
reading SVG. Stroke appends use their final point; other edits use the object
bounds center, batches their last spatial edit, and clear the origin. Configured
settings and activity persist in root `data-wbo-chunks` JSON, including empty
boards. Metadata is snapshotted with items during save and has its own dirty
identity so settings-only updates are written. Native archives include configured
chunk settings and restore them on upload. `test-node/board_chunks.test.js` and
`playwright/tests/chunks.spec.ts`
cover this feature; broadcast throughput is the relevant benchmark.

### tools and client messages

[manifest.js](./client-data/tools/manifest.js) defines tool identity, stable
numeric tool codes, capability requirements, live-message fields, and stored SVG
contracts. Tool order and defaults are split into
[tool-order.js](./client-data/tools/tool-order.js) and
[tool-defaults.js](./client-data/tools/tool-defaults.js). The runtime loads and
mounts tools through
[board_tool_registry_module.js](./client-data/js/board_tool_registry_module.js),
which also drains pending messages for lazy-loaded tools and owns active-tool
pointer dispatch. Shared tool exports live in
[index.js](./client-data/tools/index.js), shape behavior is shared through
[shape_contract.js](./client-data/tools/shape_contract.js) and
[shape_tool.js](./client-data/tools/shape_tool.js), and each concrete tool keeps
its interaction, DOM, rendering, cleanup, and stored-item behavior in
`client-data/tools/<tool-id>/index.js`.

The existing Download tool owns the native backup dialog alongside SVG export;
viewers can download SVG or WBO files, and board moderators also get the import
file picker. The tool reads live `permissions.canBan` and `canEdit` getters so
temporary moderator grants and revocations affect subsequent actions. All
archive actions are loaded with that tool. The Python CLI is
[seminar_helper.py](./scripts/seminar_helper.py). `WBO_SOURCE_URL` configures
the corresponding-source links in the homepage and Download dialog; deployments
of this modified version must point it at their complete modified source.
The helper's `keygen` and `--private-key-file` paths use the optional
`cryptography` dependency in [requirements-seminar.txt](./scripts/requirements-seminar.txt);
v1/JWT operations still need only Python's standard library. Key files remain
local, use owner-only permissions, and are never overwritten.

When a user interaction modifies the board, the active tool creates a live board
message with primitives from [message_common.js](./client-data/js/message_common.js),
limits from [message_limits.js](./client-data/js/message_limits.js), tool and
mutation metadata from
[message_tool_metadata.js](./client-data/js/message_tool_metadata.js), and
mutation codes from [mutation_type.js](./client-data/js/mutation_type.js). The
write module assigns a `clientMutationId` for persistent writes, captures
optimistic rollback, draws locally, applies message hooks such as extent growth,
and sends the message through
[board_transport.js](./client-data/js/board_transport.js) as a Socket.IO
`broadcast` event on the active socket.

### socket connection, replay, and writes

The Socket.IO server is started and wired in
[socket/index.mjs](./server/socket/index.mjs). On connect,
[replay.mjs](./server/socket/replay.mjs) binds and normalizes the board name,
checks board access, loads or reuses the board, compares the client's
`baselineSeq` with the board mutation log, and prepares a replay batch. The
connection then emits `boardstate` followed by a `broadcast` replay batch before
marking the socket as synced for persistent live broadcasts.

Client `broadcast` messages enter
[broadcasts.mjs](./server/socket/broadcasts.mjs) and are handled in this order:

1. Resolve the client IP and board user, then enforce Turnstile when required.
2. Apply pre-normalization rate limits with
   [rate_limits.mjs](./server/socket/rate_limits.mjs).
3. Use [policy.mjs](./server/socket/policy.mjs) and
   [message_validation.mjs](./server/socket/message_validation.mjs) to normalize
   and validate the message shape, including blocked-tool checks.
4. Apply post-normalization rate limits with the same rate-limit module.
5. Check board permissions for the normalized mutation.
6. For cursor messages, update presence and rebroadcast the ephemeral message
   without persistence.
7. For persistent mutations, serialize acceptance through the per-board
   queue in [session.mjs](./server/board/session.mjs), apply the mutation to
   [data.mjs](./server/board/data.mjs) through
   [message_processing.mjs](./server/board/message_processing.mjs), record it in
   [mutation_log.mjs](./server/board/mutation_log.mjs), and emit sequenced
   `broadcast` frames to synced clients and the sender.

[presence.mjs](./server/socket/presence.mjs) tracks connected board users,
[reports.mjs](./server/socket/reports.mjs) handles user reports,
[ban store](./server/socket/bans.mjs) tracks moderator report-to-ban state, and
[turnstile.mjs](./server/socket/turnstile.mjs) validates Turnstile tokens.
Display-name validation is shared in
[user_name.js](./client-data/js/user_name.js). The presence-owned
[board_user_name.js](./client-data/js/board_user_name.js) handles `?name=`, entry
prompts, rename dialogs, and `wbo-board-name-v1` cookies scoped to each public
`/boards/{board}` path (one-year lifetime). Socket startup passes a saved name.
The first-visit prompt waits for initial replay and a rendered frame so opening
a modal does not block board startup.
Explicit URL names override live names once and are then removed from the URL.
The homepage field supplies names to named, public, recent and random boards;
HTTP redirects preserve entry query parameters. The Python helper's `join-url`
command builds a safely encoded named board URL without making a connection.
Client and server share rate-limit math through
[rate_limit_common.js](./client-data/js/rate_limit_common.js).

On the browser side, socket `broadcast` frames are queued by the connection
module and consumed by the replay module. Replay enforces sequence order,
applies replay batches, refreshes the authoritative SVG baseline when replay is
not possible, and then passes messages to the message module. The message module
updates hooks and calls the owning tool's `draw` method; unknown tool messages
are held until that tool is booted.

### board state and persistence

In memory, [data.mjs](./server/board/data.mjs) represents a board as a
canonical item index. [canonical_items.mjs](./server/board/canonical_items.mjs)
defines item shape, [canonical_index.mjs](./server/board/canonical_index.mjs)
owns lookup and paint order, and [svg_extent.mjs](./server/board/svg_extent.mjs)
tracks the SVG extent. Mutation application stays in
[message_processing.mjs](./server/board/message_processing.mjs), while
[data_persistence.mjs](./server/board/data_persistence.mjs) owns autosave
scheduling, load, save, unload, and stale-save handling.

On disk, stored SVG is authoritative. [svg_board_store.mjs](./server/persistence/svg_board_store.mjs)
reads served baselines, loads canonical board state, writes fresh SVGs, and
rewrites existing SVGs. It relies on
[streaming_stored_svg_scan.mjs](./server/persistence/streaming_stored_svg_scan.mjs)
for structural scans,
[stored_svg_item_codec.mjs](./server/persistence/stored_svg_item_codec.mjs) for
item decode/encode, [svg_envelope.mjs](./server/persistence/svg_envelope.mjs)
for root metadata and drawing-area boundaries, and
[legacy_json_svg_migration.mjs](./server/persistence/legacy_json_svg_migration.mjs)
for legacy JSON conversion. Persistence paths and timing are configured through
`WBO_HISTORY_DIR`, `WBO_SAVE_INTERVAL`, `WBO_MAX_SAVE_DELAY`, and
`WBO_SEQ_REPLAY_RETENTION_MS`. Board moderators are configured with
`WBO_BOARD_MODERATORS` as space-separated `board:secret[,secret]` groups.

### tests, benchmarks, and profiling

Use [test-node](./test-node) for Node tests and
[playwright/tests](./playwright/tests) with
[playwright.config.ts](./playwright.config.ts) for browser integration tests.
Server benchmarks are in [benchmark-server.mjs](./scripts/benchmark-server.mjs),
profiling starts from
[profile-benchmark-server.mjs](./scripts/profile-benchmark-server.mjs), and the
peer-visible erase benchmark is
[benchmark-peer-visible-erase.mjs](./scripts/benchmark-peer-visible-erase.mjs).

## wire socket protocol

WBO uses Socket.IO. Clients connect with query fields such as `board`,
`baselineSeq`, `token`, `tool`, `color`, `size`, and optional `name`. The server
immediately emits `boardstate`, then a `broadcast` replay batch from the requested
`baselineSeq`, followed by
`chunk_state {width,height,margin,viewMode,revision,point}`. Settings changes
also emit `chunk_state`. Accepted live frames optionally include
`activityPoint: {x,y}`; the client follows it only after processing the frame in
sequence. Replay uses the final chunk snapshot instead of moving through old edits.
Connections also receive `theme_state {theme: "light" | "dark"}` after replay;
theme changes and archive restoration emit the same snapshot.

V2 clients first obtain a challenge through HTTP, then connect with Socket.IO
handshake `auth: {v2: "<nonce>.<signature>"}` over WebSocket (`ws` or `wss`). V2
proofs are rejected on polling transports. The middleware verifies and consumes
the proof before permissions, replay, or presence. A new proof is required on
each reconnect; no reusable v2 session token is issued. Verified v2 identities
use `v2:<public-key>` for presence, bans, and temporary moderator grants; legacy
v1 role checks still read the original v1 cookie separately.

Challenges encode `["wbo-auth-v2", audience, board, scope, publicKey, bodyHash,
nonce, expiresAt]` as a UTF-8 JSON string. Scope is `socket` or
`METHOD:<public pathname>`. POST archives bind their SHA-512 digest; other scopes
use an empty digest. Clients validate the full context before signing. State is
process-local, expires after 60 seconds, and is bounded to 4,096 pending
challenges with at most 32 per IP. HTTP proofs use `X-WBO-Auth-V2`; only board
HTML navigation can carry the proof in `authV2`, removed during browser boot.
V2 never treats a claimed public key or a 64-hex v1 cookie as authentication.

Live board writes are JSON messages sent on the `broadcast` event. They use
numeric `tool` codes from [client-data/tools/manifest.js](./client-data/tools/manifest.js)
and numeric mutation `type` codes from [client-data/js/mutation_type.js](./client-data/js/mutation_type.js):
`1` create, `2` update, `3` delete, `4` append, `5` batch, `6` clear, `7` copy.
The server validates client messages, rejects malformed writes with
`mutation_rejected`, and rebroadcasts accepted persistent writes as sequenced
`broadcast` frames.

Pencil completion uses `stroke_end {id}` after the client's final buffered write
for that stroke has been accepted. Only the sending socket's tracked stroke can
be closed; attempts are bounded to 200 per ten seconds. Client timestamps are
not accepted. Disconnects and interrupted processes close timing at the last
accepted point. A new stroke closes an unfinished predecessor as `superseded`.
These records do not change board sequence or broadcast drawing mutations.

Display-name changes use `set_user_name { name, socketId? }` with acknowledgement
`{ok: true, name}` or `{ok: false, error}`. The omitted target means self;
renaming another identity requires current `canBan` access. Validation and
authorization belong to [user_names.mjs](./server/socket/user_names.mjs). Every
matching live identity on that board receives ordinary `user_joined` updates
with the new `name` and `nameChosen: true`. Authentication, stable `userId`,
friends and bans remain independent of display names. Names are NFC-normalized,
trimmed, and limited to 64 UTF-16 code units, with controls, directional overrides
and unpaired surrogates rejected. Attempts are limited to ten per socket per
ten seconds, independently of drawing permissions. The browser updates its own
board cookie only from authoritative presence. Live names take precedence over
stale cookies in reconnecting tabs; no server-side name history is retained
after the last matching socket leaves.

User reports are sent by clients on the `report_user` event with a payload of
`{ "socketId": "<reported socket id>" }`. Moderator warning/ban actions add
`banDurationMs` and may add `moderationRule`. A `banDurationMs` of `0` warns
without banning, a positive number bans for that duration, and an omitted or
invalid value preserves the legacy default 15-minute ban. Ban durations are
clamped to at most one week. A user with an active edit ban receives
`boardstate.canReport: false`; the client hides report controls, and the server
also ignores any `report_user` event that user emits. Ban-aware board state also
includes `accessRefreshAfterMs`, the server-derived delay until the last active
secret/IP ban expires. The browser schedules one reconnect at that boundary so
`canEdit` and `canReport` refresh without polling. The server also ignores a
non-moderator report targeting the reporter's own socket or another socket with
the same non-empty, secret-derived user identity.

Board state and presence expose `canBan` separately from `canClear`. Moderation
UI and moderator markers use `canBan`; Clear-tool access, large-batch admission,
and destructive rate-limit bypasses use `canClear`.

Before the reported socket is closed, the server emits
`moderation_disconnect { "banDurationMs": <duration>, "source": "moderator" | "peer_report", "moderationRule"?: "<rule>" }`.
Moderator actions use `source: "moderator"`; `0` means a warning and a positive
duration means a ban. Non-moderator reports disconnect the reporter and
reported user after logging the report, emit a zero-duration notice with
`source: "peer_report"` only to the reported target, and do not ban. The client
treats a missing, unknown, or incoherent source as moderator-originated for
backward-compatible, fail-safe wording. For accepted non-moderator reports, the
server emits `user_reported` only to connected moderators on that board. The
`user_reported` payload is
`{ "reporterName": "<display name>", "reportedName": "<display name>" }`.
Moderator warning/ban actions do not emit `user_reported`; warning actions only
disconnect the reported user, while ban actions also ban the reported secret and
IP. Active moderators are protected targets based on authoritative live
capabilities, including when the reporter is a temporary moderator.

Permanent moderators use `set_temporary_moderator { socketId, durationMs }` to
grant up to one week or revoke with `0`. Grants are board-scoped, process-local,
secret-keyed across tabs, lost on restart, and cannot be delegated by temporary
moderators. Changes refresh board state and presence for every matching socket.

Client write messages normally have top-level `tool` and `type` fields.
Tool-owned batches have top-level `tool` plus `_children`; each child carries its
own mutation `type`. Normal socket batches are capped by `WBO_MAX_CHILDREN`, but
users with the existing `canClear` capability bypass that batch-size cap.
Server `broadcast` payloads are either bare ephemeral messages, sequenced
persistent mutations, or replay batches with `type: 5`, `fromSeq`, `seq`, and
`_children`.

Client `broadcast` payload examples. Comments are explanatory; they are not sent
on the wire.

```jsonc
{
  // Rectangle tool.
  "tool": 3,
  // MutationType.CREATE.
  "type": 1,
  "id": "rmou34r3xa", // Rectangle IDs are generated as "r" + base36 timestamp + base36 suffix.
  "color": "#1f2937",
  "size": 10,
  "opacity": 0.85,
  "x": 120,
  "y": 80,
  "x2": 240,
  "y2": 160,
  // Generated by the write module as "cm-" + base36 timestamp + base36 suffix.
  "clientMutationId": "cm-mou34r3xc"
}
```

```jsonc
{
  // Hand tool batch. The parent carries the tool; children carry mutation types.
  "tool": 7,
  "clientMutationId": "cm-mou34r3xd",
  "_children": [
    {
      // MutationType.UPDATE with an affine SVG transform.
      "type": 2,
      "id": "rmou34r3xa",
      "transform": { "a": 1, "b": 0, "c": 0, "d": 1, "e": 10, "f": 20 }
    },
    {
      // MutationType.COPY. Hand copies keep the source ID's first-character prefix.
      "type": 7,
      "id": "rmou34r3xa",
      "newid": "rmou34r3xb"
    }
  ]
}
```

Server `broadcast` payload examples:

```jsonc
{
  // Server-assigned persistent sequence.
  "seq": 42,
  "acceptedAtMs": 1710000000000,
  // Optional server-derived activity position for chunk following.
  "activityPoint": { "x": 180, "y": 160 },
  "mutation": {
    "tool": 3,
    "type": 1,
    "id": "rmou34r3xa",
    "color": "#1f2937",
    "size": 10,
    "opacity": 0.85,
    "x": 120,
    "y": 80,
    "x2": 240,
    "y2": 160,
    "clientMutationId": "cm-mou34r3xc",
    // The sender socket id is echoed only on the primary live broadcast.
    "socket": "server-socket-id"
  }
}
```

```jsonc
{
  // Authoritative replay batch sent after connect.
  "type": 5,
  "fromSeq": 40,
  "seq": 42,
  "_children": [
    {
      "tool": 3,
      "type": 1,
      "id": "rmou34r3xa",
      "color": "#1f2937",
      "size": 10,
      "opacity": 0.85,
      "x": 120,
      "y": 80,
      "x2": 240,
      "y2": 160,
      "clientMutationId": "cm-mou34r3xc"
    }
  ]
}
```

Important files:

- Events and message codes: [client-data/js/socket_events.js](./client-data/js/socket_events.js),
  [client-data/tools/manifest.js](./client-data/tools/manifest.js),
  [client-data/js/mutation_type.js](./client-data/js/mutation_type.js), and
  [client-data/js/message_tool_metadata.js](./client-data/js/message_tool_metadata.js).
- Client connection/send/receive: [client-data/js/board_transport.js](./client-data/js/board_transport.js),
  [client-data/js/board_write_module.js](./client-data/js/board_write_module.js), and
  [client-data/js/board_connection_module.js](./client-data/js/board_connection_module.js).
- Server admission and fan-out: [server/socket/message_validation.mjs](./server/socket/message_validation.mjs),
  [server/socket/policy.mjs](./server/socket/policy.mjs),
  [server/socket/replay.mjs](./server/socket/replay.mjs), and
  [server/socket/broadcasts.mjs](./server/socket/broadcasts.mjs).

## persisted board file format

Persisted boards are SVG documents. The root SVG carries `data-wbo-format`,
`data-wbo-seq`, `data-wbo-readonly`, `width`, and `height`; drawable items live
under `<g id="drawingArea">`. Stored items use SVG tag names; those tag names map
back to string tool ids when the server decodes the file.

Minimal stored SVG example:

```svg
<svg id="canvas" xmlns="http://www.w3.org/2000/svg" version="1.1" width="1000" height="800" data-wbo-format="whitebophir-svg-v2" data-wbo-seq="42" data-wbo-readonly="false">
<defs id="defs"></defs>
<g id="drawingArea">
<!-- Rectangle item. The stored tag maps back to the "rectangle" tool. -->
<rect id="rmou34r3xa" x="120" y="80" width="120" height="80" stroke="#1f2937" stroke-width="10" fill="none" opacity="0.85"></rect>
<!-- Pencil item. Pencil IDs are generated with the "l" prefix in live tool code. -->
<path id="lmou34r3xe" d="M 120 80 l 20 10" stroke="#1f2937" stroke-width="10" fill="none" stroke-linecap="round" stroke-linejoin="round"></path>
<!-- Text item. Text IDs are generated with the "t" prefix. -->
<text id="tmou34r3xf" x="120" y="220" font-size="24" fill="#1f2937">Hello WBO</text>
</g>
<g id="cursors"></g>
</svg>
```

Important files:

- Envelope and root metadata: [server/persistence/svg_envelope.mjs](./server/persistence/svg_envelope.mjs)
  and [server/persistence/svg_board_store.mjs](./server/persistence/svg_board_store.mjs).
- Scan, load, and rewrite: [server/persistence/streaming_stored_svg_scan.mjs](./server/persistence/streaming_stored_svg_scan.mjs)
  and [server/persistence/stored_svg_item_codec.mjs](./server/persistence/stored_svg_item_codec.mjs).
- Tool stored-item contracts: [client-data/tools/index.js](./client-data/tools/index.js),
  [client-data/tools/shape_contract.js](./client-data/tools/shape_contract.js), and
  `client-data/tools/<tool-id>/index.js`.

## core invariants

- Server live-message admission validates and rejects. Client tools own
  UX-side clamping and normalization before optimistic draw/send.
- After a tool calls `Tools.drawAndSend`, `Tools.send`, or write-buffer APIs, the
  runtime owns that message object. Callers must not mutate it.
- Persistent socket writes flow through policy, rate limits, the per-board
  session, board mutation application, mutation-log recording, and sequenced
  broadcasts. Cursor messages are ephemeral and are not persisted or replayed.
- Connection replay starts from the SVG baseline sequence attached to the page.
  Reconnects refresh the authoritative SVG baseline before opening a new socket
  when replay is not possible.
- Canonical board items store scalar fields in `attrs`, `transform` once at the
  item top level, and payload-specific state under `payload`.
- Stored SVG is authoritative. `.svg.bak` is a transient save staging file, and
  unreadable primary SVGs are quarantined before fallback. Legacy `.json`
  boards are migration inputs, not the steady-state format.
- Stored SVG structural scan, summary decode, and full materialization are
  separate. Bad recognized items may be skipped; broken SVG structure is an
  error. Do not turn structural failures into silent repairs.
- Board pages stream stored SVG baselines through the HTML shell. The board chrome
  and boot payloads must remain before the streamed board markup.
- All user-visible strings MUST be localized via `Tools.i18n`. All [translation keys](server/http/translations.json) MUST have a carefully designed, natural sounding, context-aware version in ALL supported languages.
- The shared moderation rule list lives in [client-data/js/moderation_rules.js](./client-data/js/moderation_rules.js). It defines rule identity, icon files, translation key references, and the moderation-appeal URL. Rule SVG icons live in [client-data/rules/](./client-data/rules/). The `/rules` page, the moderation-action dialog, and the banned disconnect notice all read metadata from this single source.

## hot paths

Hot paths include live socket message validation, per-coordinate message
helpers, board load, canonical item materialization, mutation application,
stored-SVG summary scan, save/rewrite, and broadcast fan-out.

When touching hot paths:

- Do not read env or rebuild config inside per-item, per-child, or
  per-coordinate work. Capture or pass values once at the boundary.
- Avoid avoidable allocations, cloning, regex creation, and spans inside
  per-coordinate loops.
- Use summary decode for board load and canonical indexing. Do not hydrate Pencil
  point arrays on board open, save, rewrite, or copy unless the active tool
  interaction truly needs them.
- Do not read source SVG from live socket-message paths. SVG source reads belong
  to board load, served baseline reads, and persistence rewrite.
- Use `withExpensiveActiveSpan` or a span around a batch for high-volume work.
  Do not start `withActiveSpan` per item.
- Run `npm run bench` before and after suspected hot-path changes. Use
  `npm run bench -- <e2e|load|persist|broadcast>` or the matching shortcut when
  one scenario is enough.

## frontend rules

- Preserve the existing whiteboard shell. Small UX fixes should not restyle
  unrelated controls or introduce a new visual system.
- The left tool rail is the primary anchor. HUD, presence, status, and popovers
  must not cover it, intercept clicks meant for it, or force it to move.
- Viewport, zoom, pan, URL hash, scroll bounds, and board extent logic belong in
  [client-data/js/board_viewport.js](./client-data/js/board_viewport.js) and
  [client-data/js/board_extent.js](./client-data/js/board_extent.js).
- Generic message hooks must derive extent from persistent/content payloads only.
  Ephemeral messages such as cursor updates must not grow the board extent.
- SVG layout measurement such as `getBBox()` is allowed only in narrow tool
  interaction paths over a small selected/updated element set. Do not traverse or
  measure the whole board SVG from generic gesture or message handling.
- Treat SVG-affecting CSS as board-load sensitive; style recalculation can make
  existing boot-time SVG reads such as `getPathData()` very expensive.
- Scale-disabled draw tools remain selectable; interaction is blocked, the board
  cursor is `not-allowed`, and status explains that the user must zoom in.
- Tool modules own tool-specific DOM behavior, stored-item summary/serialization,
  rendering, boot hooks, cleanup hooks, and rejection/disconnect handling.

## design system

- Style target: precise, calm, utilitarian whiteboard chrome around an infinite
  canvas.
- Default surfaces are white or near-white (`#ffffff`, `#fcfcfd`, `#f3f4f6`).
  Avoid decorative gradients, tinted cards, glossy treatments, and dark-theme
  fragments unless explicitly requested.
- Use thin cool-gray borders first (`#d9dde3`, stronger `#b8c0cc`) and very
  light shadows only when separation is needed.
- Keep controls compact and mostly square. Use tight radii: `2px` for controls,
  `4px` for larger panels.
- Use compact UI type: `13px` primary, `11px` to `12px` secondary.
- Default accent colors are the muted green family (`#abc6c6`, `#ccdfdf`).
- Idle status stays hidden. Only show persistent board-state UI when there is
  meaningful state to communicate.

## test commands

- Typecheck: `npm run typecheck`.
- Node suite: `npm run test-node` or targeted `node --test test-node/<file>.test.js`.
- Browser suite: `npm run test:pw` or targeted
  `npx playwright test playwright/tests/<file>.spec.ts`.
- Lint: `npm run lint`.
- Format: `npm run format`.
- Full local gate: `npm test`.
- Benchmarks: `npm run bench`, `npm run bench:load`, `npm run bench:persist`,
  `npm run bench:broadcast`, `npm run bench:e2e`.
- Profiling: `npm run profile -- <e2e|load|persist|broadcast>`.

`npm test` needs Python 3.10+, the Python dependency in
`scripts/requirements-seminar.txt`, Chromium, ffmpeg/ffprobe (including libx264),
and local browser/network capability.
The Node archive and v2 tests exercise the Python helper against a local server.
The v2 browser suite uses `http://0.0.0.0` and explicitly verifies that the origin
is not a secure context, so localhost Web Crypto support cannot mask regressions.
If Chromium is
missing, run `npx playwright install chromium`.

In Playwright specs, assert authoritative app or socket state. Avoid sleeps. When
browser tests fail or flake, prefer fixing the application behavior over adding
test workarounds.

## change checklist

- Message shape or protocol: update the schema/metadata sources, shared message
  helpers, client send/draw paths if needed, focused Node tests, and benchmarks
  if a hot normalizer changed.
- Config/env: update [server/configuration.mjs](./server/configuration.mjs) and
  focused tests. Do not add memoization layers or reset hooks inside
  configuration.
- Rate limits: update shared rate-limit logic first, then server enforcement and
  policy. Run `node --test test-node/rate_limit_common.test.js test-node/socket_policy.test.js test-node/rate_limits.test.js`.
- Persistence, replay, or board state: review board data/session/persistence and
  SVG store together. Run focused Node tests and benchmarks for affected load,
  persist, or broadcast paths.
- Auth or permissions: start in `server/auth`, then verify HTTP routes and socket
  policy. Run relevant auth, route, and socket tests.
- Tool UX: start in `client-data/tools/<tool-id>`, shared tool helpers only when
  duplication is real, and verify with targeted Playwright or client-tool tests.
- HTTP template, cache, compression, or routing: update the route/helper source
  and server-route tests.

## profiling notes

- `npm run profile -- <scenario>` writes CPU and heap profiles under
  `.profiles/`.
- Use profiling after a benchmark regression, not as a routine check.
