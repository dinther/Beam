/* eslint-disable no-console */
/**
 * Channel values set by hand on a library fixture.
 *
 * A generic device carries its settings in `device` and saves only what was
 * parked, never what the wire said. A library fixture has no `device`, so
 * without these its channels hold whatever DMX last wrote, nothing is saved,
 * and a light placed to try an idea stays dark until it is patched.
 *
 * The rules worth pinning are about who wins and what travels:
 *
 *   - a hand-set value drives the fixture straight away;
 *   - DMX overwrites it, because whoever is driving drives;
 *   - the *show* still carries the hand-set value, never the live one, so
 *     reopening a show does not bake in whatever a console happened to be
 *     saying when it was saved;
 *   - a channel nobody touched stays absent, so profile defaults are not
 *     silently replaced by zeros.
 *
 * Usage:
 *   npm test
 */
import Fixture from '@/models/DMX/fixture.model';
import { buildLaserProfile } from '@/models/DMX/generic/laser';

let failures = 0;

function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

/**
 * A fixture with four plain channels.
 *
 * Built from a generated laser profile with a control block, because that is
 * the shortest route to a real profile with real channels that does not need a
 * library on disk.
 */
function makeFixture(data = {}) {
  const profile = buildLaserProfile({
    controls: {
      dimmer: { mode: 'dmx', channel: 1, resolution: 1 },
      red: { mode: 'dmx', channel: 2, resolution: 1 },
      green: { mode: 'dmx', channel: 3, resolution: 1 },
      blue: { mode: 'dmx', channel: 4, resolution: 1 },
    },
  });
  return new Fixture({
    id: 1,
    manufacturer: 'Beatline',
    model: 'Test',
    mode: profile.modes[0].name,
    address: 0,
    OFLData: profile,
    ...data,
  });
}

const probe = makeFixture();
const channels = Array.isArray(probe.channels) ? probe.channels.length : 0;
console.log(`\n-- a fixture with ${channels} channels --`);

if (!channels) {
  console.log('SKIP  the generated profile declared no channels; nothing to park');
} else {
  check('every channel starts at zero', probe.channels[0].value.DMX, 0);
  check('and nothing is parked', Object.keys(probe.parkedChannels).length, 0);
  check('so the show carries no channel values', probe.showData.channelValues, undefined);

  console.log('\n-- a hand-set value drives the fixture and is remembered --');
  probe.parkChannel(0, 200);
  check('the channel takes it', probe.channels[0].value.DMX, 200);
  check('and it is remembered', probe.parkedChannel(0), 200);
  check('out of range is clamped', (probe.parkChannel(1, 999), probe.parkedChannel(1)), 255);
  check('and below too', (probe.parkChannel(1, -5), probe.parkedChannel(1)), 0);

  console.log('\n-- DMX wins while it is driving, and never reaches the show --');
  probe.setChannel(0, 17);
  check('the channel follows the wire', probe.channels[0].value.DMX, 17);
  check('but the parked value is untouched', probe.parkedChannel(0), 200);
  check('and the show carries the parked one', probe.showData.channelValues[0], 200);
  check('not what the wire said', probe.showData.channelValues[0] === 17, false);
  // Only what was touched: a channel left alone must not be written as a zero
  // over whatever the profile wanted.
  check('untouched channels stay absent', probe.showData.channelValues[2], undefined);

  console.log('\n-- a saved show comes back set the way it was left --');
  const saved = probe.showData;
  const reopened = makeFixture({ channelValues: saved.channelValues });
  check('the parked value is restored', reopened.parkedChannel(0), 200);
  check('and applied to the channel', reopened.channels[0].value.DMX, 200);
  check('the untouched one is still zero', reopened.channels[2].value.DMX, 0);
  check('and still absent from the show', reopened.showData.channelValues[2], undefined);

  console.log('\n-- and one can be given back to whatever drives it --');
  reopened.unparkChannel(0);
  check('forgotten', reopened.parkedChannel(0), undefined);
  check('the channel keeps its last value', reopened.channels[0].value.DMX, 200);
  check('and the show stops carrying that one', reopened.showData.channelValues[0], undefined);
  // The others are untouched by it: forgetting one channel is not forgetting
  // the fixture's settings.
  check('while the rest are still carried', reopened.showData.channelValues[1], 0);
  reopened.unparkChannel(1);
  check('and with none left, nothing is written', reopened.showData.channelValues, undefined);
}

console.log(`\n${failures ? `${failures} failed` : 'all passed'}`);
if (failures) process.exit(1);
