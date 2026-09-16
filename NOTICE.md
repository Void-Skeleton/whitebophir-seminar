# Modification notice

This is a modified version of WBO, originally developed by Ophir Lojkine and
contributors. The seminar extensions below were added between 2026-09-14 and
2026-09-16.

The project's GNU Affero General Public License, version 3 or later, remains in
effect; see [LICENSE](LICENSE). Existing copyright and license notices are
retained. New implementation files are licensed AGPL-3.0-or-later.

Added features include:

- **Editable board backups:** compressed `.wbo` downloads and moderator uploads
  through the board's Download dialog or Python helper. Backups preserve board
  content, chunk settings and theme, with configurable size limits.
- **Ed25519 moderator authentication:** challenge-based authentication on HTTP
  and HTTPS alongside legacy tokens. Private keys remain in browser-local
  storage or local CLI files. Missing, invalid or mismatched browser keypairs
  are replaced automatically.
- **Board-specific display names:** names supplied through entry links, the
  homepage or an entry dialog, remembered in cookies. Users can rename
  themselves, and moderators can rename participants.
- **Canvas chunks and view modes:** persistent chunk dimensions and margins,
  prominent boundaries, free navigation, chunk focus and latest-edit focus.
  Smooth keyboard navigation and camera transitions interrupt drawing safely.
  Moderators can apply a view mode to participants once; participants remain
  free to change it, including through a double-press navigation override.
- **Shared dark mode:** moderator-controlled canvas themes with hue-preserving
  color presentation, white grids and chunk borders on dark canvases, and
  consistent appearance in previews, SVG exports and native backups.
- **Personal scroll controls:** a browser-local choice between wheel zoom and
  vertical navigation, with Ctrl+wheel zoom and chunk-aware movement.
- **Timestamped board history:** compressed, streamed edit journals with
  millisecond server timestamps, stroke intervals and crash recovery.
  Moderators can download historical board snapshots and edit ranges through
  the Download dialog or Python helper.
- **Canvas replay video:** offline video generation from a historical snapshot
  and edit history, with animated strokes, chunk boundaries, configurable
  camera behavior, resolution, playback speed and time interval. Input limits
  accommodate two-hour seminar histories and can be overridden.
- **Seminar audio recording:** microphone and application audio capture on
  Linux and Windows, selected through CLI options or an interactive terminal
  menu. Each source streams to a separate Opus recording with durable timing
  metadata; uncompressed PCM remains available. Periodic server clock
  synchronization aligns recordings with board history, and replay trims,
  positions and mixes overlapping audio while preserving capture gaps.
- **Python helper and localization:** commands for board transfers, key
  management, named entry links, board settings, history, replay and audio
  recording, with English, Simplified Chinese and Traditional Chinese CLI text.
  Board controls also receive localized labels and messages.

Supporting changes include input validation, regression tests, Windows audio
checks in CI, documentation, and links to the corresponding modified source.
See [README.md](README.md) for usage and the deployment source-link setting.

`client-data/vendor/tweetnacl` contains TweetNaCl.js 1.0.3, its upstream source,
types, author list and public-domain license. See its README for provenance.
The vendor files retain their upstream license; new WBO integration files use
AGPL-3.0-or-later.
