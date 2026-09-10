/* eslint-disable no-console */
/**
 * Fixed, Adjustable or DMX -- the one way every generic fixture is defined.
 *
 * The engine was built for the laser and this is what pins it down for the
 * others: a projector and a display now declare their parameters the same way,
 * so the interesting cases are the ones that are *not* the laser's -- a
 * parameter whose range comes from the machine (zoom, between this lens's throw
 * ratios), one that is not a number at all (a shutter, a source), and the
 * profiles made before any of this existed, which must keep their patch.
 *
 * Usage:
 *   npm test
 */
import {
  ControlSet,
  DeviceControl,
  ControlDef,
  PercentType,
  SwitchType,
  blankRecords,
  controlSetFromRecords,
} from '@/models/DMX/device_control';
import ProjectorSettings from '@/models/DMX/projector_settings';
import DisplaySettings from '@/models/DMX/display_settings';
import {
  DEFAULT_PROJECTOR_PARAMS,
  CONTROL_DEFS as PROJECTOR_DEFS,
  buildProjectorProfile,
} from '@/models/DMX/generic/projector';
import {
  DEFAULT_DISPLAY_PARAMS,
  CONTROL_DEFS as DISPLAY_DEFS,
} from '@/models/DMX/generic/display';

let failures = 0;

function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

/** A projector defined the way the create dialog now defines one. */
function projectorWith(controls) {
  return { ...DEFAULT_PROJECTOR_PARAMS, controls };
}

console.log('\n-- a parameter knows its own mode --');
{
  const params = projectorWith({
    dimmer: { mode: 'dmx', channel: 1, bits: 8 },
    zoom: { mode: 'fixed', value: 1.9 },
    shutter: { mode: 'adjustable', value: true },
  });
  const settings = new ProjectorSettings(params);

  check('a driven parameter is driven', settings.isDriven('dimmer'), true);
  check('and is not fixed', settings.isFixed('dimmer'), false);
  check('a fixed one is fixed', settings.isFixed('zoom'), true);
  check('and is not driven', settings.isDriven('zoom'), false);
  check('anything unstated is adjustable', settings.mode('shiftH'), 'adjustable');
  check('a fixed value comes from the profile', settings.value('zoom'), 1.9);
}

console.log('\n-- fixed values live in the profile, not the show --');
{
  const params = projectorWith({
    zoom: { mode: 'fixed', value: 2.1 },
    dimmer: { mode: 'adjustable', value: 80 },
  });
  const settings = new ProjectorSettings(params);

  settings.set('zoom', 1.2);
  check('a fixed value refuses to be set', settings.value('zoom'), 2.1);
  settings.set('dimmer', 40);
  check('an adjustable one takes', settings.value('dimmer'), 40);

  const travelling = settings.showData;
  check('the fixed one does not travel', 'zoom' in travelling, false);
  check('the adjustable one does', travelling.dimmer, 40);
}

console.log('\n-- the range of a parameter comes from the machine --');
{
  // A zoom runs between this lens's throw ratios, so the same DMX byte means
  // different things on two projectors -- which is the whole reason the type
  // asks the profile rather than carrying constants.
  const wide = new ProjectorSettings(projectorWith({
    zoom: { mode: 'dmx', channel: 1, bits: 8 },
  }));
  wide.writeChannel(0, 0);
  check('level 0 is the narrow end, the long ratio', wide.value('zoom'), DEFAULT_PROJECTOR_PARAMS.throwMax);
  wide.writeChannel(0, 255);
  check('and full scale is the wide end', wide.value('zoom'), DEFAULT_PROJECTOR_PARAMS.throwMin);

  const prime = new ProjectorSettings({
    ...DEFAULT_PROJECTOR_PARAMS,
    throwMin: 1.8,
    throwMax: 1.8,
    controls: { zoom: { mode: 'adjustable' } },
  });
  prime.set('zoom', 3);
  check('a prime lens clamps to its one ratio', prime.value('zoom'), 1.8);
}

