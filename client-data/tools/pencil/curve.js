// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-17: portable curves matching the live Pencil.
import { wboPencilPoint } from "./wbo_pencil_point.js";

/** @typedef {{type:string, values:number[]}} Segment */
/** @typedef {{version:1, segments:Segment[]}} PencilCurve */

/** @param {{x:number,y:number}[]} points @returns {PencilCurve} */
export function pencilCurve(points) {
  /** @type {Segment[]} */
  const segments = [];
  for (const point of points) wboPencilPoint(segments, point.x, point.y);
  return { version: 1, segments };
}

/** Historical files are untrusted; only our bounded numeric path language is accepted.
 * @param {any} raw @returns {PencilCurve}
 */
export function validatePencilCurve(raw) {
  if (
    !raw ||
    raw.version !== 1 ||
    !Array.isArray(raw.segments) ||
    raw.segments.length > 1000002 ||
    raw.segments.length === 1
  )
    throw new Error("Invalid Pencil curve");
  for (const [index, segment] of raw.segments.entries()) {
    const type = index === 0 ? "M" : index === 1 ? "L" : "C";
    if (
      !segment ||
      segment.type !== type ||
      !Array.isArray(segment.values) ||
      segment.values.length !== (type === "C" ? 6 : 2) ||
      segment.values.some(
        (/** @type {any} */ value) =>
          !Number.isSafeInteger(value) || Math.abs(value) > 2e9,
      )
    )
      throw new Error("Invalid Pencil curve segment");
    if (
      index === 1 &&
      segment.values.some(
        (/** @type {number} */ value, /** @type {number} */ axis) =>
          value !== raw.segments[0].values[axis],
      )
    )
      throw new Error("Invalid Pencil curve start");
  }
  return raw;
}

/** @param {Segment[]} segments */
export function pencilCurvePath(segments) {
  return segments
    .map(
      ({ type, values }) =>
        `${type} ${values.map((value) => Number(value.toFixed(6))).join(" ")}`,
    )
    .join(" ");
}
