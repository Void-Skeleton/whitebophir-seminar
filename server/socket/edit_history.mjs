// SPDX-License-Identifier: AGPL-3.0-or-later
import MessageCommon from "../../client-data/js/message_common.js";
import { MutationType } from "../../client-data/js/mutation_type.js";
import { getToolId } from "../../client-data/js/message_tool_metadata.js";
import { validateRestore } from "../board/restore.mjs";
import { getBoardSession } from "../board/session.mjs";
import { boardStateForSocket } from "./policy.mjs";
import { getSocketUserSecret } from "./request.mjs";
import { isTurnstileValidationActive } from "./turnstile.mjs";

/** @param {import("../../types/server-runtime.d.ts").AppSocket} socket
 * @param {import("../board/data.mjs").BoardData} board
 * @param {boolean} redo
 * @param {import("../../types/server-runtime.d.ts").ServerConfig} config
 */
export async function reverseEdit(socket, board, redo, config) {
  return getBoardSession(board).runExclusive(async () => {
    const history = board.editHistory;
    const owner = getSocketUserSecret(socket) || socket.id;
    const action = history.peek(owner, redo);
    const denied = (/** @type {string} */ error) => ({
      ok: false,
      error,
      entries: [],
    });
    const permitted = () => {
      const state = boardStateForSocket(config, board, socket);
      return (
        socket.connected &&
        !board.disposed &&
        state.canEdit &&
        (!action?.tools.has(11) || state.canClear) &&
        (!action ||
          [...action.tools].every(
            (tool) => !config.BLOCKED_TOOLS.includes(getToolId(tool) || ""),
          )) &&
        (!config.TURNSTILE_SECRET_KEY ||
          state.canClear ||
          !action ||
          [...action.tools].every(
            (tool) => !MessageCommon.requiresTurnstile(board.name, tool),
          ) ||
          isTurnstileValidationActive(socket, Date.now()))
      );
    };
    if (!permitted()) return denied("undo_unavailable");
    if (!action) return denied(redo ? "redo_empty" : "undo_empty");
    if (!action.valid) {
      history.actions.splice(history.actions.indexOf(action), 1);
      return denied("undo_conflict");
    }
    const beforeUndo = new Map(
      [...action.before.keys()].map((id) => [id, history.snapshot(id)]),
    );
    let message;
    try {
      message = validateRestore(
        {
          tool: 7,
          type: MutationType.RESTORE,
          items: await history.materialize(
            redo ? action.after || new Map() : action.before,
          ),
        },
        config,
      );
    } catch {
      return denied("undo_unavailable");
    }
    // Disk reads can outlive a permission grant or socket connection.
    if (!permitted()) return denied("undo_unavailable");
    const result = board.processMessage(message);
    if (!result.ok) return denied("undo_unavailable");
    // Anchors use IDs, so client baselines need no hidden paint-order metadata.
    const liveIds = board.paintOrder.filter(
      (id) => !board.itemsById.get(id)?.deleted,
    );
    const positions = new Map(liveIds.map((id, index) => [id, index]));
    for (const entry of message.items)
      entry.beforeId =
        liveIds[(positions.get(entry.id) ?? liveIds.length) + 1] || null;
    history.reversingOwner = owner;
    let entry;
    try {
      entry = board.recordPersistentMutation(message);
      await board.history?.commit([entry], socket.id);
    } finally {
      history.reversingOwner = "";
    }
    action.after = redo ? null : beforeUndo;
    history.trim();
    return { ok: true, entries: [entry], error: undefined };
  });
}
