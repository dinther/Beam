/* eslint-disable no-console */
/**
 * A structure's scale.
 *
 * What is pinned: scaling moves members away from the structure's origin along
 * its own axes; an object in it is drawn at its own scale times the
 * structure's, along the object's own axes; a fixture only moves; a show
 * reloaded with a scaled structure draws its objects at the same size; and an
 * object leaving keeps the size it was drawn at.
 *
 * Usage:
 *   npm test
 */
import Controls from '@/plugins/visualizer/controls';
import Structure from '@/models/DMX/structure.model';
import SceneObject from '@/models/DMX/object.model';

// No gizmo outside the app; see scene_item.test.js.
Controls.detach = () => {};
Controls.attach = () => {};

let failures = 0;

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)} got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`);
}

/** Rounded to a micrometre, so float noise reads as zero. */
const um = (v) => Math.round(v * 1e6) / 1e6 || 0;
const at = (item) => ({ x: um(item.position.x), y: um(item.position.y), z: um(item.position.z) });
const round = (s) => ({ x: um(s.x), y: um(s.y), z: um(s.z) });

console.log('\n-- scaling a structure spaces its members and sizes its objects --');
{
  const structure = new Structure({ name: 'rig', position: { x: 10, y: 0, z: 0 } });
  const truss = new SceneObject({ model: 'truss', position: { x: 12, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 2 } });
  // Turned a quarter about Z, so its own X runs along the structure's Y.
  const turned = new SceneObject({
    model: 'block', position: { x: 10, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: Math.PI / 2 },
  });
  structure.add(truss);
  structure.add(turned);
  check('unscaled: nothing moves on joining', at(truss), { x: 12, y: 0, z: 0 });

  structure.scale = { x: 2, y: 3, z: 1 };
  check('a member twice as far along x', at(truss), { x: 14, y: 0, z: 0 });
  check('and three times as far along y', at(turned), { x: 10, y: 3, z: 0 });
  check('its own scale is left as set', truss.scale, { x: 1, y: 1, z: 2 });
  check('drawn at its own scale times the structure', round(truss.drawnScale), { x: 2, y: 3, z: 2 });
  check('a turned object takes it along its own axes', round(turned.drawnScale), { x: 3, y: 2, z: 1 });
  check('the structure saves its scale', structure.showData.scale, { x: 2, y: 3, z: 1 });

  structure.scale = { x: 1, y: 1, z: 1 };
  check('back to 1: back where it was', at(truss), { x: 12, y: 0, z: 0 });
  check('and drawn at its own scale', round(truss.drawnScale), { x: 1, y: 1, z: 2 });
  check('an unscaled structure saves no scale', structure.showData.scale, undefined);
}

console.log('\n-- a reloaded show draws its objects at the same size --');
{
  // As a show reloads one: members where they were drawn, then joined.
  const structure = new Structure({ name: 'rig', scale: { x: 2, y: 2, z: 2 } });
  const truss = new SceneObject({ model: 'truss', position: { x: 4, y: 0, z: 0 } });
  structure.add(truss);
  structure.applyToMembers();
  check('it stays where it was drawn', at(truss), { x: 4, y: 0, z: 0 });
  check('and is drawn at the structure\'s scale', round(truss.drawnScale), { x: 2, y: 2, z: 2 });
  structure.scale = { x: 1, y: 1, z: 1 };
  check('unscaled, it comes in to where it was made', at(truss), { x: 2, y: 0, z: 0 });
}

console.log('\n-- leaving keeps an object the size it was drawn at --');
{
  const structure = new Structure({ name: 'rig' });
  const truss = new SceneObject({ model: 'truss', position: { x: 1, y: 0, z: 0 } });
  structure.add(truss);
  structure.scale = { x: 3, y: 3, z: 3 };
  structure.remove(truss);
  check('its own scale takes the structure\'s', round(truss.scale), { x: 3, y: 3, z: 3 });
  check('drawn the same size as before', round(truss.drawnScale), { x: 3, y: 3, z: 3 });
  check('where it stood', at(truss), { x: 3, y: 0, z: 0 });
}

console.log('\n-- a structure scales as a model from a file does --');
{
  const structure = new Structure({ name: 'rig' });
  check('it is scalable', structure.isScalable, true);
  check('at scale 1 it is its original size', structure.isOriginalSize, true);
  structure.previewScale({ x: 2, y: 2, z: 2 });
  check('a drag preview sets the scale', structure.scale, { x: 2, y: 2, z: 2 });
  structure.restoreSize();
  check('original size puts it back to 1', structure.scale, { x: 1, y: 1, z: 1 });
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
