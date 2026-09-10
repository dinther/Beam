/* eslint-disable no-console */
/**
 * A show's own fixture definitions: they travel in the show file, bars stored
 * without their channel list, and a definition lives only while something
 * places it.
 *
 * Usage:
 *   npm test
 */
import DefinitionStore from '@/models/DMX/definition_store';
import { buildLedBarProfile, DEFAULT_BAR_PARAMS } from '@/models/DMX/generic/led_bar';
import { buildProjectorProfile } from '@/models/DMX/generic/projector';

let failures = 0;

function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

const bar = buildLedBarProfile({ ...DEFAULT_BAR_PARAMS, columns: 60, rows: 1 });
bar.name = 'Bar 60';
const projector = buildProjectorProfile({});
projector.name = 'Beamer';

console.log('\n-- a store holds what the show made --');
{
  const store = new DefinitionStore();
  check('empty to start', store.size, 0);
  store.add('Beatline/Bar 60', bar);
  store.add('Beatline/Beamer', projector);
  check('two definitions', store.size, 2);
  check('found by key', store.has('Beatline/Bar 60'), true);
  check('and not by a key nobody made', store.has('Beatline/Nothing'), false);
  check('the profile comes back whole', store.get('Beatline/Bar 60').modes[0].channels.length, 180);
  check('a missing one is null', store.get('Beatline/Nothing'), null);
}

console.log('\n-- it travels in the show file, compact --');
{
  const store = new DefinitionStore();
  store.add('Beatline/Bar 60', bar);
  store.add('Beatline/Beamer', projector);
  const json = JSON.parse(JSON.stringify(store.toJSON()));

  check('both keys written', Object.keys(json).length, 2);
  check('a bar is written without its channels', json['Beatline/Bar 60'].modes, undefined);
  check('but keeps its geometry', json['Beatline/Bar 60'].asls.bar.columns, 60);
  check('a projector is written as it is', Array.isArray(json['Beatline/Beamer'].modes), true);

  const back = DefinitionStore.fromJSON(json);
  check('and reads back', back.size, 2);
  check('with the bar channels rebuilt', back.get('Beatline/Bar 60').modes[0].channels.length, 180);
  check('same name', back.get('Beatline/Bar 60').name, 'Bar 60');
}

console.log('\n-- a show written before definitions travelled --');
check('nothing is fine', DefinitionStore.fromJSON(undefined).size, 0);
check('and so is null', DefinitionStore.fromJSON(null).size, 0);
check('a null entry is skipped', DefinitionStore.fromJSON({ 'a/b': null }).size, 0);

console.log('\n-- a definition exists only while something uses it --');
{
  const store = new DefinitionStore();
  store.add('Beatline/Bar 60', bar);
  store.add('Beatline/Beamer', projector);
  store.add('Beatline/Unplaced', projector);

  const gone = store.prune(['Beatline/Bar 60', 'Beatline/Beamer', 'Martin/MAC Aura']);
  check('the unplaced one goes', gone.join(','), 'Beatline/Unplaced');
  check('the placed ones stay', store.size, 2);
  check('a library key in use is not the store\'s business', store.has('Martin/MAC Aura'), false);

  const all = store.prune([]);
  check('deleting the last instance takes the rest', all.length, 2);
  check('leaving nothing', store.size, 0);
}

console.log('\n-- saving hands the profile out and forgets it --');
{
  const store = new DefinitionStore();
  store.add('Beatline/Beamer', projector);
  const taken = store.remove('Beatline/Beamer');
  check('the profile is handed back', taken.name, 'Beamer');
  check('and is gone from the show', store.has('Beatline/Beamer'), false);
  check('removing again gives nothing', store.remove('Beatline/Beamer'), null);
}

console.log('\n-- what the Add-to-Show list sees --');
{
  const store = new DefinitionStore();
  check('no folder when there is nothing to show', store.list().length, 0);
  store.add('Beatline/Bar 60', bar);
  store.add('Acme/Beamer', projector);
  const [folder] = store.list();
  check('one folder', store.list().length, 1);
  check('called This show', folder.name, 'This show');
  check('flagged as the app\'s own', folder.generated && folder.local, true);
  check('two entries', folder.fixtures.length, 2);
  const entry = folder.fixtures.find((f) => f.file === 'Beamer');
  check('an entry carries its manufacturer', entry.manufacturer, 'Acme');
  check('and reads as manufacturer plus model', entry.name, 'Acme Beamer');
  check('and is placeable', entry.supported, true);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
