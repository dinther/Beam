/* eslint-disable no-console */
/**
 * What counts as a name, when something is saved to the library.
 *
 * The library is a file per item, named for the item, and placing a stamp
 * again means finding it by that name. So a structure still carrying the name
 * it was handed -- `untitled 1`, `Group 3` -- has no name as far as the
 * library is concerned: saving it files something nobody can identify, and
 * saving a second one overwrites the first.
 *
 * The awkward part is that the placeholder is not an empty string. Names are
 * run through `uniqueStructureName`, which turns a blank into `untitled`, so
 * "no name" has to be recognised by shape rather than by emptiness -- which is
 * what these check.
 *
 * Usage:
 *   npm test
 */
import Show, { isNamedByUser } from '@/models/DMX/show.model';

let failures = 0;

function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(50)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

console.log('\nthe names the app hands out are not names');
['untitled', 'untitled 1', 'Untitled 12', 'Group', 'Group 3', 'structure', 'Structure 2']
  .forEach((name) => check(name, isNamedByUser(name), false));

console.log('\nnor is nothing at all');
['', '   ', null, undefined].forEach((name) => check(String(JSON.stringify(name)), isNamedByUser(name), false));

console.log('\nanything somebody typed is');
['Fusion ring', 'Group of six', 'untitled sketches', 'Bar 1', 'Structure of the show', '3']
  .forEach((name) => check(name, isNamedByUser(name), true));

console.log('\nan unnamed structure is refused before anything is written');
// Called against a bare object: reaching the write would need a real matrix
// and members, so returning null proves the guard came first.
Show.prototype.saveStructure.call({}, { name: 'untitled 1' })
  .then((result) => {
    check('saveStructure returns null', result, null);
    console.log(failures ? `\n${failures} FAILED` : '\nall passed');
    process.exit(failures ? 1 : 0);
  });
