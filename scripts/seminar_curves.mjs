// SPDX-License-Identifier: AGPL-3.0-or-later
// Seminar modifications, 2026-09-17: constant-speed cubic Bézier replay.
/** @typedef {import("../client-data/tools/pencil/curve.js").Segment} Segment */
/** @typedef {{x:number,y:number}} Point */
/** @typedef {{segments:Segment[], lengths:number[], base:number, prefix:Segment[]}} MeasuredCurve */

const NODES = [
  -0.906179845938664, -0.538469310105683, 0, 0.538469310105683,
  0.906179845938664,
];
const WEIGHTS = [
  0.236926885056189, 0.478628670499366, 0.568888888888889, 0.478628670499366,
  0.236926885056189,
];

/** @param {Segment} segment @returns {Point} */
export function curveEndpoint(segment) {
  return {
    x: segment.values[segment.values.length - 2] || 0,
    y: segment.values[segment.values.length - 1] || 0,
  };
}

/** Integrate speed, not straight chords. Four five-point Gaussian intervals keep
 * work bounded and also handle the nonuniform parameter speed of a straight cubic.
 * @param {Point} start @param {Segment} segment @param {number} [through]
 */
function arcLength(start, segment, through = 1) {
  const end = curveEndpoint(segment);
  if (segment.type !== "C")
    return Math.hypot(end.x - start.x, end.y - start.y) * through;
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = segment.values;
  let length = 0;
  for (let interval = 0; interval < 4; interval++) {
    const half = through / 8,
      middle = ((interval + 0.5) * through) / 4;
    for (let i = 0; i < NODES.length; i++) {
      const t = middle + half * (NODES[i] || 0),
        s = 1 - t;
      const dx =
        3 *
        (s * s * (x1 - start.x) + 2 * s * t * (x2 - x1) + t * t * (end.x - x2));
      const dy =
        3 *
        (s * s * (y1 - start.y) + 2 * s * t * (y2 - y1) + t * t * (end.y - y2));
      length += half * (WEIGHTS[i] || 0) * Math.hypot(dx, dy);
    }
  }
  return length;
}

/** @param {Segment[]} segments @param {Segment[]} [prefix] @returns {MeasuredCurve} */
export function measureCurve(segments, prefix = []) {
  // A snapshot is already visible. Preserve its exact prefix, including the
  // terminal control point that later live appends would otherwise adjust.
  let through = 0;
  if (prefix.length) {
    let previous;
    for (const segment of prefix) {
      const point = curveEndpoint(segment);
      if (previous && point.x === previous.x && point.y === previous.y)
        continue;
      while (through < segments.length) {
        const endpoint = curveEndpoint(
          /** @type {Segment} */ (segments[through]),
        );
        through++;
        if (point.x === endpoint.x && point.y === endpoint.y) break;
      }
      previous = point;
    }
    while (through < segments.length && previous) {
      const endpoint = curveEndpoint(
        /** @type {Segment} */ (segments[through]),
      );
      if (endpoint.x !== previous.x || endpoint.y !== previous.y) break;
      through++;
    }
  }
  const path = prefix.length
    ? [...prefix, ...segments.slice(through)]
    : segments;
  const lengths = [0];
  for (let i = 1; i < path.length; i++)
    lengths.push(
      (lengths[i - 1] || 0) +
        arcLength(
          curveEndpoint(/** @type {Segment} */ (path[i - 1])),
          /** @type {Segment} */ (path[i]),
        ),
    );
  return {
    segments: path,
    lengths,
    base: lengths[Math.max(0, prefix.length - 1)] || 0,
    prefix,
  };
}

/** De Casteljau subdivision retains a true cubic at the animated tip.
 * @param {Point} start @param {Segment} segment @param {number} t @returns {Segment}
 */
function partialSegment(start, segment, t) {
  const end = curveEndpoint(segment);
  /** @param {Point} a @param {Point} b */
  const mix = (a, b) => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  });
  if (segment.type !== "C") {
    const point = mix(start, end);
    return { type: "L", values: [point.x, point.y] };
  }
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = segment.values;
  const a = mix(start, { x: x1, y: y1 });
  const b = mix({ x: x1, y: y1 }, { x: x2, y: y2 });
  const c = mix({ x: x2, y: y2 }, end);
  const d = mix(a, b),
    e = mix(b, c),
    tip = mix(d, e);
  return { type: "C", values: [a.x, a.y, d.x, d.y, tip.x, tip.y] };
}

/** @param {MeasuredCurve} curve @param {number} fraction @returns {Segment[]} */
export function revealCurve(curve, fraction) {
  if (fraction >= 1) return curve.segments;
  if (fraction <= 0 && curve.prefix.length) return curve.prefix;
  if (!curve.segments.length) return [];
  const total = curve.lengths[curve.lengths.length - 1] || 0;
  const target = curve.base + Math.max(0, fraction) * (total - curve.base);
  let lo = 1,
    hi = curve.segments.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((curve.lengths[mid] || 0) <= target) lo = mid + 1;
    else hi = mid;
  }
  const path = curve.segments.slice(0, lo);
  const segment = curve.segments[lo],
    previous = curve.segments[lo - 1];
  if (segment && previous) {
    const start = curveEndpoint(previous),
      wanted = target - (curve.lengths[lo - 1] || 0);
    let low = 0,
      high = 1;
    for (let step = 0; step < 40; step++) {
      const middle = (low + high) / 2;
      if (arcLength(start, segment, middle) < wanted) low = middle;
      else high = middle;
    }
    path.push(partialSegment(start, segment, (low + high) / 2));
  }
  return path;
}
