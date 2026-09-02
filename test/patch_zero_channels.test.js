/* eslint-disable no-console */
/**
 * A fixture that occupies no DMX channels at all.
 *
 * Most projectors have no DMX socket, and one is still worth placing: it shows
 * where the image lands. So a channel count of nought is a legitimate state,
 * not a broken one -- and every layer that assumed otherwise refused it in a
 * way that read as something else entirely.
 *
 * Two failures this pins, both real:
 *
 * - The patch dialog asked `canPatch(address, 0)`, got a truthful "no" to the
 *   wrong question, and reported *"those channels are already taken"* about a
 *   fixture that wanted none.
 * - Worse, `PatchMap.patchFixture` threw. `Show.patchFixtures` walks every
 *   fixture with no guard on load, so one no-DMX projector in a saved show
 *   would have taken the whole rig down with it on open.
 *
 * Usage:
 *   npm test
 */
import { PatchMap } from '@/models/DMX/patch.model';

let failures = 0;

function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

/**
 * The least a fixture can be and still be patched.
 *
 * Not a `Fixture`: building one drags in the profile parser, the renderer and
 * Vue, and the patch map only ever asks for these four things.
 */
function fixtureOf(channelCount, address = 0) {
  return {
    id: `f${address}`,
    address,
    channels: { length: channelCount },
    alignmentPixelSize: 1,
    takesChannelRange: false,
  };
}

console.log('\n-- a fixture with no channels claims nothing --');
{
  const patch = new PatchMap();
  const bare = fixtureOf(0, 0);

  let threw = null;
  try {
    patch.patchFixture(bare);
  } catch (err) {
    threw = err.message;
  }
  check('patching one does not throw', threw, null);
  check('and it is not recorded as patched', patch.isPatched(bare), false);
  check('so it occupies no address', patch.fixtureAt(0), null);
}

console.log('\n-- and it is not in anyone else\'s way --');
{
  // The point of the no-op: a projector with no DMX must not reserve address 0
  // and lock out the fixture that genuinely wants it.
  const patch = new PatchMap();
  patch.patchFixture(fixtureOf(0, 0));
  const real = fixtureOf(12, 0);

  let threw = null;
  try {
    patch.patchFixture(real);
  } catch (err) {
    threw = err.message;
  }
  check('a real fixture still takes address 0', threw, null);
  check('and is patched there', patch.isPatched(real), true);
  check('answering for its own channels', patch.fixtureAt(5), real);
}

console.log('\n-- a whole show loads past one --');
{
  // `Show.patchFixtures` is an unguarded forEach. One throw part way through
  // leaves every fixture after it unpatched, which is how a single projector
  // could have emptied a rig on open.
  const patch = new PatchMap();
  const show = [fixtureOf(6, 0), fixtureOf(0, 0), fixtureOf(6, 6), fixtureOf(0, 0), fixtureOf(3, 12)];
  let threw = null;
  try {
    show.forEach((f) => patch.patchFixture(f));
  } catch (err) {
    threw = err.message;
  }
  check('every fixture is offered without throwing', threw, null);
  check('the first real one is patched', patch.isPatched(show[0]), true);
  check('and so is the last, past two empties', patch.isPatched(show[4]), true);
  check('the empties are not', patch.isPatched(show[1]), false);
}

console.log('\n-- the questions the dialog asks --');
{
  const patch = new PatchMap();
  // Both of these are *correct* answers to the question asked; the dialog's
  // mistake was asking them at all about a fixture wanting no channels. Pinned
  // so that a later "fix" here does not quietly change what they mean.
  check('canPatch refuses a run of nought', patch.canPatch(0, 0), false);
  check('findFreeAddress has nowhere to put nothing', patch.findFreeAddress(0, 1), -1);
  check('but a real run is still found', patch.findFreeAddress(6, 1), 0);
}

console.log('\n-- unpatching one is safe too --');
{
  const patch = new PatchMap();
  const bare = fixtureOf(0, 0);
  let threw = null;
  try {
    patch.unpatchFixture(bare);
  } catch (err) {
    threw = err.message;
  }
  check('unpatching something never patched', threw, null);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
