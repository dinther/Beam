/* eslint-disable no-console */
/**
 * The shutter model, run at 60 fps against every rate a strobe is asked for.
 *
 * What is pinned: the number of lit frames per second is the rate, whatever
 * the rate; a bare flash lights exactly one frame at full; a long pulse lights
 * the frames it covers by the fraction it covers them; the ramps follow the
 * clock; a stalled clock does not pour missed flashes into one frame.
 *
 * Usage:
 *   npm test
 */
import Shutter, { SHUTTER_MODES } from '@/plugins/visualizer/shutter';

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

function within(label, got, low, high) {
  const ok = got >= low && got <= high;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)} got ${got}  want ${low}..${high}`);
}

/** A seeded 0..1 source, so the random modes give the same answer every run. */
function seeded(seed) {
  let state = seed >>> 0; // eslint-disable-line no-bitwise
  return () => {
    state = (state + 0x6D2B79F5) >>> 0; // eslint-disable-line no-bitwise
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1); // eslint-disable-line no-bitwise
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61); // eslint-disable-line no-bitwise
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; // eslint-disable-line no-bitwise
  };
}

const FPS = 60;
const FRAME = 1 / FPS;

/**
 * How far a frame's clock wanders from the exact grid, in seconds.
 *
 * Real frames are never exactly a sixtieth apart, and a flash grid that
 * divides the frame rate would otherwise land flashes exactly on frame
 * boundaries, where which frame gets them is a matter of rounding.
 */
const JITTER = 0.0004;

/**
 * Samples a shutter once per frame for `seconds`, from `from`.
 *
 * @returns {Array} the level of every frame
 */
function run(shutter, seconds, from = 0) {
  const levels = [];
  const frames = Math.round(seconds * FPS);
  for (let i = 1; i <= frames; i += 1) {
    levels.push(shutter.sample(from + i * FRAME + JITTER * Math.sin(i)));
  }
  return levels;
}

/** Frame indices that were lit at all. */
function litFrames(levels) {
  const lit = [];
  levels.forEach((level, i) => { if (level > 0) lit.push(i); });
  return lit;
}

console.log('--- regular strobe: lit frames per second equal the rate, and never beat');
[1, 2, 5, 10, 13, 17, 25, 30].forEach((rate) => {
  const shutter = new Shutter();
  shutter.mode = SHUTTER_MODES.STROBE;
  shutter.rate = rate;
  const levels = run(shutter, 10);
  const lit = litFrames(levels);
  within(`${rate} Hz lights ${rate} frames a second over 10 s`, lit.length, rate * 10 - 1, rate * 10 + 1);
  check(`${rate} Hz: every lit frame is fully lit`, lit.every((i) => levels[i] === 1), true);
  // The gap between flashes, in frames, may only be the two integers either
  // side of the exact spacing -- one integer when the rate divides the frame
  // rate, since the train is anchored inside a frame and jitter smaller than
  // half a frame cannot move a flash across a boundary. Anything else is
  // beating.
  const spacing = FPS / rate;
  let gapsOk = true;
  for (let i = 1; i < lit.length; i += 1) {
    const gap = lit[i] - lit[i - 1];
    if (gap < Math.floor(spacing) || gap > Math.ceil(spacing)) gapsOk = false;
  }
  check(`${rate} Hz: flash spacing is ${Math.floor(spacing)} or ${Math.ceil(spacing)} frames`, gapsOk, true);
});

console.log('--- faster than the frame rate saturates rather than flickering');
{
  const shutter = new Shutter();
  shutter.mode = SHUTTER_MODES.STROBE;
  shutter.rate = 120;
  // The first frame sampled only starts the train, so it is left out.
  const levels = run(shutter, 2).slice(1);
  check('120 Hz: every frame lit', levels.every((level) => level === 1), true);
}

console.log('--- duration: a long pulse lights the frames it covers');
{
  const shutter = new Shutter();
  shutter.mode = SHUTTER_MODES.STROBE;
  shutter.rate = 2;
  shutter.duration = 100;
  const levels = run(shutter, 10);
  const energy = levels.reduce((sum, level) => sum + level, 0);
  // Duty cycle 0.2: 100 ms on every 500 ms, over 600 frames.
  near('2 Hz at 100 ms: energy is the duty cycle', energy, 600 * 0.2, 2);
  check('2 Hz at 100 ms: no frame over full', levels.every((level) => level <= 1), true);
  const partial = levels.filter((level) => level > 0 && level < 1).length;
  check('2 Hz at 100 ms: pulse edges land as partial frames', partial > 0, true);
}
{
  const shutter = new Shutter();
  shutter.mode = SHUTTER_MODES.STROBE;
  shutter.rate = 1;
  shutter.duration = 1000;
  const levels = run(shutter, 3, 0);
  check('1 Hz at 1000 ms: steady on', levels.slice(2).every((level) => Math.abs(level - 1) < 1e-9), true);
}

console.log('--- steady states and the single flash');
{
  const on = new Shutter();
  on.mode = SHUTTER_MODES.ON;
  check('on: level 1', on.sample(FRAME), 1);
  const off = new Shutter();
  off.mode = SHUTTER_MODES.OFF;
  check('off: level 0', off.sample(FRAME), 0);
  off.fire();
  check('off with one flash asked: next frame lit', off.sample(2 * FRAME), 1);
  check('off after the flash: dark again', off.sample(3 * FRAME), 0);
  off.fire();
  off.fire();
  check('two flashes in one frame are one lit frame', off.sample(4 * FRAME), 1);
  check('and leave nothing behind', off.sample(5 * FRAME), 0);
}

console.log('--- random: the mean rate holds, the spacing does not');
{
  const shutter = new Shutter({ random: seeded(7) });
  shutter.mode = SHUTTER_MODES.RANDOM;
  shutter.rate = 5;
  const levels = run(shutter, 60);
  const lit = litFrames(levels);
  within('5 Hz random over 60 s: about 300 flashes', lit.length, 300 * 0.85, 300 * 1.15);
  const gaps = new Set();
  for (let i = 1; i < lit.length; i += 1) gaps.add(lit[i] - lit[i - 1]);
  check('5 Hz random: spacing varies', gaps.size > 3, true);
  const shortest = Math.min(...gaps);
  check('5 Hz random: never two flashes in one frame pattern', shortest >= 3, true);
}

console.log('--- lightning: strokes come in bursts');
{
  const shutter = new Shutter({ random: seeded(11) });
  shutter.mode = SHUTTER_MODES.LIGHTNING;
  shutter.rate = 1;
  const levels = run(shutter, 30);
  const lit = litFrames(levels);
  const gaps = [];
  for (let i = 1; i < lit.length; i += 1) gaps.push(lit[i] - lit[i - 1]);
  const strokes = gaps.filter((gap) => gap <= 4).length;
  const pauses = gaps.filter((gap) => gap >= 15).length;
  check('1 Hz lightning: has fast strokes', strokes > 10, true);
  within('1 Hz lightning: about one burst a second', pauses, 20, 40);
  check('1 Hz lightning: strokes outnumber pauses', strokes > pauses, true);
}

console.log('--- ramps follow the clock');
{
  const up = new Shutter();
  up.mode = SHUTTER_MODES.RAMP_UP;
  up.rate = 1;
  near('ramp up at a quarter cycle', up.sample(0.25), 0.25);
  near('ramp up at three quarters', up.sample(0.75), 0.75);
  const down = new Shutter();
  down.mode = SHUTTER_MODES.RAMP_DOWN;
  down.rate = 1;
  near('ramp down at a quarter cycle', down.sample(0.25), 0.75);
  const pulse = new Shutter();
  pulse.mode = SHUTTER_MODES.PULSE;
  pulse.rate = 1;
  near('pulse peaks at mid cycle', pulse.sample(0.5), 1);
  near('pulse is dark at the cycle boundary', pulse.sample(1.0), 0);
  const still = new Shutter();
  still.mode = SHUTTER_MODES.PULSE;
  still.rate = 0;
  check('a ramp with no rate is steady on', still.sample(0.5), 1);
  const idle = new Shutter();
  idle.mode = SHUTTER_MODES.STROBE;
  idle.rate = 0;
  idle.sample(FRAME);
  check('a strobe with no rate is steady on', idle.sample(2 * FRAME), 1);
}

console.log('--- a stalled clock does not flood the next frame');
{
  const shutter = new Shutter();
  shutter.mode = SHUTTER_MODES.STROBE;
  shutter.rate = 10;
  run(shutter, 1);
  const afterStall = shutter.sample(1 + 5);
  check('frame after a 5 s stall is at most fully lit', afterStall <= 1, true);
  const levels = run(shutter, 2, 6);
  within('the rate resumes after the stall', litFrames(levels).length, 19, 21);
}

console.log('--- switching on flashes at once, switching off goes dark at once');
{
  const shutter = new Shutter();
  shutter.mode = SHUTTER_MODES.OFF;
  run(shutter, 2);
  shutter.mode = SHUTTER_MODES.STROBE;
  shutter.rate = 1;
  const first = [shutter.sample(2 + FRAME), shutter.sample(2 + 2 * FRAME)];
  check('first flash within two frames of switching on', first.some((level) => level === 1), true);
  shutter.mode = SHUTTER_MODES.OFF;
  check('dark on the frame after switching off', shutter.sample(2 + 3 * FRAME), 0);
}

console.log('--- stepping on a recorder\'s slots: a 30 fps take of a 15 Hz strobe drawn at 59.94');
{
  // The display is not at exactly 60 Hz, and the recorder's clock has a
  // different zero from the scene's, as in the app. The lamp samples on the
  // scene clock; the recorder answers with its slot and when it began, in
  // its own seconds.
  const RECORD_FPS = 30;
  const DISPLAY_FRAME = 1 / 59.94;
  const RECORDER_OFFSET = 1234.567;
  let sceneClock = 0;
  let recorderStart = null;
  const recorderNow = () => sceneClock + RECORDER_OFFSET;
  const slotOf = () => {
    if (recorderStart === null) recorderStart = recorderNow();
    const index = Math.floor((recorderNow() - recorderStart) * RECORD_FPS);
    return { index, seconds: recorderStart + index / RECORD_FPS, length: 1 / RECORD_FPS };
  };

  const shutter = new Shutter();
  shutter.mode = SHUTTER_MODES.STROBE;
  shutter.rate = 15;
  // Two seconds on the display's own clock before the take starts.
  for (let i = 1; i <= 120; i += 1) shutter.sample(i * FRAME);
  sceneClock = 2;

  Shutter.setSlotClock(slotOf);
  const taken = [];
  let lastSlot = -1;
  let firstStepped = null;
  for (let i = 1; i <= 20 * 60; i += 1) {
    sceneClock = 2 + i * DISPLAY_FRAME + JITTER * Math.sin(i);
    const level = shutter.sample(sceneClock);
    if (firstStepped === null) firstStepped = shutter.frameSeconds;
    // The recorder takes the first drawn frame of every slot.
    const { index } = slotOf();
    if (index > lastSlot) {
      lastSlot = index;
      taken.push(level);
    }
  }
  Shutter.setSlotClock(null);

  near('the first frame on the recorder\'s clock is a whole slot long', firstStepped, 1 / RECORD_FPS);
  const litTaken = taken.filter((level) => level > 0).length;
  within('15 Hz over 20 s: the take holds 300 lit frames', litTaken, 297, 301);
  // Every other frame lit, from the first flash on, with no slip anywhere.
  const firstLit = taken.findIndex((level) => level > 0);
  let breaks = 0;
  for (let i = firstLit; i < taken.length; i += 1) {
    const shouldBeLit = (i - firstLit) % 2 === 0;
    if ((taken[i] > 0) !== shouldBeLit) breaks += 1;
  }
  check('the alternation never breaks', breaks, 0);
  check('every lit frame is fully lit', taken.every((level) => level === 0 || level === 1), true);

  // Handed back to the display's clock, the lamp carries on rather than
  // waiting for a schedule written in the recorder's seconds.
  const after = [];
  for (let i = 1; i <= 120; i += 1) after.push(shutter.sample(22 + i * FRAME));
  within('back on the scene clock: 2 s at 15 Hz is 30 flashes', after.filter((l) => l > 0).length, 29, 31);
}

console.log('--- OFL effects map to modes');
check('Open', Shutter.modeFromEffect('Open'), SHUTTER_MODES.ON);
check('Closed', Shutter.modeFromEffect('Closed'), SHUTTER_MODES.OFF);
check('Strobe', Shutter.modeFromEffect('Strobe'), SHUTTER_MODES.STROBE);
check('Strobe with random timing', Shutter.modeFromEffect('Strobe', true), SHUTTER_MODES.RANDOM);
check('Pulse', Shutter.modeFromEffect('Pulse'), SHUTTER_MODES.PULSE);
check('RampUpDown', Shutter.modeFromEffect('RampUpDown'), SHUTTER_MODES.PULSE);
check('RampUp', Shutter.modeFromEffect('RampUp'), SHUTTER_MODES.RAMP_UP);
check('RampDown', Shutter.modeFromEffect('RampDown'), SHUTTER_MODES.RAMP_DOWN);
check('Lightning', Shutter.modeFromEffect('Lightning'), SHUTTER_MODES.LIGHTNING);
check('Spikes falls back to strobe', Shutter.modeFromEffect('Spikes'), SHUTTER_MODES.STROBE);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