console.log('\n-- a shutter is not a small number --');
{
  const settings = new DisplaySettings({
    ...DEFAULT_DISPLAY_PARAMS,
    controls: { shutter: { mode: 'dmx', channel: 1, bits: 8 } },
  });
  settings.writeChannel(0, 0);
  check('nothing is closed', settings.value('shutter'), false);
  settings.writeChannel(0, 200);
  check('past half is open', settings.value('shutter'), true);
  check('and it really is a boolean', typeof settings.value('shutter'), 'boolean');

  const blank = DISPLAY_DEFS.find((def) => def.key === 'shutter');
  check('the display calls its blade Blank', blank.label, 'Blank');
  check('and offers a checkbox for it', blank.type.editor, 'switch');
  const source = DISPLAY_DEFS.find((def) => def.key === 'source');
  check('a source offers a list', source.type.editor, 'choice');
  check('of connectors', source.type.source, 'connectors');
}

console.log('\n-- multi-byte parameters, coarse first --');
{
  const settings = new ProjectorSettings(projectorWith({
    dimmer: { mode: 'dmx', channel: 1, bits: 16 },
    shutter: { mode: 'dmx', channel: 3, bits: 8 },
  }));
  check('16 bits plus 8 is three channels', settings.footprint, 3);

  settings.writeChannel(0, 255);
  settings.writeChannel(1, 255);
  check('full scale is full', settings.value('dimmer'), 100);
  settings.writeChannel(0, 128);
  settings.writeChannel(1, 0);
  check('the coarse byte leads', Math.round(settings.value('dimmer')), 50);
  // The fine byte moves the value by a 256th of what the coarse one does; a
  // 16-bit dimmer that stepped in 256s would be an 8-bit one with extra work.
  settings.writeChannel(1, 255);
  check('and the fine byte is fine', settings.value('dimmer') > 50, true);
  check('but only just', settings.value('dimmer') < 50.5, true);
}

console.log('\n-- gaps are real channels, so the ones after them keep their numbers --');
{
  const { modes, footprint } = ControlSet.fromProfile(PROJECTOR_DEFS, projectorWith({
    dimmer: { mode: 'dmx', channel: 1, bits: 8 },
    zoom: { mode: 'dmx', channel: 4, bits: 8 },
  })).buildChannels();
  const { channels } = modes[0];

  check('the footprint reaches the furthest byte', footprint, 4);
  check('the first is the dimmer', channels[0], 'Dimmer');
  check('the hole is filled', channels[1], 'Reserved 2');
  check('and again', channels[2], 'Reserved 3');
  check('so zoom keeps channel 4', channels[3], 'Zoom');
}

console.log('\n-- the capability a channel declares --');
{
  const profile = buildProjectorProfile({
    controls: {
      dimmer: { mode: 'dmx', channel: 1, bits: 8 },
      shutter: { mode: 'dmx', channel: 2, bits: 8 },
      zoom: { mode: 'dmx', channel: 3, bits: 8 },
      shiftH: { mode: 'dmx', channel: 4, bits: 8 },
    },
  });
  const type = (name) => profile.availableChannels[name].capability.type;

  check('a dimmer is an intensity', type('Dimmer'), 'Intensity');
  check('a shutter is a shutter', type('Shutter'), 'ShutterStrobe');
  check('zoom carries the angles it spans', typeof profile.availableChannels.Zoom.capability.angleStart, 'string');
  check('lens shift is the nearest true thing', type('Lens Shift H'), 'BeamPosition');
}

console.log('\n-- a profile made before any of this keeps its patch --');
{
  // The tick-list meant DMX, 8-bit, numbered in the kind's own order.
  const legacy = new ProjectorSettings({
    ...DEFAULT_PROJECTOR_PARAMS,
    channels: ['dimmer', 'zoom'],
  });
  check('both ticked parameters are driven', legacy.channels.length, 2);
  check('and numbered in the kind order', legacy.footprint, 2);
  check('dimmer leads', legacy.isDriven('dimmer'), true);
  check('an unticked one is yours to set', legacy.isDriven('shiftH'), false);

  legacy.writeChannel(0, 255);
  check('and the wire still lands', legacy.value('dimmer'), 100);

  // The commonest projector there is: no DMX socket at all.
  const none = new ProjectorSettings({ ...DEFAULT_PROJECTOR_PARAMS, channels: [] });
  check('no channels means no footprint', none.footprint, 0);
  check('and everything is yours to set', none.isDriven('dimmer'), false);
}

