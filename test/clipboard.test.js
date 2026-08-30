/* eslint-disable no-console */
/**
 * What copying a mixed selection takes with it.
 *
 * The rules only bite where a selection holds a container and its contents at
 * once, which is easy to do by accident -- rubber-band a truss and the heads
 * standing in it and the selection holds both. Copying that has to give one
 * truss, not a truss and a set of loose heads standing inside it.
 *
 * `chunkFor` is pure and takes models, so the awkward cases can be built here
 * without a show behind them.
 *
 * Usage:
 *   npm test
 */
import Controls from '@/plugins/visualizer/controls';
import Fixture from '@/models/DMX/fixture.model';
import Structure from '@/models/DMX/structure.model';
import Group from '@/models/DMX/group.model';
import SceneObject from '@/models/DMX/object.model';
import { chunkFor, chunkSummary } from '@/models/DMX/clipboard';

// The gizmo detaches around every write and wants a viewport to do it. Same
// bargain `scene_item.test.js` makes, for the same reason.
Controls.detach = () => {};
Controls.attach = () => {};

let failures = 0;

function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

/** A fixture that can stand in a scene without a profile behind it. */
const head = (id, name) => {
  const fixture = new Fixture({ isStub: true });
  fixture.id = id;
  fixture.name = name;
  fixture._position = { x: id, y: 0, z: 0 };
  fixture._rotation = { x: 0, y: 0, z: 0 };
  return fixture;
};

const heads = [1, 2, 3].map((n) => head(n, `Head ${n}`));
const loose = head(4, 'Loose head');
const object = new SceneObject({ id: 1, name: 'Truss model' });

const truss = new Structure({ id: 1, name: 'Front truss' });
heads.forEach((member) => truss.add(member));

const names = (records) => records.map((record) => record.name).join(', ');

console.log('\na structure is copied whole');
{
  const chunk = chunkFor([truss]);
  check('one structure', chunk.structures.length, 1);
  check('and its three members', names(chunk.fixtures), 'Head 1, Head 2, Head 3');
  check('members named by the structure', chunk.structures[0].members.join(), '1,2,3');
}

console.log('\na member selected beside its structure is not copied twice');
{
  const chunk = chunkFor([truss, heads[1]]);
  check('still one structure', chunk.structures.length, 1);
  check('still three fixtures', chunk.fixtures.length, 3);
}

console.log('\na member copied without its structure comes loose');
{
  const chunk = chunkFor([heads[1]]);
  check('no structure', chunk.structures.length, 0);
  check('one fixture', names(chunk.fixtures), 'Head 2');
  // Left in, it would name a truss in the show it was copied from -- and after
  // a paste into another show, one that has nothing to do with it.
  check('and it points at no structure', chunk.fixtures[0].structureId, undefined);
}

console.log('\na group takes its members, the way deleting one does');
{
  const band = new Group({ id: 1, name: 'Band' });
  band.add(loose);
  const chunk = chunkFor([band]);
  check('one group', chunk.groups.length, 1);
  check('holding its member', names(chunk.fixtures), 'Loose head');
  check('and the member is not a stray', chunk.fixtures[0].groupId, undefined);
  band.remove(loose);
}

console.log('\na mixed selection keeps each kind');
{
  const chunk = chunkFor([truss, loose, object]);
  const counts = chunkSummary(chunk);
  check('structures', counts.structures, 1);
  check('objects', counts.objects, 1);
  check('fixtures: three in the truss and one loose', counts.fixtures, 4);
  check('total', counts.total, 6);
}

console.log('\nthe same item selected twice arrives once');
{
  const chunk = chunkFor([loose, loose]);
  check('one fixture', chunk.fixtures.length, 1);
}

console.log('\nnothing selected is an empty chunk, not a broken one');
{
  const counts = chunkSummary(chunkFor([]));
  check('total', counts.total, 0);
  check('and undefined is survivable', chunkSummary(chunkFor()).total, 0);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
