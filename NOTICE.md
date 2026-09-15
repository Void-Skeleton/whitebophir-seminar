# Modification notice

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
