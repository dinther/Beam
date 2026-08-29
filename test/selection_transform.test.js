/* eslint-disable no-console */
/**
 * A selection presented as one transform.
 *
 * The position tool is pointed at this instead of at a single item when several
 * things are selected, so it has to answer the same six accessors a scene item
 * does. The two halves behave differently on purpose -- position is a
 * coordinate the centre is moved to, rotation is a running total the selection
 * is turned by -- and that difference is the thing worth pinning down, because
 * it is the part a later reader is most likely to "fix" into consistency.
 *
 * The rotation half is committed twice on purpose in places: a value written a
 * second time must do nothing. The control behind this field commits on Enter
 * and again on blur, and while the second commit still turned the rig, typing
 * 45 degrees turned it 90.
 *
 * Usage:
 *   npm test
 */
import Controls from '@/plugins/visualizer/controls';
import SceneObject from '@/models/DMX/object.model';
import SelectionTransform from '@/models/DMX/selection_transform';

// The gizmo detaches around every axis write and needs a viewport to do it.
// Same bargain as `scene_item.test.js`.
Controls.detach = () => {};
Controls.attach = () => {};

let failures = 0;

function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(50)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

/** An object at a position, as a stand-in for anything placeable. */
function at(x, y, z) {
  const item = new SceneObject({ name: 'test' });
  item.position = { x, y, z };
  return item;
}

const round = (n) => Math.round(n * 1000) / 1000;

/**
 * Whole degrees, wrapped to (-180, 180].
 *
 * Turns are composed as quaternions and read back through an Euler, which
 * answers with whichever equivalent triple is canonical -- so a half turn comes
 * back as -180 rather than the 180 that was asked for. They are the same
 * heading, and a test that insisted on the sign would be pinning down the
 * conversion rather than the behaviour.
 */
const deg = (n) => {
  const wrapped = ((Math.round(n) % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
};

console.log('centre is the average of where the items are');
let items = [at(0, 0, 0), at(4, 0, 0), at(2, 6, 3)];
let selection = new SelectionTransform(items);
check('counts what it speaks for', selection.count, 3);
check('centre x', round(selection.posX), 2);
check('centre y', round(selection.posY), 2);
check('centre z', round(selection.posZ), 1);

console.log('\nposition moves the group and keeps its shape');
selection.posX = 10;
check('centre landed where asked', round(selection.posX), 10);
check('first item moved by the offset', round(items[0].position.x), 8);
check('second item moved by the same', round(items[1].position.x), 12);
check('spread survives', round(items[1].position.x - items[0].position.x), 4);
check('other axes untouched', round(items[2].position.y), 6);

console.log('\na non-finite coordinate is refused, not applied');
const before = round(items[0].position.x);
selection.posX = Number.NaN;
check('NaN left everything alone', round(items[0].position.x), before);

console.log('\nrotation swings the whole selection about its centre');
// Two items on the X axis, so the centre is (2, 0, 0). A quarter turn about Z
// puts them on the line x = 2: (2, -2) and (2, 2). Worked by hand because this
// is the arithmetic a later reader is most likely to "simplify".
items = [at(0, 0, 0), at(4, 0, 0)];
selection = new SelectionTransform(items);
selection.rotZ = 90;
check('first item carried round the centre (x)', round(items[0].position.x), 2);
check('first item carried round the centre (y)', round(items[0].position.y), -2);
check('second item carried round too (x)', round(items[1].position.x), 2);
check('second item carried round too (y)', round(items[1].position.y), 2);
check('the centre itself did not move', round(selection.posX), 2);
check('items are turned as well as carried', deg(items[0].rotZ), 90);

console.log('\nthe field holds the total turned, and applies the difference');
check('reads back what was applied', selection.rotZ, 90);
// The same value again: Enter and then blur both commit whatever the field
// displays, and the second of them must not turn anything.
selection.rotZ = 90;
check('the same value again does nothing', deg(items[0].rotZ), 90);
check('and does not move anything either', round(items[0].position.x), 2);
// A spinner click reads the displayed 90 and sends 91.
selection.rotZ = 91;
check('one degree more turns one degree', deg(items[0].rotZ), 91);
selection.rotZ = 180;
check('a second quarter turn compounds', deg(items[0].rotZ), 180);
check('and carries on round', round(items[0].position.x), 4);

console.log('\na fresh selection starts the total again');
check('nothing turned yet', new SelectionTransform(items).rotZ, 0);

console.log('\na zero turn does nothing');
items = [at(0, 0, 0), at(4, 0, 0)];
selection = new SelectionTransform(items);
selection.rotZ = 0;
check('positions left alone', round(items[1].position.x), 4);

console.log('\nthings without a transform are not counted');
// A group appears in the item list and can be selected, but it has no
// transform of its own and must not drag the average about.
selection = new SelectionTransform([at(0, 0, 0), { kind: 'group', id: 1 }, at(4, 0, 0)]);
check('a group is left out', selection.count, 2);
check('and out of the centre', round(selection.posX), 2);

console.log('\nan empty selection answers without throwing');
selection = new SelectionTransform([]);
check('centre of nothing', selection.posX, 0);
selection.posX = 5;
check('and cannot be moved', selection.posX, 0);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
