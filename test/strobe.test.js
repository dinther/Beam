/* eslint-disable no-console */
/**
 * The strobe profile and its settings.
 *
 * Two headless pieces of the strobe fixture: `generic/strobe.js` builds an
 * OFL-shaped profile the fixture parser can read, and `strobe_settings.js`
 * answers what one placed strobe is doing. Both are checked here against the
 * real modules, with numbers worked by hand.
 *
 * Usage:
 *   npm test
 */
import {
  buildStrobeProfile, isStrobeProfile, DEFAULT_STROBE_PARAMS, STROBE_COLOURS, STROBE_SOURCES,
  controlDefsFor, lampColour, floodSolidAngle, lumens, candela, illuminanceAt, faceOrigin,
  faceSize, rateRange, durationRange, CHANNEL_ORDER, isXenon, flashLumenSeconds,
  colourOf, defaultColourFor, lampSplit,
} from '@/models/DMX/generic/strobe';
import { DEFAULT_GELS } from '@/models/DMX/generic/gel_string';
import StrobeSettings from '@/models/DMX/strobe_settings';
import { SHUTTER_MODES, SHUTTER_MODE_ORDER } from '@/plugins/visualizer/shutter';
import { whitePoint } from '@/models/DMX/colour_temperature';

let failures = 0;

function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

