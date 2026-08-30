/* eslint-disable no-console */
/**
 * What an arrangement's aim does to an item that is not standing upright.
 *
 * The maths of the shapes themselves is easy to eyeball -- a circle is a
 * circle. Facing is not: an aim is a heading *in the room*, and the three
 * angles an item stores are read as an XYZ Euler, where the z turn happens
 * inside the other two. Writing the heading straight into z therefore spins
 * the item about its own axis, which is right only while the other two are
 * zero. A head hanging at `rotX: 180` came out mirrored, and an object tipped
 * about y leaned instead of swinging.
 *
 * So every check here reads the heading back off the item's forward axis with
 * three, rather than off the numbers `aimedRotation` returned. The numbers are
 * one of several triples meaning the same orientation; where the item ends up
 * pointing is the thing that was wrong.
 *
 * Usage:
 *   npm test
 */
import * as THREE from 'three';
import { aimedRotation, headingOf } from '@/models/DMX/arrangement';

let failures = 0;

function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(50)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

const D = Math.PI / 180;

/** The orientation those three stored angles mean, as the scene reads them. */
const quaternion = (r) => new THREE.Quaternion().setFromEuler(
  new THREE.Euler(r.x * D, r.y * D, r.z * D, 'XYZ'),
);

/** Where the item actually points, as a bearing in 0..360. */
const bearing = (r) => {
  const f = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion(r));
  return Math.round((((Math.atan2(f.y, f.x) / D) % 360) + 360) % 360);
};

/** How far the item points out of the floor plane -- its tilt, in degrees. */
const tilt = (r) => Math.round(
  Math.asin(new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion(r)).z) / D,
);

/** Degrees between two orientations, whatever triples they are written as. */
const apart = (a, b) => Math.round(quaternion(a).angleTo(quaternion(b)) / D);

console.log('\nan upright item still takes the aim as its z');
[0, 37, 90, 200].forEach((aim) => {
  const out = aimedRotation({ x: 0, y: 0, z: 15 }, aim);
  check(`aim ${aim}`, Math.round(((out.z % 360) + 360) % 360), aim);
  check('  and nothing else moved', Math.abs(Math.round(out.x)) + Math.abs(Math.round(out.y)), 0);
});

console.log('\nan item tipped about y swings rather than leans');
[15, 30, 60].forEach((y) => {
  const before = { x: 0, y, z: 20 };
  [45, 137, 250].forEach((aim) => {
    const after = aimedRotation(before, aim);
    check(`tipped ${y}, aim ${aim}`, bearing(after), aim);
    check('  keeping its tilt', tilt(after), tilt(before));
  });
});

console.log('\na head hanging at rotX 180 aims where it is told');
[45, 90, 270].forEach((aim) => {
  const before = { x: 180, y: 0, z: 33 };
  const after = aimedRotation(before, aim);
  check(`aim ${aim}`, bearing(after), aim);
  // The old maths wrote the aim into z, which for a hanging head is a mirror.
  check('  where writing it into z would not', bearing({ ...before, z: aim }), (360 - aim) % 360);
  check('  and it is still hanging', apart(after, { x: 180, y: 0, z: after.z }), 0);
});

console.log('\nthe turn is only ever about the room\'s vertical');
[
  { x: 0, y: 0, z: 0 },
  { x: 180, y: 0, z: 33 },
  { x: 12, y: -47, z: 130 },
  { x: -95, y: 20, z: -12 },
].forEach((before) => {
  const after = aimedRotation(before, 111);
  // Undo the heading change and the two orientations must coincide: anything
  // else means the item was tumbled as well as turned.
  const back = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 0, 1),
    -(bearing(after) - bearing(before)) * D,
  );
  const undone = quaternion(after).premultiply(back);
  check(
    `(${before.x}, ${before.y}, ${before.z}) turns and nothing more`,
    Math.round(undone.angleTo(quaternion(before)) / D),
    0,
  );
});

console.log('\na heading is read off the item, not off its stored z');
check('upright, z 90', Math.round(headingOf({ x: 0, y: 0, z: 90 })), 90);
check('hanging, z 90', Math.round(headingOf({ x: 180, y: 0, z: 90 })), 270);

console.log('\nan item pointing straight up has no bearing of its own');
// Nothing of its forward axis is left in the floor plane, so the heading comes
// off the axis that is: it can still be turned, and the turn still shows.
const upright = { x: 0, y: -90, z: 0 };
check('straight up reads as zero rather than NaN', Math.round(headingOf(upright)), 0);
const turned = aimedRotation(upright, 40);
check('and it takes an aim', Math.round(headingOf(turned)), 40);
check('  while still pointing up', tilt(turned), 90);

console.log('\nno aim leaves the item exactly as it was');
check('null', aimedRotation({ x: 5, y: 6, z: 7 }, null).z, 7);
check('undefined', aimedRotation({ x: 5, y: 6, z: 7 }).z, 7);
check('a string nobody parsed', aimedRotation({ x: 5, y: 6, z: 7 }, 'outward').z, 7);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
