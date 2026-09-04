/* eslint-disable no-console */
/**
 * An inline object's geometry is cached under a key that is its own.
 *
 * `SceneObjects` caches a built shape under the object's render key and hands
 * the same build back to anything asking for that key again. The key used to be
 * the showfile id -- which two different shows hand out freely, and which the
 * migration mints for the floor it seeds from a session counter. Open a second
 * project and its stage asked for `inline:1`, which the first project's floor
 * had already filled in. Stage is a floor, screen is a floor, floor is a floor.
 *
 * The uid is stamped per object per run and never reused, so this cannot
 * happen however the saved ids fall.
 *
 * Usage:
 *   npm test
 */
import SceneObject from '@/models/DMX/object.model';

let failures = 0;

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`);
}

const plane = { type: 'plane', size: { x: 50, y: 50 }, color: '#6e7276' };
const box = { type: 'box', size: { x: 2, y: 1, z: 3 }, color: '#222222' };

console.log('\n-- two shows, the same saved id --');
{
  // What one project calls object 1, and what the next one does.
  const floor = new SceneObject({ id: 1, name: 'Floor', primitive: plane });
  const stage = new SceneObject({ id: 1, name: 'Stage', primitive: box });

  check('the saved ids do collide', floor.id === stage.id, true);
  check('the render keys do not', floor.renderKey === stage.renderKey, false);
  check('the second is not keyed by its saved id',
    stage.renderKey === `inline:${stage.id}`, false);
  check('but by its uid', stage.renderKey, `inline:${stage.uid}`);
}

console.log('\n-- two objects built the same way --');
{
  // Identical parameters, and still one key each: they are editable
  // separately, so they are not the same geometry.
  const first = new SceneObject({ primitive: box });
  const second = new SceneObject({ primitive: box });
  check('keys differ', first.renderKey === second.renderKey, false);
}

console.log('\n-- a reference still shares its library model --');
{
  // The whole point of instancing a truss: two hundred of them, one build.
  const one = new SceneObject({ model: 'Silo_gantry' });
  const two = new SceneObject({ model: 'Silo_gantry' });
  check('same key', one.renderKey, two.renderKey);
  check('which is the library key', one.renderKey, 'Silo_gantry');
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exitCode = failures ? 1 : 0;
