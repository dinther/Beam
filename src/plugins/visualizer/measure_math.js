import * as THREE from 'three';

/**
 * @file The geometry behind the measure tool: feature edges, the nearest
 * point on a segment, a line or a plane, and what a pair of picked points
 * says. No scene, camera or DOM here, so it runs in a test as it is.
 */

/** Faces meeting at less than this are one surface, and their seam no edge. */
export const FEATURE_EDGE_DEG = 20;

/** Two faces or edges closer than this to parallel count as parallel. */
export const PARALLEL_DEG = 0.5;

const edgeCache = new WeakMap();
const scratchA = new THREE.Vector3();
const scratchB = new THREE.Vector3();
const scratchC = new THREE.Vector3();

/**
 * The geometry's feature edges: where neighbouring faces turn by more than
 * `FEATURE_EDGE_DEG`, and open borders. Leaves out the diagonals that split a
 * flat face into triangles. Worked out once per geometry.
 *
 * @param {THREE.BufferGeometry} geometry
 * @returns {Float32Array} six numbers per edge, in the geometry's own space
 */
export function featureEdges(geometry) {
  let edges = edgeCache.get(geometry);
  if (!edges) {
    const built = new THREE.EdgesGeometry(geometry, FEATURE_EDGE_DEG);
    edges = built.attributes.position.array.slice();
    built.dispose();
    edgeCache.set(geometry, edges);
  }
  return edges;
}

/**
 * The point on segment `a`-`b` nearest to `p`.
 *
 * @param {THREE.Vector3} p
 * @param {THREE.Vector3} a
 * @param {THREE.Vector3} b
 * @param {THREE.Vector3} out
 * @returns {THREE.Vector3} `out`
 */
export function closestOnSegment(p, a, b, out) {
  const ab = scratchA.subVectors(b, a);
  const length2 = ab.lengthSq();
  if (length2 === 0) return out.copy(a);
  const t = THREE.MathUtils.clamp(scratchB.subVectors(p, a).dot(ab) / length2, 0, 1);
  return out.copy(a).addScaledVector(ab, t);
}

/**
 * The point on the infinite line through `a` along `dir` nearest to `p`.
 *
 * @param {THREE.Vector3} p
 * @param {THREE.Vector3} a
 * @param {THREE.Vector3} dir unit length
 * @param {THREE.Vector3} out
 * @returns {THREE.Vector3} `out`
 */
export function closestOnLine(p, a, dir, out) {
  const t = scratchA.subVectors(p, a).dot(dir);
  return out.copy(a).addScaledVector(dir, t);
}

/**
 * The foot of the perpendicular from `p` to the plane through `point` with
 * unit normal `normal`.
 *
 * @param {THREE.Vector3} p
 * @param {THREE.Vector3} point
 * @param {THREE.Vector3} normal
 * @param {THREE.Vector3} out
 * @returns {THREE.Vector3} `out`
 */
export function footOnPlane(p, point, normal, out) {
  const d = scratchA.subVectors(p, point).dot(normal);
  return out.copy(p).addScaledVector(normal, -d);
}

/**
 * The point on the line through `a` along `dir` nearest to a ray: where an
 * axis lock puts the end of a measurement under the pointer.
 *
 * @param {THREE.Ray} ray
 * @param {THREE.Vector3} a
 * @param {THREE.Vector3} dir unit length
 * @param {THREE.Vector3} out
 * @returns {THREE.Vector3} `out`
 */
export function closestOnLineToRay(ray, a, dir, out) {
  const w0 = scratchA.subVectors(a, ray.origin);
  const b = dir.dot(ray.direction);
  const d = dir.dot(w0);
  const e = ray.direction.dot(w0);
  const denominator = 1 - b * b;
  // A ray along the axis meets every point of it equally; keep the start.
  if (Math.abs(denominator) < 1e-9) return out.copy(a);
  const t = (b * e - d) / denominator;
  return out.copy(a).addScaledVector(dir, t);
}

/**
 * The angle between two directions, as lines rather than arrows: 0 to 90.
 *
 * @param {THREE.Vector3} u unit length
 * @param {THREE.Vector3} v unit length
 * @returns {Number} degrees
 */
export function lineAngle(u, v) {
  const c = Math.min(Math.abs(u.dot(v)), 1);
  return THREE.MathUtils.radToDeg(Math.acos(c));
}

/**
 * The angle at `vertex` between the arms to `a` and `c`: 0 to 180.
 *
 * @param {THREE.Vector3} a
 * @param {THREE.Vector3} vertex
 * @param {THREE.Vector3} c
 * @returns {Number} degrees, or NaN when an arm has no length
 */
export function angleAt(a, vertex, c) {
  const u = scratchA.subVectors(a, vertex);
  const v = scratchB.subVectors(c, vertex);
  if (u.lengthSq() === 0 || v.lengthSq() === 0) return NaN;
  return THREE.MathUtils.radToDeg(u.angleTo(v));
}

/**
 * The angle from +X to a direction, 0 to 180.
 *
 * @param {THREE.Vector3} d from the first point to the second
 * @returns {Number|undefined} degrees, or undefined for no length
 */
export function angleToX(d) {
  const length = d.length();
  if (length < 1e-12) return undefined;
  return THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(d.x / length, -1, 1)));
}

/**
 * What two picked ends say. Each end is `{ point, normal?, dir? }`: a face
 * brings its normal, an edge its direction, both unit length.
 *
 * @param {Object} a
 * @param {Object} b
 * @returns {Object} `distance, horizontal, vertical, dx, dy, dz`, and where
 *   the ends allow: `perpA`, `perpB` (distance from each face's plane to the
 *   other end), `faceAngle`, `gap` (parallel faces), `edgeAngle`
 */
export function distanceBetween(a, b) {
  const d = scratchC.subVectors(b.point, a.point);
  const values = {
    distance: d.length(),
    horizontal: Math.hypot(d.x, d.y),
    vertical: d.z,
    dx: d.x,
    dy: d.y,
    dz: d.z,
  };
  if (a.normal) values.perpA = Math.abs(d.dot(a.normal));
  if (b.normal) values.perpB = Math.abs(d.dot(b.normal));
  if (a.normal && b.normal) {
    const angle = lineAngle(a.normal, b.normal);
    if (angle < PARALLEL_DEG) values.gap = values.perpA;
    else values.faceAngle = angle;
  }
  if (a.dir && b.dir) values.edgeAngle = lineAngle(a.dir, b.dir);
  const xAngle = angleToX(d);
  if (xAngle !== undefined) values.xAngle = xAngle;
  return values;
}

/**
 * A length as the tool writes it: metres to the millimetre.
 *
 * @param {Number} metres
 * @returns {String}
 */
export function formatLength(metres) {
  return `${(Math.round(metres * 1000) / 1000).toFixed(3)} m`;
}

/**
 * An angle as the tool writes it: degrees to the tenth.
 *
 * @param {Number} degrees
 * @returns {String}
 */
export function formatAngle(degrees) {
  return `${(Math.round(degrees * 10) / 10).toFixed(1)}°`;
}
