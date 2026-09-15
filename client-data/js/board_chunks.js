// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-15: shared chunk settings and geometry.
/** @typedef {{x: number, y: number}} ActivityPoint */
/** @typedef {{width: number, height: number, margin: number, follow: boolean, locked: boolean}} ChunkSettings */
/** @typedef {ChunkSettings & {revision: string, point: ActivityPoint}} ChunkState */
export const GRID_CHANGE_EVENT = "wbo:grid-change";
export const DEFAULT_CHUNKS = Object.freeze({
  width: 10000,
  height: 7000,
  margin: 500,
  follow: false,
  locked: false,
  revision: "",
  point: Object.freeze({ x: 0, y: 0 }),
});

/** @param {unknown} value @returns {ChunkSettings | null} */
export function validateChunkSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = /** @type {Record<string, unknown>} */ (value);
  for (const key of ["width", "height", "margin"]) {
    const n = v[key];
    if (
      typeof n !== "number" ||
      !Number.isSafeInteger(n) ||
      n < (key === "margin" ? 0 : 100) ||
      n > 100000
    )
      return null;
  }
  if (typeof v.follow !== "boolean" || typeof v.locked !== "boolean")
    return null;
  return /** @type {ChunkSettings} */ ({
    width: v.width,
    height: v.height,
    margin: v.margin,
    follow: v.follow,
    locked: v.locked,
  });
}

/** @param {unknown} value @returns {value is ActivityPoint} */
export function isActivityPoint(value) {
  if (!value || typeof value !== "object") return false;
  const p = /** @type {ActivityPoint} */ (value);
  return (
    Number.isFinite(p.x) &&
    Number.isFinite(p.y) &&
    p.x >= 0 &&
    p.y >= 0 &&
    p.x <= 1e9 &&
    p.y <= 1e9
  );
}

/** @param {unknown} value @returns {ChunkState | null} */
export function validateChunkState(value) {
  const settings = validateChunkSettings(value);
  const v = /** @type {ChunkState | null} */ (value);
  if (
    !settings ||
    !v ||
    typeof v.revision !== "string" ||
    v.revision.length > 64 ||
    !isActivityPoint(v.point)
  )
    return null;
  return {
    ...settings,
    revision: v.revision,
    point: { x: v.point.x, y: v.point.y },
  };
}

/** @param {ChunkSettings} settings @param {ActivityPoint} point */
export function chunkRect(settings, point) {
  return {
    x: Math.floor(point.x / settings.width) * settings.width,
    y: Math.floor(point.y / settings.height) * settings.height,
    width: settings.width,
    height: settings.height,
  };
}
