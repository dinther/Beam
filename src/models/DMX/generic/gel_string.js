/**
 * @file A string of colour frames in front of a white lamp, chosen by one
 * channel, with the positions between frames showing two at once.
 *
 * A gel scroller on a strobe or a PAR, and a colour wheel in a moving head,
 * are the same thing to the light: the lamp's white filtered by what is in
 * front of it. Parked between two frames, both are: half the beam through one
 * gel, half through the next, which is a look of its own and a standard
 * position on a wheel. So the frame is a **position**, a number from 1 to the
 * string's length. A whole number is one gel; the fraction past it is how far
 * the next gel has come in.
 *
 * What differs between a scroller and a wheel is mechanics -- a strip against
 * a disc, and a wheel that can spin -- and none of that is here. This is the
 * frames, the control that positions them, the arithmetic of white through
 * them, and the words for what is in.
 */
import { ControlDef, RangeType } from '../device_control';

/**
 * The string a scroller ships with when nobody has said otherwise: an open
 * frame and eleven common saturated gels, as `#rrggbb` in sRGB.
 *
 * @constant {Array}
 */
export const DEFAULT_GELS = [
  { name: 'Open', colour: '#ffffff' },
  { name: 'Red', colour: '#e2231a' },
  { name: 'Orange', colour: '#f26f21' },
  { name: 'Amber', colour: '#f6a01a' },
  { name: 'Yellow', colour: '#f4e400' },
  { name: 'Green', colour: '#22a745' },
  { name: 'Cyan', colour: '#16b7c6' },
  { name: 'Light Blue', colour: '#3f8ce6' },
  { name: 'Deep Blue', colour: '#2a3fbf' },
  { name: 'Magenta', colour: '#d3369b' },
  { name: 'Pink', colour: '#f28cb1' },
  { name: 'Lavender', colour: '#9a7ad6' },
];

/**
 * How far off a whole frame a position may be and still count as that frame
 * alone, on a patch sheet. Past it, two gels are declared.
 *
 * @constant {Number}
 */
const SPLIT_FROM = 0.25;

/**
 * A string as a profile carries it, made usable: entries with a name, in
 * order; the shipped string when there is nothing usable.
 *
 * @public
 * @param {*} gels what the profile holds under its gels key
 * @returns {Array} `[{ name, colour }]`
 */
export function gelsIn(gels) {
  const usable = Array.isArray(gels)
    ? gels.filter((gel) => gel && typeof gel.name === 'string' && gel.name)
    : [];
  return usable.length ? usable : DEFAULT_GELS;
}

/**
 * A position kept on the string: 1 to the number of frames.
 *
 * @public
 * @param {Array} gels the string
 * @param {*} position
 * @returns {Number}
 */
export function clampPosition(gels, position) {
  const wanted = Number(position);
  if (!Number.isFinite(wanted)) return 1;
  return Math.min(Math.max(wanted, 1), Math.max(gels.length, 1));
}

/**
 * A gel's `#rrggbb` as linear RGB, 0..1 per channel.
 *
 * Gels are quoted in sRGB, as swatches are; the lamp mixes in linear light.
 * Anything that is not a colour is an open frame.
 *
 * @public
 * @param {String} hex
 * @returns {Array} `[r, g, b]`
 */
export function hexToLinear(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!match) return [1, 1, 1];
  const value = parseInt(match[1], 16);
  const decode = (byte) => {
    const c = byte / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  // eslint-disable-next-line no-bitwise
  return [decode((value >> 16) & 255), decode((value >> 8) & 255), decode(value & 255)];
}

/**
 * The two frames a position sits across, and how far it is into the second.
 *
 * @param {Array} gels the string
 * @param {*} position
 * @returns {Object} `{ from, to, fraction }` indices into the string
 */
function framesAt(gels, position) {
  const at = clampPosition(gels, position) - 1;
  const from = Math.floor(at);
  const to = Math.min(from + 1, gels.length - 1);
  return { from, to, fraction: at - from };
}

