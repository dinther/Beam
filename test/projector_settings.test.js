/* eslint-disable no-console */
/**
 * What one projector is set to, and who decides it.
 *
 * The rule under test: every attribute has a stored value, and a channel the
 * profile declares takes it over. Most projectors have no DMX at all, plenty
 * have a shutter and a dimmer and nothing else, and one panel has to serve all
 * of them without changing shape.
 *
 * The conversions matter as much as the rule. A hand-set zoom and a Zoom
 * channel have to mean the same thing in the same units, or patching a
 * projector silently changes what it is doing -- which is exactly the class of
 * error nobody sees until an image lands on the wrong wall.
 *
 * Usage:
 *   npm test
 */
import ProjectorSettings from '@/models/DMX/projector_settings';
import { DEFAULT_PROJECTOR_PARAMS, PROJECTOR_CHANNELS } from '@/models/DMX/generic/projector';

let failures = 0;

function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

function near(label, got, want, tolerance = 1e-6) {
  const ok = Math.abs(got - want) <= tolerance;
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)} `
    + `got ${Number(got).toFixed(4)}  want ${Number(want).toFixed(4)}`,
  );
}

/** A projector with no DMX at all, which is the commonest kind. */
const bare = { ...DEFAULT_PROJECTOR_PARAMS, channels: [] };
/**
 * And one with the three a projector with any DMX usually offers.
 *
 * Spelled out rather than taken from the defaults. It used to be
 * `{ ...DEFAULT_PROJECTOR_PARAMS }`, which tied every assertion below to a
 * product decision they have no opinion about -- and duly broke the day the
 * default became "no channels at all".
 */
const patched = {
  ...DEFAULT_PROJECTOR_PARAMS,
  channels: [
    PROJECTOR_CHANNELS.DIMMER,
    PROJECTOR_CHANNELS.SHUTTER,
    PROJECTOR_CHANNELS.SOURCE,
  ],
};

console.log('\n-- an unpatched projector is yours to set --');
{
  const s = new ProjectorSettings(bare);
  check('nothing is driven', s.channels.length, 0);
  check('so the dimmer is not', s.isDriven('dimmer'), false);
  check('parked at the wide end', s.value('zoom'), DEFAULT_PROJECTOR_PARAMS.throwMin);
  check('full and open by default', `${s.value('dimmer')},${s.value('shutter')}`, '100,true');

  s.set('zoom', 1.9);
  check('a hand-set zoom takes', s.value('zoom'), 1.9);
  s.set('dimmer', 40);
  check('and a hand-set dimmer', s.value('dimmer'), 40);
}

console.log('\n-- the envelope is enforced, not trusted --');
{
  const s = new ProjectorSettings(bare);
  s.set('zoom', 99);
  check('zoom clamps to the long end', s.value('zoom'), DEFAULT_PROJECTOR_PARAMS.throwMax);
  s.set('zoom', 0.1);
  check('and to the wide end', s.value('zoom'), DEFAULT_PROJECTOR_PARAMS.throwMin);
  s.set('shiftV', 999);
  check('shift clamps to the profile limit', s.value('shiftV'), DEFAULT_PROJECTOR_PARAMS.shiftLimitV);
  s.set('shiftV', -999);
  check('symmetrically', s.value('shiftV'), -DEFAULT_PROJECTOR_PARAMS.shiftLimitV);
  s.set('dimmer', 500);
  check('a dimmer is a percentage', s.value('dimmer'), 100);

  // A model whose optics do not shift at all must not accept a shift.
  const fixed = new ProjectorSettings({ ...bare, shiftLimitH: 0, shiftLimitV: 0 });
  fixed.set('shiftH', 30);
  check('no shift range means no shift', fixed.value('shiftH'), 0);

  const prime = new ProjectorSettings({ ...bare, throwMin: 1.5, throwMax: 1.5 });
  check('a prime lens does not zoom', prime.zooms, false);
  check('and a zoom lens does', new ProjectorSettings(bare).zooms, true);
}

console.log('\n-- a new projector declares nothing --');
{
  // Deliberate, and the reason is that a declared channel *owns* its row: a
  // projector that arrived claiming a Source Select handed the connector to a
  // console nobody had patched, and greyed out the one control it most needs.
  const fresh = new ProjectorSettings({ ...DEFAULT_PROJECTOR_PARAMS });
  check('no channels until they are ticked', fresh.channels.length, 0);
  check('so the source is not driven', fresh.isDriven('source'), false);
}

console.log('\n-- a declared channel owns its row --');
{
  const s = new ProjectorSettings(patched);
  check('three channels when the model has them', s.channels.length, 3);
  check('dimmer is driven', s.isDriven('dimmer'), true);
  check('shutter is driven', s.isDriven('shutter'), true);
  check('source is driven', s.isDriven('source'), true);
  // The point of the design: the ones without a channel stay editable, so the
  // commonest real projector -- a shutter, a dimmer, and a lens you turn by
  // hand -- is fully usable.
  check('zoom is not', s.isDriven('zoom'), false);
  check('nor is shift', s.isDriven('shiftH'), false);

  // Ownership is asked of the profile, not of whether a frame has landed. A
  // row that became editable whenever a console paused would be a race.
  check('driven before anything arrives', s.isDriven('dimmer'), true);
  check('but nothing is live yet', s.hasLive('dimmer'), false);
  check('so it shows its parked value', s.value('dimmer'), 100);
}

console.log('\n-- what the wire says --');
{
  const s = new ProjectorSettings(patched);
  const order = s.channels;
  check('addressed in the profile order', JSON.stringify(order),
    JSON.stringify([PROJECTOR_CHANNELS.DIMMER, PROJECTOR_CHANNELS.SHUTTER, PROJECTOR_CHANNELS.SOURCE]));

  s.writeChannel(0, 255);
  check('full dimmer', s.value('dimmer'), 100);
  s.writeChannel(0, 128);
  near('half dimmer', s.value('dimmer'), (128 / 255) * 100);
  check('and it is live now', s.hasLive('dimmer'), true);

  // A dowser is a blade, not a fader.
  s.writeChannel(1, 0);
  check('shutter closed at zero', s.value('shutter'), false);
  s.writeChannel(1, 200);
  check('and open past half', s.value('shutter'), true);

  // One-based, so Source Select = 1 is the first connector -- which is what
  // makes it read like a projector's own input menu.
  s.writeChannel(2, 1);
  check('source 1 is the first connector', s.value('source'), 1);
  s.writeChannel(2, 0);
  check('and zero is none', s.value('source'), null);

  check('an index past the end is ignored', (() => {
    s.writeChannel(9, 255);
    return s.value('dimmer');
  })(), s.value('dimmer'));
}

console.log('\n-- a live value is held, not cleared --');
{
  // A dropped frame must not snap the rig back to a parked default, and there
  // is no way to tell a stopped console from a slow one.
  const s = new ProjectorSettings(patched);
  s.writeChannel(0, 255);
  check('driven to full', s.value('dimmer'), 100);
  check('the parked value is untouched underneath', s.stored('dimmer'), 100);
  s.set('dimmer', 10);
  check('parking a value under DMX is allowed', s.stored('dimmer'), 10);
  check('but the wire still wins', s.value('dimmer'), 100);
}

console.log('\n-- zoom maps across the profile range, both ways --');
{
  // The channel and the field have to mean the same thing, or patching a
  // projector changes what it is doing without anyone touching it.
  const s = new ProjectorSettings(patched);
  const { throwMin, throwMax } = DEFAULT_PROJECTOR_PARAMS;
  const zoomy = new ProjectorSettings({
    ...patched,
    channels: [PROJECTOR_CHANNELS.ZOOM],
  });
  // DMX 0 is the narrowest angle, which is the *longest* throw ratio -- the
  // capability writes the narrow end as its start. Getting this backwards
  // inverts every projector's zoom.
  zoomy.writeChannel(0, 0);
  near('DMX 0 is the long end', zoomy.value('zoom'), throwMax);
  zoomy.writeChannel(0, 255);
  near('DMX full is the wide end', zoomy.value('zoom'), throwMin);
  zoomy.writeChannel(0, 128);
  near('and half way is half way', zoomy.value('zoom'),
    throwMax + (throwMin - throwMax) * (128 / 255));
  check('the field it overrides has the same range', s.range.max, throwMax);
}

console.log('\n-- shift is centred at half scale --');
{
  const s = new ProjectorSettings({ ...patched, channels: [PROJECTOR_CHANNELS.SHIFT_H] });
  s.writeChannel(0, 128);
  near('a console at 128 leaves the image alone', s.value('shiftH'),
    ((128 / 255) * 2 - 1) * DEFAULT_PROJECTOR_PARAMS.shiftLimitH, 0.2);
  s.writeChannel(0, 0);
  near('zero is fully one way', s.value('shiftH'), -DEFAULT_PROJECTOR_PARAMS.shiftLimitH);
  s.writeChannel(0, 255);
  near('full is fully the other', s.value('shiftH'), DEFAULT_PROJECTOR_PARAMS.shiftLimitH);
}

console.log('\n-- only parked values travel in the show --');
{
  const s = new ProjectorSettings(patched);
  s.set('zoom', 2.0);
  s.set('source', 7);
  s.writeChannel(0, 255);
  const data = s.showData;
  check('the stored zoom is written', data.zoom, 2.0);
  check('and the stored source', data.source, 7);
  // What DMX happens to be saying on one machine at one moment is not show
  // data -- the same line the app already draws between an address and a frame.
  check('the parked dimmer, not the live one', data.dimmer, 100);

  const reloaded = new ProjectorSettings(patched, data);
  check('a reload restores the zoom', reloaded.value('zoom'), 2.0);
  check('and the source', reloaded.value('source'), 7);
  check('with nothing live', reloaded.hasLive('dimmer'), false);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
