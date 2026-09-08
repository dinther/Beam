/* eslint-disable no-console */
/* eslint-disable no-bitwise */
// A point's x is a signed 16-bit galvo value carried as its bit pattern, so
// masking it is the subject matter, not an accident.
/**
 * The laser profile and the renderer-side point stream.
 *
 * Two headless pieces of the laser fixture: `generic/laser.js` builds an
 * OFL-shaped profile the fixture parser can read, and `plugins/laser_stream.js`
 * accumulates the points a DAC plays into a rolling window the renderer draws.
 * Neither needs a GPU or a running app, so both are checked here the way the
 * arrangement maths is -- against the real modules, with numbers worked by hand.
 *
 * Usage:
 *   npm test
 */
import {
  buildLaserProfile, isLaserProfile, DEFAULT_LASER_PARAMS,
  scanHalfAngles, beamWidthAt, imageSizeAt, apertureOrigin,
} from '@/models/DMX/generic/laser';
import { buildProjectorProfile } from '@/models/DMX/generic/projector';
import LaserSettings from '@/models/DMX/laser_settings';
import LaserStream, { POINT_STRIDE, MAX_WINDOW_MS } from '@/plugins/laser_stream';

let failures = 0;

function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

function near(label, got, want, tol = 1e-6) {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} got ${got}  want ~${want}`);
}

// -- The profile ----------------------------------------------------------
const profile = buildLaserProfile();
check('default profile is a laser', isLaserProfile(profile), true);
check('a projector is not a laser', isLaserProfile(buildProjectorProfile()), false);
check('nonsense is not a laser', isLaserProfile({}), false);
check('name carries the power', profile.name, 'Laser 5W');
check('category is OFL Other', profile.categories[0], 'Other');
check('marked generated', profile.meta.generated, true);
check('asls.laser carries the params', profile.asls.laser.scanAngleH, 50);
check('bulb type laser', profile.physical.bulb.type, 'Laser');
check('dimensions in mm, w/h/d', profile.physical.dimensions.join(), '300,160,340');

// Channels: none by default, like a projector.
check('no channels by default', profile.modes[0].channels.length, 0);
check('no available channels by default', Object.keys(profile.availableChannels).length, 0);

// A control block: dimmer 8-bit at channel 1, X position 16-bit at channel 3,
// so channel 2 is a gap. The profile lays out four slots, coarse-first.
const controls = {
  dimmer: {
    mode: 'dmx', value: 100, channel: 1, bits: 8,
  },
  xPos: {
    mode: 'dmx', value: 0, channel: 3, bits: 16,
  },
  red: { mode: 'fixed', value: 50 },
};
const withControls = buildLaserProfile({ controls });
check('footprint spans to the furthest byte', withControls.modes[0].channels.length, 4);
check('slot 1 is the dimmer', withControls.modes[0].channels[0], 'Dimmer');
check('slot 2 is a reserved gap', withControls.modes[0].channels[1], 'Reserved 2');
check('slot 3 is the 16-bit position, first byte', withControls.modes[0].channels[2], 'X Position');
check('slot 4 is its second byte, numbered not "fine"', withControls.modes[0].channels[3], 'X Position 2');
check('no channel name contains "fine"', withControls.modes[0].channels.some((n) => / fine/i.test(n)), false);
check('a fixed parameter takes no channel', withControls.modes[0].channels.includes('Red Balance'), false);

// Overrides flow through.
const big = buildLaserProfile({ power: 10, scanAngleH: 60 });
check('power override in the name', big.name, 'Laser 10W');
check('scan override in asls', big.asls.laser.scanAngleH, 60);

// -- The settings / output stage ------------------------------------------
// A laser with no controls: everything adjustable, at its parked default.
const plain = new LaserSettings(buildLaserProfile().asls.laser, {});
check('no controls means nothing is driven', plain.channels.length, 0);
check('everything defaults to adjustable', plain.mode('dimmer'), 'adjustable');
check('dimmer parks at full', plain.value('dimmer'), 100);
check('shutter parks open', plain.value('shutter'), true);
check('x position parks centred', plain.value('xPos'), 0);
check('source parks unset', plain.value('source'), null);
check('gain is dimmer times shutter, open and full', plain.gain, 1);
plain.set('dimmer', 50);
check('gain follows a hand-set dimmer', plain.gain, 0.5);
plain.set('shutter', false);
check('a closed shutter is no light', plain.gain, 0);

// Fixed: baked in the profile, not shown, not settable, not in the show.
const fixed = new LaserSettings(buildLaserProfile({ controls }).asls.laser, {});
check('a fixed parameter reports fixed', fixed.isFixed('red'), true);
check('a fixed parameter takes its baked value', fixed.value('red'), 50);
fixed.set('red', 90);
check('a fixed parameter refuses a set', fixed.value('red'), 50);
check('a fixed parameter does not travel in the show', 'red' in fixed.showData, false);

// DMX, 8-bit and 16-bit, assembled coarse-first at the named offsets.
check('dimmer is driven', fixed.isDriven('dimmer'), true);
check('the fixture footprint is four channels', fixed.footprint, 4);
fixed.writeChannel(0, 128); // dimmer, 8-bit
near('8-bit dimmer from 128', fixed.value('dimmer'), (128 / 255) * 100, 0.01);
// xPos is 16-bit at channel 3, i.e. byte offsets 2 (coarse) and 3 (fine).
fixed.writeChannel(2, 0xff);
fixed.writeChannel(3, 0xff);
near('16-bit xPos at full is +100', fixed.value('xPos'), 100, 0.001);
fixed.writeChannel(2, 0x00);
fixed.writeChannel(3, 0x00);
near('16-bit xPos at zero is -100', fixed.value('xPos'), -100, 0.001);
fixed.writeChannel(2, 0x80);
fixed.writeChannel(3, 0x00);
near('16-bit xPos at half (0x8000) is centred', fixed.value('xPos'), 0, 0.1);
// Coarse-first: the coarse byte moves the value far, the fine byte barely.
fixed.writeChannel(2, 0x80);
fixed.writeChannel(3, 0xff);
near('the fine byte is the small end', fixed.value('xPos'), 0, 1.0);
// The gap at offset 1 drives nothing.
const before = fixed.value('dimmer');
fixed.writeChannel(1, 255);
check('a byte in the reserved gap changes nothing', fixed.value('dimmer'), before);

// Legacy compatibility: an old profile with a `channels` tick-list and no
// `controls` reads as DMX, 8-bit, in the kind's order.
const legacy = new LaserSettings({ channels: ['dimmer', 'red'] }, {});
check('legacy ticks become driven', legacy.channels.sort().join(), 'dimmer,red');
check('legacy footprint is one byte each', legacy.footprint, 2);
legacy.writeChannel(0, 255);
legacy.writeChannel(1, 0);
check('legacy dimmer from DMX 255', legacy.value('dimmer'), 100);
check('legacy red from DMX 0', legacy.value('red'), 0);
check('legacy leaves the rest adjustable', legacy.mode('green'), 'adjustable');

// Only non-fixed values travel; source among them.
const parked = new LaserSettings(buildLaserProfile().asls.laser, {});
parked.set('green', 40);
parked.set('source', 'etherdream');
check('showData carries the parked values', parked.showData.green, 40);
check('showData carries source', parked.showData.source, 'etherdream');
check('source never becomes a channel', parked.isDriven('source'), false);

// -- The geometry ---------------------------------------------------------
// The geometry helpers take the `asls.laser` params, the way the renderer
// reads them off a fixture -- not the whole OFL profile.
const p = profile.asls.laser;
// 50 degree full scan -> 25 degree half angle -> 0.4363 rad.
near('scan half-angle H is half the full, in rad', scanHalfAngles(p).h, (25 * Math.PI) / 180);
near('scan half-angle V likewise', scanHalfAngles(p).v, (25 * Math.PI) / 180);

// Beam width: 3 mm aperture + 1 mrad over distance. At 20 m, +20 mm = 23 mm.
near('beam width at the aperture is the diameter', beamWidthAt(0, p), 0.003);
near('beam width at 20 m adds 1 mrad', beamWidthAt(20, p), 0.003 + 20 * 0.001);
near('beam width never goes negative behind the aperture', beamWidthAt(-5, p), 0.003);

// Image size: full-scale scan is 2*d*tan(halfAngle) each axis. At 10 m:
const halfRad = (25 * Math.PI) / 180;
near('image width at 10 m', imageSizeAt(10, p).width, 2 * 10 * Math.tan(halfRad));
near('image is square when the two scans match', imageSizeAt(10, p).height, imageSizeAt(10, p).width);

// Aperture origin: centred X/Z, on the front face at -depth/2, +Z up.
const ap = apertureOrigin(profile.asls.laser);
check('aperture x centred', ap.x, 0);
check('aperture on the front face along -Y', ap.y, -(DEFAULT_LASER_PARAMS.depth / 2));
check('aperture z centred', ap.z, 0);
const offset = apertureOrigin({ ...DEFAULT_LASER_PARAMS, apertureX: 0.1, apertureY: 0.05 });
check('apertureX maps to local x, unnegated', offset.x, 0.1);
check('apertureY maps to local z, unnegated', offset.z, 0.05);

// -- The point stream -----------------------------------------------------
LaserStream.disable(); // start from nothing; the singleton may be shared

/** A batch of `n` points; x ramps so order is checkable, colour is full. */
function batch(protocol, rate, n, xBase = 0) {
  const points = new Uint16Array(n * POINT_STRIDE);
  for (let i = 0; i < n; i += 1) {
    const b = i * POINT_STRIDE;
    points[b] = (xBase + i) & 0xffff;
    points[b + 1] = 0;
    points[b + 2] = 0xffff;
    points[b + 3] = 0;
    points[b + 4] = 0;
    points[b + 5] = 0xffff;
  }
  return { protocol, rate, points };
}

check('an unseen protocol yields an empty frame', LaserStream.frame('etherdream').count, 0);

// 30 kpps: a 50 ms window is 1500 points. Push 2000; the window is the last 1500.
LaserStream.push(batch('etherdream', 30000, 2000));
let f = LaserStream.frame('etherdream', 50);
check('window is rate * ms / 1000', f.count, 1500);
check('window carries the rate', f.rate, 30000);
// Oldest-first, and the last 1500 of 0..1999 begin at 500.
check('window begins at the right point, oldest first', f.points[0], 500);
check('window ends at the newest point', f.points[(f.count - 1) * POINT_STRIDE], 1999);
check('a point keeps its colour', f.points[2], 0xffff);

// A shorter window is fewer points, still the newest.
check('a 10 ms window is 300 points', LaserStream.frame('etherdream', 10).count, 300);
check('the 10 ms window still ends at the newest', LaserStream.frame('etherdream', 10).points[299 * POINT_STRIDE], 1999);

// The window is clamped so a caller cannot outrun the ring.
check('window is clamped to MAX_WINDOW_MS', LaserStream.frame('etherdream', 10000).count, LaserStream.frame('etherdream', MAX_WINDOW_MS).count);

// A second protocol is a separate buffer.
LaserStream.push(batch('lasercube', 20000, 100, 7000));
check('lasercube frame is its own points', LaserStream.frame('lasercube', 50).points[0], 7000 & 0xffff);
check('etherdream frame is unchanged by it', LaserStream.frame('etherdream', 50).points[0], 500);

// More points than the ring holds: only the tail survives, newest intact.
LaserStream.push(batch('lasercube', 20000, 10000, 0));
f = LaserStream.frame('lasercube', MAX_WINDOW_MS);
check('the ring never holds more than its capacity', f.count <= 8192, true);
check('after an over-long batch the newest point is the last one', f.points[(f.count - 1) * POINT_STRIDE], 9999);

// report reflects what arrived.
const report = LaserStream.report();
check('report lists both protocols', report.length, 2);
check('report counts what was received', report.find((r) => r.protocol === 'etherdream').received, 2000);

// disable clears everything.
LaserStream.disable();
check('disable forgets the buffers', LaserStream.frame('etherdream').count, 0);
check('report is empty after disable', LaserStream.report().length, 0);

// A batch with no points, or a malformed one, is harmless.
LaserStream.push({ protocol: 'etherdream', rate: 30000, points: new Uint16Array(0) });
check('an empty batch adds nothing', LaserStream.frame('etherdream').count, 0);
LaserStream.push({});
LaserStream.push(null);
check('a malformed batch is ignored', LaserStream.report().length, 1);

LaserStream.disable();

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
