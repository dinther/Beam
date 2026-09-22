/* eslint-disable no-console */
/**
 * The strobe renderer, driven without a GPU.
 *
 * three builds geometry, materials and scene graph in plain node; only drawing
 * needs a context. So a strobe can be built, ticked, asked for its light and
 * its wash, and torn down here, with its settings behind it, exactly as the
 * scene would do it.
 *
 * Usage:
 *   npm test
 */
import * as THREE from 'three';
import Strobe from '@/plugins/visualizer/strobe';
import LightField from '@/plugins/visualizer/light_field';
import SceneManager from '@/plugins/visualizer/scene_manager';
import { buildStrobeProfile } from '@/models/DMX/generic/strobe';
import StrobeSettings from '@/models/DMX/strobe_settings';
import { SHUTTER_MODES } from '@/plugins/visualizer/shutter';

let failures = 0;

function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

function near(label, got, want, tol = 1e-6) {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)} got ${got}  want ~${want} (±${tol})`);
}

const profile = buildStrobeProfile();
const settings = new StrobeSettings(profile.asls.strobe);
const before = SceneManager.children.length;
const strobe = new Strobe({ params: profile.asls.strobe, settingsAt: () => settings });
strobe.position = { x: 1, y: 2, z: 1.5 };
strobe.rotation = { x: 0, y: 0, z: 0 };

console.log('--- built');
check('one node added to the scene', SceneManager.children.length, before + 1);
check('two pickable parts', Strobe.pickObjects().length, 2);
near('floor offset is half the height', strobe.floorOffset, 0.11);
{
  const box = new THREE.Box3();
  strobe.expandBounds(box);
  near('bounds are the body: width', box.max.x - box.min.x, 0.36, 1e-9);
  near('bounds are the body: depth', box.max.y - box.min.y, 0.14, 1e-9);
  near('bounds are the body: height', box.max.z - box.min.z, 0.22, 1e-9);
}

console.log('--- dark until the shutter opens');
settings.set('mode', SHUTTER_MODES.OFF);
Strobe.update(1 / 60);
Strobe.update(2 / 60);
check('off: nothing lit', strobe.lit, 0);
const record = {
  position: new THREE.Vector3(),
  direction: new THREE.Vector3(),
  color: new THREE.Color(),
  intensity: 0,
  range: 0,
  cosOuter: 0,
  cosInner: 0,
};
check('off: contributes no light', strobe.readLight(record), false);
{
  const wash = new THREE.Color();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(1, -3, 1.5);
  camera.lookAt(1, 2, 1.5);
  camera.updateMatrixWorld();
  Strobe.cameraWash(camera, wash);
  check('off: no wash', wash.r + wash.g + wash.b, 0);
}

console.log('--- held on as a blinder');
settings.set('blinder', true);
Strobe.update(3 / 60);
near('blinder: fully lit', strobe.lit, 1);
check('blinder: contributes light', strobe.readLight(record), true);
near('light sits at the face: x', record.position.x, 1, 1e-9);
near('light sits at the face: y', record.position.y, 2 - 0.07 - 0.003, 1e-9);
near('light points back up the flood', record.direction.y, 1, 1e-9);
near('cone is the flood half angle', record.cosOuter, Math.cos((55 * Math.PI) / 180), 1e-9);
check('range is bounded', record.range, 60);
check('intensity is positive', record.intensity > 0, true);
{
  const wash = new THREE.Color();
  const camera = new THREE.PerspectiveCamera();
  // Square in front of the face, looking at it.
  camera.position.set(1, -3, 1.5);
  camera.lookAt(1, 2, 1.5);
  camera.updateMatrixWorld();
  Strobe.cameraWash(camera, wash);
  check('blinder: washes a camera in front', wash.g > 0, true);
  const front = wash.g;
  // Behind the strobe: outside the flood, no wash at all.
  camera.position.set(1, 6, 1.5);
  camera.lookAt(1, 2, 1.5);
  camera.updateMatrixWorld();
  Strobe.cameraWash(camera, wash);
  check('blinder: no wash from behind', wash.g, 0);
  // In front but looking away: some, less.
  camera.position.set(1, -3, 1.5);
  camera.lookAt(1, -10, 1.5);
  camera.updateMatrixWorld();
  Strobe.cameraWash(camera, wash);
  check('blinder: less wash looking away', wash.g > 0 && wash.g < front, true);
}

console.log('--- colour follows the levels');
settings.set('red', 100);
settings.set('green', 0);
settings.set('blue', 0);
Strobe.update(4 / 60);
strobe.readLight(record);
check('red only: green is out', record.color.g, 0);
check('red only: red is in', record.color.r > 0, true);

console.log('--- strobing');
settings.set('blinder', false);
settings.set('mode', SHUTTER_MODES.STROBE);
settings.set('rate', 10);
let lit = 0;
for (let i = 5; i < 125; i += 1) {
  Strobe.update(i / 60);
  if (strobe.lit > 0) lit += 1;
}
check('10 Hz over two seconds: about twenty lit frames', lit >= 19 && lit <= 21, true);

console.log('--- one flash on the trigger');
settings.set('mode', SHUTTER_MODES.OFF);
Strobe.update(126 / 60);
Strobe.update(127 / 60);
settings.set('flash', true);
strobe.refresh();
settings.set('flash', false);
strobe.refresh();
Strobe.update(128 / 60);
near('the frame after the trigger is lit', strobe.lit, 1);
Strobe.update(129 / 60);
check('and the next is dark', strobe.lit, 0);

console.log('--- torn down');
Strobe.deleteInstance(strobe);
check('node removed from the scene', SceneManager.children.length, before);
check('no pickable parts left', Strobe.pickObjects().length, 0);
check('light field forgets it', LightField.update(), 0);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
