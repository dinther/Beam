/* eslint-disable no-console */
/**
 * Every shape the user can build stands on its own origin.
 *
 * The origin is the middle of the base and the shape rises from z = 0, so a
 * Stage Table placed at z = 0 is on the floor. Shapes used to be centred on the
 * origin, which put every cube placed at z = 0 half into the floor -- and the
 * rule was only ever true of the plane. This pins it for every type, so a
 * shape added later cannot quietly go back to being centred.
 *
 * Usage:
 *   npm test
 */
import fs from 'fs';
import path from 'path';
import * as THREE from 'three';
import primitiveGeometry, { PRIMITIVE_TYPES as OBJECT_TYPES } from '@/plugins/visualizer/primitive_geometry';
/**
 * The list the main process validates writes against. Read as text rather than
 * imported: `objectstore.js` pulls in Electron, which will not load here, and
 * the main process cannot import three -- so the two copies of the list are
 * pinned together by this test instead of by an import.
 */
const STORED_TYPES = (() => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/electron/objectstore.js'), 'utf8');
  const match = source.match(/const PRIMITIVE_TYPES = \[([^\]]*)\]/);
  return match ? match[1].split(',').map((t) => t.trim().replace(/'/g, '')).filter(Boolean) : [];
})();

let failures = 0;

function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

/** Rounded to a micrometre, so float noise from the rotations reads as zero. */
const um = (value) => Math.round(value * 1e6) / 1e6 || 0;

function bounds(primitive) {
  const geometry = primitiveGeometry(primitive);
  geometry.computeBoundingBox();
  return geometry.boundingBox;
}

/** A size for every type that is not the default, so both paths are tested. */
const CUSTOM = {
  cube: { x: 1.8, y: 0.8, z: 0.75 },
  cylinder: { radius: 0.3, height: 2.4 },
  sphere: { radius: 0.7 },
  plane: { x: 4, y: 3 },
};

/** How tall each one should come out, from its own parameters. */
const HEIGHT = {
  cube: (size) => size.z || 1,
  cylinder: (size) => size.height || 1,
  sphere: (size) => (size.radius || 0.5) * 2,
  plane: () => 0,
};

console.log('\n-- the builder and the library agree on what a shape can be --');
check('the library list was found', STORED_TYPES.length > 0, true);
check('same list', OBJECT_TYPES.join(','), STORED_TYPES.join(','));

console.log('\n-- every type the form offers is covered here --');
OBJECT_TYPES.forEach((type) => {
  check(`${type} has a custom size in this test`, !!CUSTOM[type], true);
});

OBJECT_TYPES.forEach((type) => {
  [['default size', {}], ['custom size', CUSTOM[type] || {}]].forEach(([which, size]) => {
    console.log(`\n-- ${type}, ${which} --`);
    const box = bounds({ type, size });
    check('its lowest point is on the floor', um(box.min.z), 0);
    check('and it rises to its own height', um(box.max.z), um(HEIGHT[type](size)));
    check('centred across x', um(box.min.x + box.max.x), 0);
    check('centred across y', um(box.min.y + box.max.y), 0);
  });
});

console.log('\n-- an unknown type falls back to a cube, standing up too --');
{
  const box = bounds({ type: 'teapot', size: {} });
  check('on the floor', um(box.min.z), 0);
  check('a metre tall', um(box.max.z), 1);
}

console.log('\n-- a cylinder stands upright, not on its side --');
{
  // three builds a cylinder around Y; this scene is Z up. Getting the turn
  // wrong would leave it lying down, and lying down it would still sit on the
  // floor -- so the floor check alone would not catch it.
  const box = bounds({ type: 'cylinder', size: { radius: 0.3, height: 2.4 } });
  check('its height is along z', um(box.max.z - box.min.z), 2.4);
  check('its width across x is the diameter', um(box.max.x - box.min.x), 0.6);
}

// Guard against the one way this test could pass for the wrong reason.
check('three is the real one', typeof THREE.BoxGeometry, 'function');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
