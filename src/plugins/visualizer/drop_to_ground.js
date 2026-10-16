import * as THREE from 'three';
import { toRaw } from 'vue';
import SceneObjects from './scene_objects';

/**
 * @file Drop to ground: stands an item on the surface under it.
 *
 * Ground is the upward-facing faces of visible scene objects -- a floor, a
 * stage deck, a table -- and z = 0, which always counts. Rays go straight down
 * at nine points across the item's footprint as drawn (corners, edge middles,
 * centre), so a corner over a step is not missed, and the highest surface
 * found is the one a rigid item rests on.
 *
 * An item sitting in a surface rises onto it; otherwise it drops to the
 * highest surface below. It does not move, and says why, when it is buried more
 * than half its height in something, or when rising would push it into
 * something above.
 */

/** Surfaces facing up at least this steeply count as ground. */
const UPWARD = 0.5;
/** Metres: closer than this counts as already resting. */
const RESTING = 0.001;
/** Footprint points are pulled in by this share of the size, off the very edges. */
const INSET = 0.02;

const raycaster = new THREE.Raycaster();
const down = new THREE.Vector3(0, 0, -1);
const up = new THREE.Vector3(0, 0, 1);
const origin = new THREE.Vector3();
const instance = new THREE.Matrix4();
const world = new THREE.Matrix4();
const normals = new THREE.Matrix3();
const normal = new THREE.Vector3();

/**
 * An item's bounds as drawn.
 *
 * @param {Object} item a fixture, object or structure
 * @returns {THREE.Box3|null}
 */
function boundsOf(item) {
  const model = item && toRaw(item._3DModel);
  if (!model || !model.expandBounds) return null;
  const box = new THREE.Box3();
  model.expandBounds(box);
  return box.isEmpty() ? null : box;
}

/** Nine points across a footprint, at height z. */
function footprint(box, z) {
  const sx = (box.max.x - box.min.x) * INSET;
  const sy = (box.max.y - box.min.y) * INSET;
  const xs = [box.min.x + sx, (box.min.x + box.max.x) / 2, box.max.x - sx];
  const ys = [box.min.y + sy, (box.min.y + box.max.y) / 2, box.max.y - sy];
  return xs.flatMap((x) => ys.map((y) => [x, y, z]));
}

/**
 * The world-space normal of a hit on an instanced scene object.
 *
 * @param {Object} hit
 * @returns {THREE.Vector3}
 */
function normalOf(hit) {
  hit.object.getMatrixAt(hit.instanceId, instance);
  world.multiplyMatrices(hit.object.matrixWorld, instance);
  normals.getNormalMatrix(world);
  return normal.copy(hit.face.normal).applyMatrix3(normals).normalize();
}

/**
 * Scene-object hits along a ray that belong to something other than the item.
 *
 * @param {Array} xyz ray origin
 * @param {THREE.Vector3} direction
 * @param {Number} far metres
 * @param {Function} isSelf `owner => Boolean`
 * @returns {Array} hits, nearest first
 */
function hitsAlong(xyz, direction, far, isSelf) {
  raycaster.set(origin.set(xyz[0], xyz[1], xyz[2]), direction);
  raycaster.far = far;
  return raycaster.intersectObjects(SceneObjects.pickObjects(), false).filter((hit) => {
    if (!hit.face || hit.instanceId === undefined) return false;
    const owner = SceneObjects.ownerAt(hit.object, hit.instanceId);
    return owner && !owner.isHidden && !isSelf(owner);
  });
}

/**
 * Where an item would stand, without moving it.
 *
 * @param {Object} item a fixture, object or structure
 * @returns {Object} `{ delta }` in metres to move up (negative is down), or
 *   `{ refused }` with the reason
 */
export function groundFor(item) {
  const box = boundsOf(item);
  if (!box) return { refused: 'It has no shape to stand yet.' };
  const raw = toRaw(item);
  const isSelf = (owner) => {
    const o = toRaw(owner);
    return o === raw || toRaw(o.structure) === raw || toRaw(o.group) === raw;
  };
  const bottom = box.min.z;
  const height = box.max.z - box.min.z;
  const middle = bottom + height / 2;

  // Sitting in something: an upward face between its bottom and its middle,
  // on something that starts no higher than it does -- a deck it is sunk
  // into, both standing on the floor, not a box standing inside it. Below
  // z = 0 it is in the ground itself, which always lifts it.
  let buried = null;
  const reachesBelow = new Map();
  const supports = (owner) => {
    if (!reachesBelow.has(owner)) {
      const theirs = boundsOf(owner);
      reachesBelow.set(owner, !!theirs && theirs.min.z <= bottom + RESTING);
    }
    return reachesBelow.get(owner);
  };
  footprint(box, middle).forEach((point) => {
    hitsAlong(point, down, middle - bottom + RESTING, isSelf).forEach((hit) => {
      if (hit.point.z <= bottom + RESTING || normalOf(hit).z < UPWARD) return;
      if (!supports(SceneObjects.ownerAt(hit.object, hit.instanceId))) return;
      buried = buried === null ? hit.point.z : Math.max(buried, hit.point.z);
    });
  });
  if (buried !== null && buried - bottom > height / 2) {
    return { refused: 'It is inside something; move it clear first.' };
  }

  let target;
  if (buried !== null || bottom < -RESTING) {
    target = Math.max(buried === null ? 0 : buried, bottom < -RESTING ? 0 : -Infinity);
  } else {
    // The highest surface below; z = 0 always counts. Rays start just above
    // the bottom, so the surface it already rests on is found, not the one
    // under that.
    target = bottom >= 0 ? 0 : bottom;
    footprint(box, bottom + 2 * RESTING).forEach((point) => {
      const below = hitsAlong(point, down, Infinity, isSelf)
        .find((hit) => normalOf(hit).z >= UPWARD);
      if (below) target = Math.max(target, below.point.z);
    });
  }

  const delta = target - bottom;
  if (Math.abs(delta) < RESTING) return { delta: 0 };
  if (delta > 0) {
    // Rising must not push it into something overhead.
    const blocked = footprint(box, box.max.z - RESTING)
      .some((point) => hitsAlong(point, up, delta + RESTING, isSelf).length > 0);
    if (blocked) return { refused: 'No room to stand there.' };
  }
  return { delta };
}

/**
 * Stands each item on the ground under it, each on its own.
 *
 * @public
 * @param {Array} items fixtures, objects or structures; held members are skipped
 * @returns {Object} `{ moved, refused }`: how many moved, and the reasons the
 *   others did not, as `{ item, reason }`
 */
export default function dropToGround(items) {
  let moved = 0;
  const refused = [];
  (items || []).filter((item) => item && !item.locked).forEach((item) => {
    const result = groundFor(item);
    if (result.refused) {
      refused.push({ item, reason: result.refused });
      return;
    }
    if (!result.delta) return;
    item.posZ = Math.round((item.posZ + result.delta) * 1000) / 1000;
    moved += 1;
  });
  return { moved, refused };
}