/**
 * What is in front of the lamp, as the two colours the beam is split into.
 *
 * A position between two frames is not a colour between two colours: the
 * gel boundary lies across the aperture, and one part of the beam is one gel
 * while the rest is the next. `fraction` is how much of the aperture the
 * second gel has covered, 0 on a whole frame. A renderer that can show two
 * halves draws them from this; one that has a single colour to give uses
 * `throughGel`.
 *
 * @public
 * @param {Array} white `[r, g, b]` linear, the lamp's own colour
 * @param {Array} gels the string, from `gelsIn`
 * @param {*} position 1 to the string's length
 * @returns {Object} `{ first, second, fraction }`, colours as `[r, g, b]`
 */
export function splitThroughGel(white, gels, position) {
  if (!gels.length) return { first: white, second: white, fraction: 0 };
  const { from, to, fraction } = framesAt(gels, position);
  const a = hexToLinear(gels[from].colour);
  const b = hexToLinear(gels[to].colour);
  return {
    first: [white[0] * a[0], white[1] * a[1], white[2] * a[2]],
    second: [white[0] * b[0], white[1] * b[1], white[2] * b[2]],
    fraction,
  };
}

/**
 * The lamp's white through what is in front of it, as one colour.
 *
 * On a whole frame, that gel. Between two, the beam is part one colour and
 * part the next, and a single colour cannot show that; what it can show is
 * the light the two parts cast together, which is the two filtered whites
 * added in proportion to the aperture each covers. For the room, that is the
 * right answer. For the lamp's face it is not; see `splitThroughGel`.
 *
 * @public
 * @param {Array} white `[r, g, b]` linear, the lamp's own colour
 * @param {Array} gels the string, from `gelsIn`
 * @param {*} position 1 to the string's length
 * @returns {Array} `[r, g, b]`
 */
export function throughGel(white, gels, position) {
  const { first, second, fraction } = splitThroughGel(white, gels, position);
  return [0, 1, 2].map((c) => first[c] * (1 - fraction) + second[c] * fraction);
}

/**
 * What is in front of the lamp, in words: one gel's name, or two joined when
 * the position is between them.
 *
 * @public
 * @param {Array} gels the string
 * @param {*} position
 * @returns {String}
 */
export function frameName(gels, position) {
  if (!gels.length) return '';
  const { from, to, fraction } = framesAt(gels, position);
  if (fraction <= SPLIT_FROM || from === to) return gels[from].name;
  if (fraction >= 1 - SPLIT_FROM) return gels[to].name;
  return `${gels[from].name} / ${gels[to].name}`;
}

/**
 * The control that positions the string: a number from 1 to the number of
 * frames, parked on the first, with the channel's whole range laid along
 * the string so a desk reaches the splits as a real one does.
 *
 * Built per profile, since the string is the profile's own. Declared to OFL
 * as a ColorPreset range per frame carrying its swatch, and a two-colour
 * range for each split between frames, which is how OFL writes a wheel's
 * half positions.
 *
 * @public
 * @param {String} key the control's key in the profile
 * @param {String} label what a patch sheet calls it
 * @param {Array} gels the string, from `gelsIn`
 * @returns {ControlDef}
 */
export function gelControl(key, label, gels) {
  const count = Math.max(gels.length, 1);
  const type = new RangeType({
    bounds: () => ({ min: 1, max: count }), parks: 'min', precision: 1,
  });
  // A position as the 8-bit channel sees it.
  const dmxAt = (position) => Math.round(((position - 1) / Math.max(count - 1, 1)) * 255);
  const capability = () => {
    if (count === 1) return { type: 'ColorPreset', colors: [gels[0].colour], comment: gels[0].name };
    const ranges = [];
    gels.forEach((gel, i) => {
      const start = i === 0 ? 0 : dmxAt(i + 1 - SPLIT_FROM);
      const end = i === count - 1 ? 255 : dmxAt(i + 1 + SPLIT_FROM) - 1;
      ranges.push({
        dmxRange: [start, end], type: 'ColorPreset', colors: [gel.colour], comment: gel.name,
      });
      if (i < count - 1) {
        const next = gels[i + 1];
        ranges.push({
          dmxRange: [end + 1, dmxAt(i + 2 - SPLIT_FROM) - 1],
          type: 'ColorPreset',
          colors: [gel.colour, next.colour],
          comment: `${gel.name} / ${next.name}`,
        });
      }
    });
    return ranges;
  };
  return new ControlDef(key, label, type, { capability });
}

export default {
  DEFAULT_GELS,
  gelsIn,
  clampPosition,
  hexToLinear,
  splitThroughGel,
  throughGel,
  frameName,
  gelControl,
};
