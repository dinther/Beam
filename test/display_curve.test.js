/* eslint-disable no-console */
/**
 * A display's curve is authored as an angle.
 *
 * The width is arc length, so an angle and a radius are the same fact said
 * twice -- but only the angle is a number anybody has in mind. A quarter turn
 * around a pillar is a decision; the radius that implies for this particular
 * panel is arithmetic in the way of it.
 *
 * Usage:
 *   npm test
 */
import { displayCurve, DEFAULT_DISPLAY_PARAMS } from '@/models/DMX/generic/display';

let failures = 0;

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`);
}

const panel = (curveAngle) => ({ ...DEFAULT_DISPLAY_PARAMS, width: 4, curveAngle });

console.log('\n-- the angle decides the radius --');
{
  // A 4 m panel bent through 90 degrees: the arc is 4 m, so r = 4 / (pi/2).
  const quarter = displayCurve(panel(90), 4);
  check('90 degrees of a 4 m panel', quarter.radius.toFixed(4), (4 / (Math.PI / 2)).toFixed(4));
  check('the arc is the angle in radians', quarter.angle.toFixed(6), (Math.PI / 2).toFixed(6));
  check('convex', quarter.sign, 1);

  const concave = displayCurve(panel(-90), 4);
  check('negative is concave', concave.sign, -1);
  check('and the same radius', concave.radius.toFixed(4), quarter.radius.toFixed(4));
}

console.log('\n-- flat is flat --');
{
  const flat = displayCurve(panel(0), 4);
  check('no angle, no curve', [flat.radius, flat.sign, flat.angle], [0, 0, 0]);
}

console.log('\n-- an angle survives a resize, a radius would not --');
{
  // The point of the change: the same panel made wider is still a quarter turn.
  const small = displayCurve(panel(90), 2);
  const large = displayCurve(panel(90), 8);
  check(
    'both still a quarter turn',
    [small.angle.toFixed(6), large.angle.toFixed(6)],
    [(Math.PI / 2).toFixed(6), (Math.PI / 2).toFixed(6)],
  );
  check('the radius follows the width', (large.radius / small.radius).toFixed(4), '4.0000');
}

console.log('\n-- capped at half a turn --');
{
  const over = displayCurve(panel(300), 4);
  check('300 degrees is held to 180', over.angle.toFixed(6), Math.PI.toFixed(6));
}

console.log('\n-- a panel saved before this still curves --');
{
  // Authored as a radius. The width it was bent at gives the angle back.
  const legacy = { ...DEFAULT_DISPLAY_PARAMS, width: 4, curveRadius: 4 / (Math.PI / 2) };
  const curve = displayCurve(legacy, 4);
  check('the old radius reads as 90 degrees', curve.angle.toFixed(6), (Math.PI / 2).toFixed(6));
  check('and keeps its direction', curve.sign, 1);
  const concave = displayCurve({ ...legacy, curveRadius: -legacy.curveRadius }, 4);
  check('a negative radius is still concave', concave.sign, -1);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
