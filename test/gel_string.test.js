/* eslint-disable no-console */
/**
 * A string of gels in front of a white lamp, positioned by one channel.
 *
 * What is pinned: a position is a place on the string, whole numbers one gel
 * and the fractions between them two side by side; the light through a gel
 * and across a split; the words for what is in; and the channel that lays
 * its whole range along the string and declares frames and splits to OFL.
 *
 * Usage:
 *   npm test
 */
import {
  DEFAULT_GELS, gelsIn, clampPosition, hexToLinear, splitThroughGel, throughGel, frameName,
  gelControl,
} from '@/models/DMX/generic/gel_string';

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

const WHITE = [1, 1, 1];
const THREE_GELS = [
  { name: 'Open', colour: '#ffffff' },
  { name: 'Red', colour: '#ff0000' },
  { name: 'Blue', colour: '#0000ff' },
];

console.log('--- the string');
check('nothing usable is the shipped string', gelsIn(undefined), DEFAULT_GELS);
check('an empty list is the shipped string', gelsIn([]), DEFAULT_GELS);
check('nameless entries are dropped', gelsIn([{ colour: '#ff0000' }, { name: 'Red', colour: '#ff0000' }]).length, 1);
check('a position below the string is its start', clampPosition(THREE_GELS, -4), 1);
check('a position past the string is its end', clampPosition(THREE_GELS, 9), 3);
check('a position that is not a number is the start', clampPosition(THREE_GELS, 'x'), 1);

console.log('--- colours');
near('white decodes to one', hexToLinear('#ffffff')[0], 1);
near('black decodes to nothing', hexToLinear('#000000')[1], 0);
near('sRGB mid grey is a fifth in linear light', hexToLinear('#808080')[2], 0.2158605, 1e-6);
near('not a colour is an open frame', hexToLinear('nonsense')[0], 1);

console.log('--- one gel, or two side by side');
{
  const red = throughGel(WHITE, THREE_GELS, 2);
  check('frame 2 is red', red[0] === 1 && red[1] === 0 && red[2] === 0, true);
  const split = splitThroughGel(WHITE, THREE_GELS, 2.5);
  near('half way between: half the aperture is the next gel', split.fraction, 0.5);
  check('the first half is red', split.first[0] === 1 && split.first[2] === 0, true);
  check('the second half is blue', split.second[2] === 1 && split.second[0] === 0, true);
  const room = throughGel(WHITE, THREE_GELS, 2.5);
  near('the room sees half red', room[0], 0.5);
  near('and half blue', room[2], 0.5);
  const quarter = splitThroughGel(WHITE, THREE_GELS, 2.25);
  near('a quarter in: a quarter of the aperture', quarter.fraction, 0.25);
  const end = splitThroughGel(WHITE, THREE_GELS, 3);
  near('the last frame has nothing past it', end.fraction, 0);
  const tinted = throughGel([1, 0.8, 0.6], THREE_GELS, 1);
  near('the open frame passes the lamp\'s own white', tinted[1], 0.8);
}

console.log('--- in words');
check('a whole frame', frameName(THREE_GELS, 2), 'Red');
check('half way names both', frameName(THREE_GELS, 2.5), 'Red / Blue');
check('a little past a frame is still that frame', frameName(THREE_GELS, 2.2), 'Red');
check('a little short of the next is the next', frameName(THREE_GELS, 2.8), 'Blue');
check('the last frame', frameName(THREE_GELS, 3), 'Blue');
check('an empty string has no words', frameName([], 1), '');

console.log('--- the control');
{
  const def = gelControl('gel', 'Gel', THREE_GELS);
  check('key and label', `${def.key} ${def.label}`, 'gel Gel');
  near('parks on frame 1', def.type.initial({}), 1);
  check('bounded by the string', def.type.range({}).max, 3);
  near('level 0 is frame 1', def.type.fromLevel(0, {}), 1);
  near('level 1 is the last frame', def.type.fromLevel(1, {}), 3);
  near('level a half is the middle frame', def.type.fromLevel(0.5, {}), 2);
  near('level a quarter is half way between 1 and 2', def.type.fromLevel(0.25, {}), 1.5);
  const ranges = def.capabilityFor({});
  check('frames and splits: five ranges for three gels', ranges.length, 5);
  check('first range starts at 0', ranges[0].dmxRange[0], 0);
  check('last range ends at 255', ranges[ranges.length - 1].dmxRange[1], 255);
  let contiguous = true;
  for (let i = 1; i < ranges.length; i += 1) {
    if (ranges[i].dmxRange[0] !== ranges[i - 1].dmxRange[1] + 1) contiguous = false;
  }
  check('ranges are contiguous', contiguous, true);
  check('a split range carries two colours', ranges[1].colors.length, 2);
  check('a split is named for both', ranges[1].comment, 'Open / Red');
  check('a frame range carries one colour', ranges[2].colors.length, 1);
  const one = gelControl('gel', 'Gel', [THREE_GELS[1]]);
  check('one gel is one preset, no ranges', Array.isArray(one.capabilityFor({})), false);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
