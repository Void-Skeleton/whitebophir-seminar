export const MutationType = Object.freeze(
  /** @type {const} */ ({
    CREATE: 1,
    UPDATE: 2,
    DELETE: 3,
    APPEND: 4,
    BATCH: 5,
    CLEAR: 6,
    COPY: 7,
    // Server-generated undo/redo; never accepted as a client drawing command.
    RESTORE: 8,
  }),
);
/** @typedef {typeof MutationType[keyof typeof MutationType]} MessageType */

/**
 * @param {unknown} type
 * @returns {MessageType | undefined}
 */
export function getMutationTypeCode(type) {
  return typeof type === "number" &&
    type >= MutationType.CREATE &&
    type <= MutationType.RESTORE
    ? /** @type {MessageType} */ (type)
    : undefined;
}