function near(label, got, want, tol = 1e-6) {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)} got ${got}  want ~${want} (±${tol})`);
}

console.log('--- the profile');
{
  const profile = buildStrobeProfile();
  check('is recognised as a strobe', isStrobeProfile(profile), true);
  check('a projector-less object is not', isStrobeProfile({ asls: {} }), false);
  check('category is OFL Strobe', profile.categories[0], 'Strobe');
  check('name carries the power', profile.name, 'Strobe 1500W');
  check('dimensions are mm, width first', profile.physical.dimensions[0], 360);
  check('bulb is LED by default', profile.physical.bulb.type, 'LED');
  check('bulb carries the colour temperature', profile.physical.bulb.colorTemperature, 6500);
  check('all adjustable by default: no channels', profile.modes[0].channels.length, 0);
  check('parameters travel under asls.strobe', profile.asls.strobe.power, 1500);
  const xenon = buildStrobeProfile({ source: STROBE_SOURCES.XENON });
  check('a xenon unit says so', xenon.physical.bulb.type, 'Xenon flash tube');
}

console.log('--- channel layout follows the declared order');
{
  const controls = {};
  CHANNEL_ORDER.forEach((key, i) => { controls[key] = { mode: 'dmx', channel: i + 1, bits: 8 }; });
  const profile = buildStrobeProfile({ controls });
  const { channels } = profile.modes[0];
  check('every control on a channel: nine of them', channels.length, 9);
  check('dimmer first', channels[0], 'Dimmer');
  check('strobe mode second', channels[1], 'Strobe Mode');
  check('rate third', channels[2], 'Rate');
  check('duration fourth', channels[3], 'Duration');
  check('colour fifth to seventh', channels.slice(4, 7).join(','), 'Red,Green,Blue');
  check('blinder eighth', channels[7], 'Blinder');
  check('flash last', channels[8], 'Flash');

  const mode = profile.availableChannels['Strobe Mode'];
  check('mode channel declares one range per mode', (mode.capabilities || []).length, SHUTTER_MODE_ORDER.length);
  const ranges = (mode.capabilities || []).map((c) => c.dmxRange);
  check('ranges start at 0', ranges[0] && ranges[0][0], 0);
  check('ranges end at 255', ranges.length ? ranges[ranges.length - 1][1] : null, 255);
  let contiguous = true;
  for (let i = 1; i < ranges.length; i += 1) {
    if (ranges[i][0] !== ranges[i - 1][1] + 1) contiguous = false;
  }
  check('ranges are contiguous', contiguous, true);
  const random = (mode.capabilities || []).find((c) => c.randomTiming);
  check('random mode is a Strobe with random timing', random && random.shutterEffect, 'Strobe');
  check('rate channel spans the profile in hertz', profile.availableChannels.Rate.capability.speedEnd, '25Hz');
  check('duration channel spans the profile in ms', profile.availableChannels.Duration.capability.durationEnd, '500ms');
  check('dimmer is an Intensity', profile.availableChannels.Dimmer.capability.type, 'Intensity');
  check('red is a ColorIntensity', profile.availableChannels.Red.capability.color, 'Red');
}

console.log('--- a white unit has no colour channels');
{
  const controls = {};
  CHANNEL_ORDER.forEach((key, i) => { controls[key] = { mode: 'dmx', channel: i + 1, bits: 8 }; });
  const white = buildStrobeProfile({ colour: STROBE_COLOURS.WHITE, controls });
  const { channels } = white.modes[0];
  check('colour controls are dropped from the definition', controlDefsFor({ colour: 'white' }).length, 6);
  check('no Red channel', channels.includes('Red'), false);
  // The colour channels were numbered 5-7 and are gone, leaving a gap the
  // blinder and flash keep their numbers across.
  check('blinder keeps its channel', channels[7], 'Blinder');
  check('gap is a reserved channel', channels[4], 'Reserved 5');
}

console.log('--- a flash tube is white, or white through a gel');
{
  check('xenon with RGB reads as white', colourOf({ source: 'xenon', colour: 'rgb' }), 'white');
  check('xenon with a scroller is a scroller', colourOf({ source: 'xenon', colour: 'scroller' }), 'scroller');
  check('LED with a scroller reads as white', colourOf({ source: 'led', colour: 'scroller' }), 'white');
  check('LED with RGB mixes', colourOf({ source: 'led', colour: 'rgb' }), 'rgb');
  check('a new tube starts white', defaultColourFor('xenon'), 'white');
  check('a new array starts RGB', defaultColourFor('led'), 'rgb');

  const controls = {};
  CHANNEL_ORDER.forEach((key, i) => { controls[key] = { mode: 'dmx', channel: i + 1, bits: 8 }; });
  controls.gel = { mode: 'dmx', channel: 5, bits: 8 };
  const scroller = buildStrobeProfile({ source: 'xenon', colour: 'scroller', controls });
  const { channels } = scroller.modes[0];
  check('scroller: no RGB channels', channels.includes('Red'), false);
  check('scroller: a Colour Scroller channel where the colour sat', channels[4], 'Colour Scroller');
  const gel = scroller.availableChannels['Colour Scroller'];
  // A range per frame and a two-colour range for each split between frames.
  check('gel channel declares frames and the splits between', (gel.capabilities || []).length, DEFAULT_GELS.length * 2 - 1);
  check('gel frames are colour presets', gel.capabilities[2].type, 'ColorPreset');
  check('gel frames carry the swatch', gel.capabilities[2].colors[0], DEFAULT_GELS[1].colour);
  check('a split carries both swatches', gel.capabilities[1].colors.length, 2);
  check('the string is stored in the profile', scroller.asls.strobe.gels.length, DEFAULT_GELS.length);

  const params = { source: 'xenon', colour: 'scroller', colorTemperature: 6500 };
  const open = lampColour(params, { gel: 1 });
  near('frame 1 is the open frame, the lamp white', open[0], whitePoint(6500)[0]);
  const red = lampColour(params, { gel: 2 });
  check('frame 2, red, takes the blue out', red[2] < 0.05, true);
  check('frame 2 keeps the red', red[0] > 0.7, true);
  const split = lampSplit(params, { gel: 2.5 });
  near('half way is half the next gel in', split.fraction, 0.5);
  check('the split keeps both colours apart: first is red', split.first[2] < 0.05, true);
  check('the split keeps both colours apart: second is orange', split.second[1] > split.first[1], true);
  const room = lampColour(params, { gel: 2.5 });
  near('the room gets the two added in proportion', room[1], (split.first[1] + split.second[1]) / 2);

  const settings = new StrobeSettings(scroller.asls.strobe);
  check('settings know it is a scroller', settings.usesScroller, true);
  check('settings do not mix', settings.mixesColour, false);
  check('gel parks on frame 1', settings.gelPosition, 1);
  check('and says so', settings.gelName, 'Open');
  settings.writeChannel(4, 255);
  check('gel at 255 is the last frame', settings.gelPosition, DEFAULT_GELS.length);
  check('the lamp follows the gel', settings.lamp[2] < 1, true);
  // A hand-set position, on a unit no console has written to: a live value,
  // once arrived, is held over the parked one.
  const byHand = new StrobeSettings(scroller.asls.strobe);
  byHand.set('gel', 2.5);
  check('a half position names both gels', byHand.gelName, 'Red / Orange');
  byHand.set('gel', 40);
  check('a position past the string is held at its end', byHand.gelPosition, DEFAULT_GELS.length);
}

console.log('--- the lamp');
{
  const white = whitePoint(6500);
  const rgb = lampColour(DEFAULT_STROBE_PARAMS, { red: 100, green: 100, blue: 100 });
  near('RGB at full is the lamp white: red', rgb[0], white[0]);
  near('RGB at full is the lamp white: blue', rgb[2], white[2]);
  const red = lampColour(DEFAULT_STROBE_PARAMS, { red: 100, green: 0, blue: 0 });
  check('red only: green is out', red[1], 0);
  const whiteUnit = lampColour({ colour: 'white', colorTemperature: 3200 }, { red: 0, green: 0, blue: 0 });
  check('a white unit ignores colour levels', whiteUnit[0], 1);
  check('a warm white is red-led', whiteUnit[2] < whiteUnit[0], true);
}

console.log('--- the flood');
{
  const params = DEFAULT_STROBE_PARAMS;
  // 4 asin(sin 55° sin 55°)
  const sin55 = Math.sin((55 * Math.PI) / 180);
  near('solid angle of a 110 by 110 flood', floodSolidAngle(params), 4 * Math.asin(sin55 * sin55), 1e-9);
  near('hemisphere at 180 by 180', floodSolidAngle({ floodAngleH: 180, floodAngleV: 180 }), 2 * Math.PI, 1e-3);
  check('1500 W of LED is 150000 lm', lumens(params), 150000);
  const xenon = { ...params, source: 'xenon' };
  check('1500 W of xenon averages less', lumens(xenon) < lumens(params), true);
  check('an LED array is not a tube', isXenon(params), false);
  check('a tube is', isXenon(xenon), true);
  // 60000 lm a second, shared out over the flashes.
  near('a flash at 10 Hz carries a tenth of a second', flashLumenSeconds(xenon, 10), 6000);
  near('a flash at 1 Hz carries a whole second', flashLumenSeconds(xenon, 1), 60000);
  near('below the slowest rate the capacitor is full', flashLumenSeconds(xenon, 0.2), 60000);
  near('with no rate, likewise', flashLumenSeconds(xenon, 0), 60000);
  near('candela is lumens over the flood', candela(params), 150000 / floodSolidAngle(params), 1e-6);
  near('lux at 5 m is candela over 25', illuminanceAt(5, params), candela(params) / 25, 1e-6);
  check('lux at no distance is nothing', illuminanceAt(0, params), 0);
  check('rate range sorts itself', rateRange({ rateMin: 25, rateMax: 1 }).min, 1);
  check('duration range sorts itself', durationRange({ durationMin: 500, durationMax: 1 }).max, 500);
  near('face sits on the front panel', faceOrigin(params).y, -0.07);
  check('face is kept inside the panel', faceSize({ ...params, faceWidth: 5 }).width, params.width);
}

console.log('--- settings');
{
  const profile = buildStrobeProfile();
  const settings = new StrobeSettings(profile.asls.strobe);
  check('mode parks on strobe', settings.shutterMode, SHUTTER_MODES.STROBE);
  check('rate parks at the slowest', settings.rate, 1);
  check('duration parks at the shortest', settings.duration, 1);
  check('dimmer parks at full', settings.gain, 1);
  check('flash is not held', settings.flashHeld, false);
  check('mixes colour', settings.mixesColour, true);
  settings.set('blinder', true);
  check('blinder holds the lamp on', settings.shutterMode, SHUTTER_MODES.ON);
  settings.set('blinder', false);
  settings.set('mode', SHUTTER_MODES.LIGHTNING);
  check('mode is set by hand', settings.shutterMode, SHUTTER_MODES.LIGHTNING);
  settings.set('mode', 'nonsense');
  check('a mode the lamp has not got falls back', settings.shutterMode, SHUTTER_MODES.STROBE);
  settings.set('rate', 40);
  check('rate is kept inside the profile', settings.rate, 25);
  settings.set('red', 0);
  check('the lamp follows the colour levels', settings.lamp[0], 0);
}

console.log('--- settings driven over DMX');
{
  const controls = {};
  CHANNEL_ORDER.forEach((key, i) => { controls[key] = { mode: 'dmx', channel: i + 1, bits: 8 }; });
  const profile = buildStrobeProfile({ controls });
  const settings = new StrobeSettings(profile.asls.strobe);
  check('footprint is nine', settings.footprint, 9);
  settings.writeChannel(1, 0);
  check('mode at 0 is off', settings.shutterMode, SHUTTER_MODES.OFF);
  settings.writeChannel(1, 255);
  check('mode at 255 is the last mode', settings.shutterMode, SHUTTER_MODE_ORDER[SHUTTER_MODE_ORDER.length - 1]);
  settings.writeChannel(1, 64);
  check('mode at 64 is strobe', settings.shutterMode, SHUTTER_MODES.STROBE);
  settings.writeChannel(2, 255);
  near('rate at 255 is the fastest', settings.rate, 25);
  settings.writeChannel(2, 0);
  near('rate at 0 is the slowest', settings.rate, 1);
  settings.writeChannel(3, 255);
  near('duration at 255 is the longest', settings.duration, 500);
  settings.writeChannel(0, 128);
  near('dimmer at 128 is about half', settings.gain, 128 / 255, 1e-6);
  settings.writeChannel(7, 200);
  check('blinder above half is on', settings.shutterMode, SHUTTER_MODES.ON);
  settings.writeChannel(8, 255);
  check('flash above half is held', settings.flashHeld, true);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