console.log('\n-- what the form hands back --');
{
  const records = blankRecords(PROJECTOR_DEFS, DEFAULT_PROJECTOR_PARAMS);
  check('a row per addressable parameter', Object.keys(records).length, PROJECTOR_DEFS.length);
  check('everything starts adjustable', records.dimmer.modeIndex, 1);
  check('at the type default', records.dimmer.value, 100);
  check('channels numbered in order', records.shutter.channel, 2);

  // Switching to DMX must land past everything already addressed.
  records.dimmer.modeIndex = 2;
  records.dimmer.bitsIndex = 1;
  const set = controlSetFromRecords(PROJECTOR_DEFS, records, DEFAULT_PROJECTOR_PARAMS);
  check('a 16-bit dimmer takes two bytes', set.footprint, 2);
  check('so the next free channel is 3', set.nextFreeChannel('zoom'), 3);

  const block = set.toJSON();
  check('the block says how it is decided', block.dimmer.mode, 'dmx');
  check('and at what depth', block.dimmer.bits, 16);
  check('an untouched one is adjustable', block.zoom.mode, 'adjustable');
}

console.log('\n-- two parameters on one byte are reported, not silently merged --');
{
  const set = ControlSet.fromProfile(PROJECTOR_DEFS, projectorWith({
    dimmer: { mode: 'dmx', channel: 1, bits: 16 },
    shutter: { mode: 'dmx', channel: 2, bits: 8 },
  }));
  const clash = set.overlaps;
  check('one contested byte', clash.length, 1);
  check('at offset 1, the dimmer fine byte', clash[0].offset, 1);
  check('named for both claimants', clash[0].keys.join(','), 'dimmer,shutter');
}

console.log('\n-- a parameter that no console may drive --');
{
  // A projector's blend widths and a laser's protocol are stored and hand-set
  // like anything else, but they describe the install rather than the show.
  const def = new ControlDef('blendLeft', 'Blend Left', new PercentType({ max: 45 }), {
    addressable: false,
  });
  check('it says so', def.addressable, false);
  const control = new DeviceControl(def, { mode: 'dmx', channel: 1 }, {});
  check(
    'but asking for a channel does not make it addressable',
    ControlSet.fromProfile([def], {}).footprint,
    0,
  );
  check('and the record still holds a value', control.value, 0);

  const settings = new ProjectorSettings(projectorWith({}));
  settings.set('blendLeft', 90);
  check('a blend clamps at its own ceiling', settings.stored('blendLeft'), 45);
  check('and travels in the show', 'blendLeft' in settings.showData, true);
}

console.log('\n-- a switch that is off by default --');
{
  const def = new ControlDef('mirrorX', 'Mirror X', new SwitchType({
    initial: false, onLabel: 'Flipped',
  }));
  const control = new DeviceControl(def, {}, {});
  check('starts off', control.value, false);
  check('and names its on state', def.type.onLabel, 'Flipped');
}

console.log('\n-- a source cannot be baked into the profile --');
{
  // A profile describes a model of machine. Which connector one is watching is
  // not a property of the model -- every display of that model in the show
  // would otherwise be stuck on the same feed.
  const source = DISPLAY_DEFS.find((def) => def.key === 'source');
  check('a source is not fixable', source.fixable, false);
  check('so it offers two modes', source.modeChoices().length, 2);
  check('adjustable', source.modeChoices()[0].label, 'Adjustable');
  check('and DMX', source.modeChoices()[1].label, 'DMX');

  const dimmer = DISPLAY_DEFS.find((def) => def.key === 'dimmer');
  check('an ordinary parameter offers all three', dimmer.modeChoices().length, 3);
  check('starting with Fixed', dimmer.modeChoices()[0].label, 'Fixed');

  // A hand-edited profile, or one written before a parameter stopped being
  // fixable, must not get away with it either.
  const settings = new DisplaySettings({
    ...DEFAULT_DISPLAY_PARAMS,
    controls: { source: { mode: 'fixed', value: 'hdmi-1' } },
  });
  check('a fixed source falls back to adjustable', settings.mode('source'), 'adjustable');
  check('and its value still travels in the show', settings.showData.source, 'hdmi-1');
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
