/**
 * @file Turning an orientation back into angles without the angles jumping.
 *
 * Every orientation has two XYZ Euler triples: (x, y, z) and
 * (x + 180, 180 - y, z + 180). three's `setFromQuaternion` always returns the
 * one with y between -90 and 90, so a fixture turned 180 degrees about Y came
 * back as X 180, Y 0, Z 180. The same orientation, but a moving head reads X
 * 180 as hung upside down and flips its body, and the numbers in the fields
 * are not the ones typed. Of the two, this keeps the triple nearest the angles
 * the item already had, each wrapped to within half a turn of them.
 */

const TURN = Math.PI * 2;

/** An angle moved by whole turns to within half a turn of a reference. */
function near(angle, reference) {
  return angle - TURN * Math.round((angle - reference) / TURN);
}

/**
 * The XYZ Euler triple for an orientation that lies nearest a previous one.
 *
 * @param {Object} euler a THREE.Euler, order XYZ, from `setFromQuaternion`
 * @param {Object} [previous] `{ x, y, z }` in radians, the item's last angles
 * @returns {Object} `{ x, y, z }` in radians
 */
export default function closestEuler(euler, previous) {
  const p = previous || { x: 0, y: 0, z: 0 };
  const px = Number(p.x) || 0;
  const py = Number(p.y) || 0;
  const pz = Number(p.z) || 0;
  const a = { x: near(euler.x, px), y: near(euler.y, py), z: near(euler.z, pz) };
  const b = {
    x: near(euler.x + Math.PI, px),
    y: near(Math.PI - euler.y, py),
    z: near(euler.z + Math.PI, pz),
  };
  const cost = (t) => Math.abs(t.x - px) + Math.abs(t.y - py) + Math.abs(t.z - pz);
  return cost(b) < cost(a) - 1e-6 ? b : a;
}
