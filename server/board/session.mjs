// Modified 2026-09-14: serialize archive snapshots/imports with board writes.
import { SerialTaskQueue } from "./serial_task_queue.mjs";

/** @typedef {import("../../types/server-runtime.d.ts").MutationLogEntry} MutationLogEntry */
/** @typedef {import("../../types/server-runtime.d.ts").NormalizedMessageData} NormalizedMessageData */
/** @typedef {{mutation: NormalizedMessageData}} MutationEffect */
/** @typedef {{ok: true} | {ok: false, reason: string}} BoardMutationResult */
/** @typedef {{ok: true, mutation?: NormalizedMessageData} | {ok: false, reason: string}} PreparedMutationResult */
/**
 * @typedef {{
 *   name: string,
 *   disposed?: boolean,
 *   history?: import("./history.mjs").BoardHistory,
 *   editHistory?: import("./edit_history.mjs").EditHistory,
 *   processMessage: (message: NormalizedMessageData) => BoardMutationResult,
 *   recordPersistentMutation: (message: NormalizedMessageData, acceptedAtMs?: number) => MutationLogEntry,
 *   consumePendingRejectedMutationEffects?: () => MutationEffect[],
 *   consumePendingAcceptedMutationEffects?: () => MutationEffect[],
 *   preparePersistentMutation?: (message: NormalizedMessageData) => Promise<PreparedMutationResult> | PreparedMutationResult,
 * }} BoardSessionBoard
 */
/**
 * @typedef {{
 *   board: BoardSessionBoard,
 *   runExclusive: SerialTaskQueue["runExclusive"],
 *   acceptPersistentMutation: (
 *     mutation: NormalizedMessageData,
 *     nowMs?: number,
 *     socketId?: string,
 *     editContext?: {owner:string, group:string},
 *   ) => Promise<
 *     | {ok: true, value: NormalizedMessageData, entry: MutationLogEntry, followup?: MutationLogEntry[]}
 *     | {ok: false, reason: string, followup?: MutationLogEntry[]}
 *   >,
 * }} BoardSession
 */

/**
 * @param {BoardSessionBoard} board
 * @param {(() => MutationEffect[]) | undefined} consumeEffects
 * @returns {MutationEffect[]}
 */
function consumePendingMutationEffects(board, consumeEffects) {
  return typeof consumeEffects === "function" ? consumeEffects.call(board) : [];
}

/** @type {WeakMap<BoardSessionBoard, BoardSession>} */
const BOARD_SESSIONS = new WeakMap();

/**
 * @param {BoardSessionBoard} board
 * @returns {BoardSession}
 */
export function createBoardSession(board) {
  const queue = new SerialTaskQueue();
  return {
    board,
    runExclusive: queue.runExclusive.bind(queue),
    async acceptPersistentMutation(
      mutation,
      nowMs = Date.now(),
      socketId,
      editContext,
    ) {
      return queue.runExclusive(async () => {
        if (board.disposed) return { ok: false, reason: "history_unavailable" };
        consumePendingMutationEffects(
          board,
          board.consumePendingRejectedMutationEffects,
        );
        consumePendingMutationEffects(
          board,
          board.consumePendingAcceptedMutationEffects,
        );
        let acceptedMutation = mutation;
        if (typeof board.preparePersistentMutation === "function") {
          const prepared =
            await board.preparePersistentMutation(acceptedMutation);
          if (prepared.ok === false) {
            return prepared;
          }
          if (prepared.mutation) {
            acceptedMutation = prepared.mutation;
          }
        }
        board.editHistory?.begin(acceptedMutation, editContext);
        const result = board.processMessage(acceptedMutation);
        if (result.ok === false) {
          board.editHistory?.finish(false);
          const followup = consumePendingMutationEffects(
            board,
            board.consumePendingRejectedMutationEffects,
          ).map((effect) =>
            board.recordPersistentMutation(effect.mutation, nowMs),
          );
          await board.history?.commit(followup, socketId);
          return followup.length > 0 ? { ...result, followup } : result;
        }
        const entry = board.recordPersistentMutation(acceptedMutation, nowMs);
        const followup = consumePendingMutationEffects(
          board,
          board.consumePendingAcceptedMutationEffects,
        ).map((effect) =>
          board.recordPersistentMutation(effect.mutation, nowMs),
        );
        await board.history?.commit([entry, ...followup], socketId);
        board.editHistory?.finish(true);
        return {
          ok: true,
          value: acceptedMutation,
          entry,
          ...(followup.length > 0 ? { followup } : {}),
        };
      });
    },
  };
}

/**
 * @param {BoardSessionBoard} board
 * @returns {BoardSession}
 */
export function getBoardSession(board) {
  const existing = BOARD_SESSIONS.get(board);
  if (existing) return existing;
  const created = createBoardSession(board);
  BOARD_SESSIONS.set(board, created);
  return created;
}
