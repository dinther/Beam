/* eslint-disable no-console */
/**
 * What an export asks the main process to collect.
 *
 * The show is the only side that knows which profiles and models it places,
 * so it names them by key and the main process finds the files. These pin
 * what is named: each profile once however many fixtures share it, the show's
 * own definitions left out because they already travel in the show, library
 * objects by key, and inline shapes not at all because they carry their own
 * parameters.
 *
 * Usage:
 *   npm test
 */
import Show from '@/models/DMX/show.model';
import { buildLedBarProfile, withoutLedBarChannels } from '@/models/DMX/generic/led_bar';

let failures = 0;

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(50)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

const fixture = (manufacturer, model) => ({ profileKey: `${manufacturer}/${model}` });
const placed = (model) => ({ model, isInline: false });
const inline = () => ({ model: undefined, isInline: true, primitive: { type: 'cube' } });

const show = {
  fixturePool: {
    fixtures: [
      fixture('martin', 'mac-aura'),
      fixture('martin', 'mac-aura'),
      fixture('Beatline', '60 LED Bar GRB'),
      fixture('This show', 'Display 1920x1080'),
    ],
  },
  definitions: { has: (key) => key === 'This show/Display 1920x1080' },
  objects: [placed('Truss'), placed('Rigging/Hoist'), placed('Truss'), inline()],
};

const wanted = Show.prototype.referencedResources.call(show);

console.log('\nprofiles: once per key, without the show\'s own definitions');
check('profiles', wanted.profiles, ['martin/mac-aura', 'Beatline/60 LED Bar GRB']);

console.log('\nobjects: library keys once each, inline shapes left out');
check('objects', wanted.objects, ['Truss', 'Rigging/Hoist']);

console.log('\nan empty show names nothing');
check('empty', Show.prototype.referencedResources.call({
  fixturePool: { fixtures: [] }, definitions: { has: () => false }, objects: [],
}), { profiles: [], objects: [] });

// The read side: what an opened export carries resolves after the show's own
// definitions and ahead of the library, and is offered for placing only when
// this machine has it nowhere else.
const resolver = {
  definitions: { get: (key) => (key === 'x/def' ? { from: 'definition' } : null) },
  collected: {
    profiles: {
      'x/def': { from: 'collected' },
      'x/carried': { from: 'collected' },
      'x/lib': { from: 'collected' },
      'martin/mac-aura': { from: 'collected' },
    },
    overrides: {},
  },
  generatedProfiles: { 'x/lib': { from: 'library' }, 'x/only-lib': { from: 'library' } },
  rawOFLFixtures: [
    { name: 'martin', fixtures: [{ file: 'mac-aura.json' }] },
    { name: 'x', generated: true, fixtures: [{ file: 'lib' }] },
  ],
};

console.log('\nresolution order: definition, then carried, then library');
check('definition wins', Show.prototype.localProfile.call(resolver, 'x/def').from, 'definition');
check('carried beats library', Show.prototype.localProfile.call(resolver, 'x/lib').from, 'collected');
check('carried alone', Show.prototype.localProfile.call(resolver, 'x/carried').from, 'collected');
check('library alone', Show.prototype.localProfile.call(resolver, 'x/only-lib').from, 'library');
check('unknown', Show.prototype.localProfile.call(resolver, 'x/none'), null);

console.log('\nlisted for placing: carried profiles this machine has nowhere else');
check('collected only', Object.keys(Show.prototype.collectedOnlyProfiles.call(resolver)), ['x/def', 'x/carried']);

console.log('\nmounting: bars are expanded, nothing carried is nothing, no document unmounts');
const calls = [];
window.documentStore = {
  mount: async (target) => {
    calls.push(`mount ${target}`);
    return {
      // As the library stores a bar: parameters only, channels stripped.
      profiles: { 'Beatline/Bar': withoutLedBarChannels(buildLedBarProfile()) },
      overrides: { 'a/b': { physical: { power: 1 } } },
    };
  },
  unmount: async () => { calls.push('unmount'); },
};
const host = { collected: null };
Show.prototype.mountDocument.call(host, 'C:/x.beam')
  .then(() => {
    check('mount called', calls, ['mount C:/x.beam']);
    check('override carried', host.collected.overrides['a/b'].physical.power, 1);
    check('profile carried', typeof host.collected.profiles['Beatline/Bar'].name, 'string');
    check('bar channels rebuilt', Object.keys(host.collected.profiles['Beatline/Bar'].availableChannels).length > 0, true);
    return Show.prototype.mountDocument.call(host, null);
  })
  .then(() => {
    check('unmount called', calls, ['mount C:/x.beam', 'unmount']);
    check('nothing carried', host.collected, { profiles: {}, overrides: {} });
    console.log(failures ? `\n${failures} FAILED` : '\nall passed');
    process.exit(failures ? 1 : 0);
  });
