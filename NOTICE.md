# Modification notice

Changes dated 2026-09-16 make streamed Opus compression the default for seminar
audio recordings on Linux and Windows. The helper adds format, bitrate and
ffmpeg options with English/Simplified/Traditional Chinese help. Complete Ogg
pages are synced before publishing timing checkpoints; replay validates and
recovers committed compressed prefixes while retaining PCM compatibility.
Storage, interruption/replay tests, CI and documentation are updated.

Changes dated 2026-09-16 implement seminar feature 3: per-source microphone and
application audio capture on Linux (PulseAudio/PipeWire) and Windows (WASAPI),
command-line and interactive selection, streamed PCM with durable timing
journals, periodic server clock synchronization, and synchronized replay audio
trimming/mixing. The public clock route, Python recorder, native Windows bridge,
ffmpeg audio alignment, English/Simplified/Traditional Chinese CLI text, Windows
CI checks, regression tests and documentation are added or updated. New files
retain the project's AGPL-3.0-or-later license.

Follow-up changes dated 2026-09-16 fix Linux audio discovery to read pactl's
`monitor_source` field, resolve numeric source indices, and tolerate missing
monitors. Regression tests and documentation cover the corrected lookup.

Changes dated 2026-09-16 implement canvas replay video (the revised seminar
feature 2). The Python helper adds the localized `replay` command, backed by
offline Node timeline/camera modules, existing WBO SVG rendering, headless
Chromium, and ffmpeg. Historical native snapshots gain optional replay context
without changing their import format. Replay tests, CI encoder setup, README,
and AGENTS documentation cover rendering, validation and output cleanup.

Follow-up changes dated 2026-09-16 raise helper history/replay limits to 256 MiB
compressed and 1 GiB decompressed based on two-hour writing estimates. History
validation streams decompressed lines. Replay accepts snapshots anywhere within
the log interval, adds localized video start/end and legacy snapshot timestamp
options, and preserves stroke timing across clip boundaries. Shared CLI parsing,
regression tests and documentation are updated.

This is a modified version of WBO, originally developed by Ophir Lojkine and
contributors. The project's GNU Affero General Public License, version 3 or
later, remains in effect; see [LICENSE](LICENSE). Existing copyright and license
notices are retained.

Changes dated 2026-09-14 add feature 1 of the seminar extension:

- `server/board/archive.mjs` and `server/routes/board_archive.mjs` implement
  gzip-compressed native board backups, complete validation, and import/export.
- `server/board/session.mjs`, `server/socket/index.mjs`, and `server/server.mjs`
  connect archives to serialized board writes, live synchronization and routing.
- `client-data/tools/download/index.js` adds the export/import dialog.
- `server/configuration.mjs`, `server/http/client_configuration.mjs`, and
  `types/app-runtime.d.ts` expose configurable archive limits and a source URL.
- `client-data/index.html`, `server/http/templating.mjs`, and
  `server/http/translations.json` add source-link support and localized controls
  in all supported languages.
- `scripts/seminar_helper.py` provides Python CLI export/import commands.
- Archive tests, `README.md`, and `AGENTS.md` document and verify the changes.

Changes dated 2026-09-15 make native uploads in the existing Download button
available to board moderators, including temporary moderators. The Download
tool and `client-data/js/board_tool_registry_module.js` use live moderator
permissions, and `server/routes/board_archive.mjs` enforces those permissions for
uploads. Archive tests and documentation cover these access rules.

Changes dated 2026-09-15 also implement the new feature 1: parallel Ed25519
moderator authentication on HTTP and HTTPS. They add `server/auth/user_key_v2.mjs`,
`server/routes/auth_v2.mjs`, browser key/signing and private-board bootstrap
modules, and Python key generation/signing. Configuration, board capabilities,
HTTP routes/cache handling, socket authentication/identity, runtime types,
translations, tests, CI, and documentation are updated to integrate v2 while
preserving v1. Private seeds remain in browser-local storage or local CLI files.
Browser startup automatically creates a random keypair when either stored half
is missing or invalid, or when the halves do not match; valid pairs are retained.

Changes dated 2026-09-15 add board-specific display names through URL parameters,
the homepage and an entry dialog, remembered in cookies. The users panel allows
self-renaming and moderator renaming, backed by validated socket messages and
live updates across matching tabs. Shared name validation, browser name handling,
socket presence and permissions, homepage redirects, dialogs, styles, runtime
types, all translations, tests and documentation are updated. The Python helper
adds `join-url` for generating named entry links.

`client-data/vendor/tweetnacl` contains TweetNaCl.js 1.0.3, its upstream source,
types, author list and public-domain license. See its README for provenance.
The vendor files retain their upstream license; new WBO integration files use
AGPL-3.0-or-later.

New implementation files are licensed AGPL-3.0-or-later. See README.md for the
deployment setting that links users to the corresponding modified source.

Changes dated 2026-09-15 implement seminar feature 2: configurable canvas chunks,
activity-following cameras, and moderator control and locking of others’ follow
settings. Shared chunk geometry, the browser controls and viewport, accepted
mutation tracking, SVG metadata persistence, the HTTP settings API, socket
snapshots, and the Python `chunks` command are added or extended. All supported
translations, runtime types, tests, README and AGENTS documentation are updated.
Follow-up changes on the same date emphasize chunk borders through the Grid
button, ease camera transitions, defer the drawer's camera until stroke
completion, and interrupt pencil strokes before other follow-camera moves.
Pencil input is blocked during camera transitions to prevent stray segments and
repeated chunk switching.
Chunk border emphasis is further increased with double the highlighted stroke
width and a darker gray for stronger contrast against the regular grid.

Further changes dated 2026-09-15 add Free, Focused on chunk, and Focused on last
edited chunk view modes, smooth arrow-key navigation, and a timed double-press
override. Moderator locking is removed; moderators can apply a mode to other
users once, after which each user can freely change it. The settings API,
stored-metadata migration, Python helper, all supported translations and tests
are updated for these modes.

Changes dated 2026-09-16 include chunk settings in native board backups and
restore them on upload, including on empty boards. Archive validation, the HTTP
snapshot and import paths, the Python helper, localized import descriptions,
and regression tests are updated. Configured chunk boundaries now remain
prominent independently of the Grid button in every view mode.

Changes dated 2026-09-16 add the new seminar feature 1: moderator-controlled
board dark mode, hue-preserving reversible color presentation, white grids and
chunk borders, and default white ink on dark canvases. Board metadata, SVG
previews and exports, native backups, live theme synchronization, the Python
helper, all supported UI translations, and regression tests are extended.

Changes dated 2026-09-16 implement seminar feature 4: personal scroll controls
with a browser-local zoom/navigation preference, Ctrl+scroll zoom, shared smooth
arrow/chunk navigation, and gesture-aware latest-focus reminders. The board
shell, viewport, preferences, chunk controls, runtime types, all supported
translations, tests, README and AGENTS documentation are updated.

Changes dated 2026-09-16 implement the new seminar feature 1: compressed durable
edit journals, millisecond server timestamps and Pencil completion records,
crash recovery, moderator historical `.wbo` snapshots and streamed JSON Lines
exports. Mutation sessions, persistence, socket replay, archive/settings routes,
the existing Download dialog, all supported translations, the Python helper,
tests and documentation are extended. Complete gzip members are synchronized
before accepted changes are published.
