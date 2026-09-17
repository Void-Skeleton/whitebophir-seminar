// SPDX-License-Identifier: AGPL-3.0-or-later
import { MutationType } from "../../client-data/js/mutation_type.js";
import { collectOptimisticAffectedIds } from "../../client-data/js/optimistic_mutation.js";
import { ARCHIVE_ITEM_FIELDS } from "./archive_codec.mjs";
import { publicItemFromCanonicalItem } from "./canonical_items.mjs";
import { MAX_RESTORE_BYTES, MAX_RESTORE_ITEMS } from "./restore.mjs";

/** @typedef {import("./data.mjs").BoardData} BoardData */
/** @typedef {import("../../types/app-runtime").BoardMessage} Message */
/** @typedef {{id:string, order:number, seq:number, item:Record<string,any>|null|undefined}} Snapshot */
/** @typedef {{owner:string, group:string, before:Map<string,Snapshot>, after:Map<string,Snapshot>|null, valid:boolean, tools:Set<number>, bytes:number}} Action */

/** @param {any} item */
export function archiveItem(item) {
  return Object.fromEntries(
    Object.entries(item).filter(([key]) => ARCHIVE_ITEM_FIELDS.has(key)),
  );
}

/** Bounded, process-local personal undo stacks. Payloads already on disk are
 * resolved from the durable journal only when an undo actually needs them.
 */
export class EditHistory {
  /** @param {BoardData} board */
  constructor(board) {
    this.board = board;
    /** @type {Action[]} */
    this.actions = [];
    /** @type {Action|null} */
    this.active = null;
    this.reversingOwner = "";
    /** @type {{actions:Action[], added:string[], bytes:number, valid:boolean}|null} */
    this.staged = null;
  }
  /** @param {string} id @returns {Snapshot} */
  snapshot(id) {
    const canonical = this.board.itemsById.get(id);
    const live = canonical && !canonical.deleted;
    const payload = canonical?.payload;
    const complete =
      !live ||
      !payload ||
      payload.kind === "inline" ||
      (payload.kind === "text" && typeof payload.modifiedText === "string") ||
      (payload.kind === "children" &&
        !payload.persistedChildCount &&
        !canonical.copySource &&
        payload.appendedChildren.length <= 8192);
    return {
      id,
      seq: this.board.getSeq(),
      order: canonical?.paintOrder ?? this.board.nextPaintOrder,
      item: !live
        ? null
        : complete
          ? structuredClone(archiveItem(publicItemFromCanonicalItem(canonical)))
          : undefined,
    };
  }
  /** @param {Message} message */
  affected(message) {
    if ("type" in message && message.type === MutationType.CLEAR)
      return new Set(
        this.board.paintOrder.filter(
          (id) => !this.board.itemsById.get(id)?.deleted,
        ),
      );
    if ("type" in message && message.type === MutationType.RESTORE)
      return new Set(message.items.map((item) => item.id));
    return collectOptimisticAffectedIds(message);
  }
  /** @param {Message} message @param {{owner:string,group:string}|undefined} context */
  begin(message, context) {
    if (!context) return;
    const previousActions = this.actions;
    let action = this.actions
      .slice()
      .reverse()
      .find((entry) => entry.owner === context.owner);
    if (!action || action.group !== context.group || action.after) {
      this.actions = this.actions.filter(
        (entry) => entry.owner !== context.owner || !entry.after,
      );
      action = {
        ...context,
        before: new Map(),
        after: null,
        valid: true,
        tools: new Set(),
        bytes: 0,
      };
      this.actions.push(action);
    }
    action.tools.add(message.tool);
    this.active = action;
    this.staged = {
      actions: previousActions,
      added: [],
      bytes: action.bytes,
      valid: action.valid,
    };
    if (!action.valid) return;
    for (const id of this.affected(message)) {
      if (action.before.has(id)) continue;
      const snapshot = this.snapshot(id);
      action.bytes += JSON.stringify(snapshot).length * 2;
      action.before.set(id, snapshot);
      this.staged.added.push(id);
      if (
        action.before.size > MAX_RESTORE_ITEMS ||
        action.bytes > MAX_RESTORE_BYTES
      ) {
        action.valid = false;
        action.before.clear();
        break;
      }
    }
    while (
      this.actions.length > 100 ||
      this.actions.reduce((sum, entry) => sum + entry.bytes, 0) >
        32 * 1024 * 1024
    )
      this.actions.shift();
  }
  /** @param {boolean} accepted */
  finish(accepted) {
    if (!accepted && this.staged && this.active) {
      this.actions = this.staged.actions;
      for (const id of this.staged.added) this.active.before.delete(id);
      this.active.bytes = this.staged.bytes;
      this.active.valid = this.staged.valid;
    }
    this.active = null;
    this.staged = null;
  }
  /** All accepted writes, including imports and eviction, invalidate conflicting
   * edits by other users. Own consecutive actions can still unwind in order.
   * @param {Message} message
   */
  observe(message) {
    if (!this.actions.length) return;
    const owner = this.active?.owner || this.reversingOwner;
    const ids = Array.from(this.affected(message));
    for (const action of this.actions) {
      if (owner && action.owner === owner) continue;
      if (
        ("type" in message && message.type === MutationType.CLEAR) ||
        ids.some((id) => action.before.has(id))
      ) {
        action.valid = false;
        action.before.clear();
        action.after?.clear();
        action.bytes = 0;
      }
    }
  }
  trim() {
    for (const action of this.actions) {
      action.bytes =
        JSON.stringify([
          ...action.before.values(),
          ...(action.after?.values() || []),
        ]).length * 2;
    }
    while (
      this.actions.length > 100 ||
      this.actions.reduce((sum, entry) => sum + entry.bytes, 0) >
        32 * 1024 * 1024
    )
      this.actions.shift();
  }
  /** @param {string} owner @param {boolean} redo */
  peek(owner, redo) {
    return redo
      ? this.actions.find(
          (action) => action.owner === owner && action.after !== null,
        )
      : this.actions
          .slice()
          .reverse()
          .find((action) => action.owner === owner && action.after === null);
  }
  /** @param {Map<string,Snapshot>} snapshots */
  async materialize(snapshots) {
    const missing = [...snapshots.values()].filter(
      (entry) => entry.item === undefined,
    );
    if (missing.length) {
      if (!this.board.history) throw new Error("Undo history unavailable");
      const { historicalItems } = await import("./history.mjs");
      try {
        await historicalItems(this.board.history, missing);
        return [...snapshots.values()].map(({ id, order, item }) => ({
          id,
          order,
          item: item || null,
        }));
      } finally {
        for (const entry of missing) entry.item = undefined;
      }
    }
    return [...snapshots.values()].map(({ id, order, item }) => ({
      id,
      order,
      item: item || null,
    }));
  }
}
