/* eslint-disable no-console */
/**
 * A scene group is part of a MadMapper definition's identity.
 *
 * Two of the same model in different groups have to export as two definitions.
 * Sharing one made them a single kind of thing on the other side, with no way
 * to address them apart -- which is the whole point of grouping them here.
 *
 * Usage:
 *   npm test
 */
import { showDefinitions, SCRATCH_MANUFACTURER } from '@/models/DMX/generic/madmapper';

let failures = 0;

function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what.padEnd(56)} got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`);
}

/**
 * The little a definition needs to know about a fixture.
 *
 * A real profile, thin but valid: `profileParts` walks the mode's channels to
 * work out how many MadMapper fixtures a profile comes apart into, and an empty
 * one comes apart into none at all.
 */
const MODE = { name: 'Default', channels: ['Dimmer'] };
function fixture(name, group = null) {
  return {
    manufacturer: 'beatline',
    model: 'panel',
    modeName: 'Default',
    mode: MODE,
    universeAligned: false,
    OFLData: {
      name: 'Panel',
      categories: ['Other'],
      availableChannels: { Dimmer: { capability: { type: 'Intensity' } } },
      modes: [MODE],
    },
    group,
    label: name,
  };
}

console.log('\n-- ungrouped fixtures are unchanged --');
{
  const { definitions, nameOf } = showDefinitions([fixture('a'), fixture('b')]);
  check('two of a model share one definition', definitions.length, 1);
  check('and the name carries no group', nameOf(fixture('a')).includes('['), false);
}

console.log('\n-- a group makes its own definition --');
{
  const left = { id: 1, name: 'Tower Left' };
  const right = { id: 2, name: 'Tower Right' };
  const fixtures = [fixture('a', left), fixture('b', left), fixture('c', right)];
  const { definitions, nameOf } = showDefinitions(fixtures);
  check('one definition per group, not per fixture', definitions.length, 2);
  check(
    'members of a group share theirs',
    nameOf(fixtures[0]) === nameOf(fixtures[1]),
    true,
  );
  check('different groups do not', nameOf(fixtures[0]) === nameOf(fixtures[2]), false);
  check('and the group names them', nameOf(fixtures[0]).includes('[Tower Left]'), true);
}

console.log('\n-- grouped and loose of the same model live side by side --');
{
  const only = { id: 7, name: 'Stage' };
  const fixtures = [fixture('a'), fixture('b', only)];
  const { definitions, nameOf } = showDefinitions(fixtures);
  check('two definitions', definitions.length, 2);
  check('the loose one keeps the plain name', nameOf(fixtures[0]).includes('['), false);
  check(
    'the grouped one is named for its group',
    nameOf(fixtures[1]).includes('[Stage]'),
    true,
  );
}

console.log('\n-- the group is the identity, not the name --');
{
  // Two groups may be called the same thing; they are still two definitions,
  // because a name is a label and an id is what a fixture belongs to.
  const a = { id: 1, name: 'Wall' };
  const b = { id: 2, name: 'Wall' };
  const fixtures = [fixture('a', a), fixture('b', b)];
  const { definitions } = showDefinitions(fixtures);
  check('same-named groups are still separate', definitions.length, 2);
}

console.log('\n-- a structure is a group for this purpose --');
{
  // A structure is the tighter of the two -- a locked, deliberately arranged
  // set -- so if anything wants its own definition it does. It was left out
  // at first and its fixtures exported as the plain shared model.
  const rig = { id: 3, name: 'Truss A' };
  const loose = fixture('a');
  const held = fixture('b');
  held.group = null;
  held.structure = rig;
  const { definitions, nameOf } = showDefinitions([loose, held]);
  check('a structure earns its own definition', definitions.length, 2);
  check('named for the structure', nameOf(held).includes('[Truss A]'), true);
  check('the loose one is unchanged', nameOf(loose).includes('['), false);
}

console.log('\n-- a group and a structure sharing an id are still two --');
{
  const asGroup = fixture('a', { id: 1, name: 'One' });
  const asStructure = fixture('b');
  asStructure.structure = { id: 1, name: 'Two' };
  const { definitions } = showDefinitions([asGroup, asStructure]);
  check('the kind is part of the key', definitions.length, 2);
}

console.log('\n-- owned definitions are filed as scratch --');
{
  // MadMapper's library outlives the project. A definition scoped to one
  // group is not a product its manufacturer makes, and filing it under the
  // real name buries the genuine profiles among one-offs.
  const truss = { id: 1, name: 'Truss A' };
  const loose = fixture('a');
  const held = fixture('b', truss);
  const { nameOf } = showDefinitions([loose, held], () => 'Real Maker');
  check(
    'a loose fixture keeps its manufacturer',
    nameOf(loose).startsWith('Real Maker - '),
    true,
  );
  check(
    'a grouped one is scratch',
    nameOf(held).startsWith(`${SCRATCH_MANUFACTURER} - `),
    true,
  );
  check('and still names its group', nameOf(held).includes('[Truss A]'), true);
}

console.log('\n-- a structure is scratch too --');
{
  const held = fixture('c');
  held.structure = { id: 4, name: 'Flank' };
  const { nameOf } = showDefinitions([held], () => 'Real Maker');
  check(
    'filed under scratch',
    nameOf(held).startsWith(`${SCRATCH_MANUFACTURER} - `),
    true,
  );
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
