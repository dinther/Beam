/* eslint-disable no-console */
/**
 * Entity value parsing.
 *
 * Guards the conversion every capability value passes through on its way from a
 * fixture profile into the renderer. It is a quiet piece of code with a loud
 * failure mode: a value it cannot classify falls to a catch-all that multiplies
 * by a thousand, and nothing downstream can tell that apart from a profile that
 * really did ask for a thousand.
 *
 * That is not hypothetical. Until 2026-08-29 `parseValueUnit` found a unit by
 * stripping digits and left the decimal point behind, so `"3.5"` was read as
 * carrying a unit of `"."`. Nothing matches that, so a colour wheel parked on a
 * split colour -- slot 3.5, the wheel sitting between two slots -- arrived as
 * slot 3500, was rejected as out of range, and the head silently kept whatever
 * colour it already had. Whole-numbered slots were fine, so it presented as one
 * mover at a time refusing to take its colour, moving between loads depending
 * on where the console had parked each wheel.
 *
 * The 3.5 case below is that bug. The unit cases beside it are the reason the
 * fix cannot simply strip every non-digit: `ms`, `%`, `s` and `rpm` all have to
 * keep resolving, or the conversion goes wrong in the other direction.
 *
 * Usage:
 *   npm test
 */
import EntityManager from '@/models/DMX/entityManager.model';

let failures = 0;

/**
 * @param {String} label what is being asserted
 * @param {*} got
 * @param {*} want
 */
function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(46)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

const slotNumber = EntityManager.entities.SlotNumber;
// A static, reached through an instance because the class itself is not exported.
const unitOf = slotNumber.constructor.parseValueUnit;

console.log('parseValueUnit -- what is left after the number is removed');
check('a whole number carries no unit', unitOf('4'), null);
check('a fractional number carries no unit', unitOf('3.5'), null);
check('given a Number rather than a String', unitOf(3.5), null);
check('a negative fractional number', unitOf('-2.5'), null);
check('milliseconds', unitOf('20ms'), 'ms');
check('percent', unitOf('100%'), '%');
check('seconds, with a fractional value', unitOf('2.5s'), 's');
check('revolutions per minute', unitOf('120rpm'), 'rpm');
check('a unit separated by a space', unitOf('20 ms'), 'ms');

// `ENTITY_UNIT_NONE` is null, and min/max are 0, exactly as `capabilityManager`
// declares the WheelSlot capability's slotNumber.
const asSlot = (value) => slotNumber.getValue(value, null, 0, 0);

console.log('\nSlotNumber.getValue -- a wheel slot must survive unchanged');
check('whole slot 4', asSlot(4), 4);
check('whole slot 5', asSlot(5), 5);
check('split slot 3.5', asSlot(3.5), 3.5);
check('split slot 3.5, as a string', asSlot('3.5'), 3.5);

console.log('\nthe slot index a split colour resolves to');
// `fixture.model.js` turns a slot number into an index this way. The wheel that
// failed had nine slots, so anything at or above 9 is dropped as out of range.
const index = Math.floor(asSlot(3.5)) - 1;
check('lands inside a nine-slot wheel', index >= 0 && index < 9, true);
console.log(`      slot 3.5 -> index ${index}   (before the fix: 3500 -> 3499)`);

console.log('\nunits must keep converting');
check('20ms as milliseconds', EntityManager.entities.Time.getValue('20ms', 'ms', 0, 1000), 20);
check('50% of a 0..1 range', EntityManager.entities.Percent.getValue('50%', '%', 0, 1), 0.5);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
