/**
 * @file Generic strobe: a flat panel of lamp that floods a room in flashes.
 *
 * The same argument as the bar, the projector and the laser -- hundreds of
 * models, no library carries them all -- so a strobe is described from the
 * numbers a spec sheet prints: what the lamp is, how much power it draws, how
 * wide it floods, how fast and how long it can flash, and the box it comes in.
 *
 * Like the others the generated document is OFL-shaped, so `Fixture` reads it
 * through the same path as a library profile, and everything OFL cannot say
 * lives under `asls.strobe`.
 *
 * What the strobe is *doing* -- its rate, its flash length, its mode, its
 * colour, whether it is held on as a blinder -- is a set of controls, each
 * Fixed in the profile, Adjustable per placement or driven over DMX, exactly
 * as a projector's zoom is. The profile only bounds them: a machine that
 * flashes between one and twenty-five hertz has a rate channel that spans
 * that, whatever the desk sends.
 *
 * **Colour is a property of the model.** A xenon tube is white and nothing
 * else, at the temperature the gas gives it; an LED strobe mixes red, green
 * and blue. A white unit has no colour controls at all, rather than three
 * controls that do nothing.
 */
import { COMMON_CONTROLS } from '../device_settings';
import {
  ControlSet, ControlDef, PercentType, RangeType, SwitchType, EnumType, orderOf, labelsOf,
} from '../device_control';
import { whitePoint } from '../colour_temperature';
import {
  DEFAULT_GELS, gelsIn, throughGel, splitThroughGel, gelControl,
} from './gel_string';
import {
  SHUTTER_MODES, SHUTTER_MODE_ORDER, SHUTTER_MODE_LABELS, SHUTTER_MODE_EFFECTS,
} from '../../../plugins/visualizer/shutter';

/** Degrees to radians. */
const RAD = Math.PI / 180;

/**
 * What the lamp is.
 *
 * A xenon flash tube dumps a capacitor through gas: white, at the temperature
 * the discharge gives, a millisecond long. An LED array is switched: it holds
 * for as long as it is told, and may be any colour.
 *
 * @constant {Object}
 */
export const STROBE_SOURCES = {
  XENON: 'xenon',
  LED: 'led',
};

/** What each source is called on screen. */
export const STROBE_SOURCE_LABELS = {
  [STROBE_SOURCES.XENON]: 'Xenon',
  [STROBE_SOURCES.LED]: 'LED',
};

/**
 * How the unit gets its colour.
 *
 * A white unit has none. An RGB array mixes three emitters. A scroller is a
 * strip of gels in front of a white lamp, stepped through by one channel: the
 * only colour a flash tube ever had, since the tube itself is white.
 *
 * @constant {Object}
 */
export const STROBE_COLOURS = {
  WHITE: 'white',
  RGB: 'rgb',
  SCROLLER: 'scroller',
};

/** What each colour capability is called on screen. */
export const STROBE_COLOUR_LABELS = {
  [STROBE_COLOURS.WHITE]: 'White',
  [STROBE_COLOURS.RGB]: 'RGB',
  [STROBE_COLOURS.SCROLLER]: 'Gel scroller',
};

/**
 * The colour capabilities each kind of lamp can have. A tube cannot mix; an
 * array has no scroller bolted on.
 *
 * @constant {Object}
 */
export const COLOURS_FOR_SOURCE = {
  [STROBE_SOURCES.XENON]: [STROBE_COLOURS.WHITE, STROBE_COLOURS.SCROLLER],
  [STROBE_SOURCES.LED]: [STROBE_COLOURS.WHITE, STROBE_COLOURS.RGB],
};

/**
 * Lumens per watt of rated power.
 *
 * A stage LED array manages about a hundred. A xenon tube is rated by the
 * power its supply draws, of which perhaps forty lumens a watt come out as
 * light averaged over time -- the flash itself is far brighter than that for
 * far less than a frame, which is the shutter model's business, not this
 * number's.
 *
 * @constant {Object}
 */
const EFFICACY = {
  [STROBE_SOURCES.LED]: 100,
  [STROBE_SOURCES.XENON]: 40,
};

/**
 * The channels a strobe may expose.
 *
 * Keys rather than labels, because they are stored in the profile and have to
 * survive the label being reworded.
 *
 * @constant {Object}
 */
export const STROBE_CHANNELS = {
  DIMMER: 'dimmer',
  RATE: 'rate',
  DURATION: 'duration',
  MODE: 'mode',
  RED: 'red',
  GREEN: 'green',
  BLUE: 'blue',
  GEL: 'gel',
  BLINDER: 'blinder',
  FLASH: 'flash',
};

/** The three colour channels, which only an RGB unit has. */
const COLOUR_KEYS = [STROBE_CHANNELS.RED, STROBE_CHANNELS.GREEN, STROBE_CHANNELS.BLUE];

/**
 * A mid-sized LED RGB strobe: the class of machine hired for a club or a
 * Halloween show. Real numbers rather than round ones, so the first strobe
 * anyone makes behaves like a strobe. Lengths in metres, angles in degrees,
 * rates in hertz, flash lengths in milliseconds.
 *
 * @constant {Object}
 */
export const DEFAULT_STROBE_PARAMS = {
  /** One of {@link STROBE_SOURCES}. */
  source: STROBE_SOURCES.LED,
  /** One of {@link STROBE_COLOURS}. */
  colour: STROBE_COLOURS.RGB,
  /**
   * The gel string of a scroller, in order, as `{ name, colour }`. Read only
   * when the colour is a scroller.
   */
  gels: DEFAULT_GELS,
  /**
   * Rated power, in watts.
   *
   * The brightness anchor, through the efficacy of the source: nothing here
   * normalises it away, so a 3000 W tube is drawn far brighter than a 300 W
   * array.
   */
  power: 1500,
  /**
   * The white's colour temperature, in kelvin.
   *
   * What a white unit flashes, and what an RGB unit's three channels add up to
   * at full. Xenon runs cool, around 6000 K and above; a white LED array is
   * whatever the maker binned.
   */
  colorTemperature: 6500,
  /**
   * How wide the flood is, in degrees, as full angles across and up.
   *
   * A strobe is a flood, not a beam: a hundred degrees and more is usual, and
   * the whole room in front of it is lit.
   */
  floodAngleH: 110,
  floodAngleV: 110,
  /** The rates the machine will flash at, in hertz. */
  rateMin: 1,
  rateMax: 25,
  /**
   * How long one flash may last, in milliseconds.
   *
   * A xenon tube is a millisecond or so and the channel stretches the
   * discharge; an LED array holds for as long as it is told. Longer is
   * brighter and softer.
   */
  durationMin: 1,
  durationMax: 500,
  /**
   * The body, in metres: a box, measured as it stands facing you. "Depth"
   * rather than "length", which says nothing for a box -- see `projector.js`.
   */
  width: 0.36,
  height: 0.22,
  depth: 0.14,
  /** The chassis colour, `#rrggbb`, part of the definition. */
  bodyColor: '#1c1e20',
  /**
   * The emitting face on the front panel, in metres, centred on it. The tube
   * behind its reflector, or the LED array behind its diffuser.
   */
  faceWidth: 0.30,
  faceHeight: 0.16,
  /**
   * How each controllable parameter is decided, keyed as the attributes are.
   *
   * `{ key: { mode, value, channel, bits } }` -- mode 'fixed' | 'adjustable' |
   * 'dmx'. **Empty by default**, which reads as every parameter adjustable. The
   * create dialog fills this in; see `device_settings.js`.
   */
  controls: {},
};

/**
 * The rates this model flashes at, slowest first.
 *
 * Sorted rather than trusted: the two fields are typed by hand.
 *
 * @public
 * @param {Object} params strobe parameters
 * @returns {Object} `{ min, max }` in hertz
 */
export function rateRange(params) {
  const a = Number(params.rateMin) || DEFAULT_STROBE_PARAMS.rateMin;
  const b = Number(params.rateMax) || a;
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

/**
 * The flash lengths this model offers, shortest first, in milliseconds.
 *
 * @public
 * @param {Object} params strobe parameters
 * @returns {Object} `{ min, max }`
 */
export function durationRange(params) {
  const a = Number(params.durationMin) || DEFAULT_STROBE_PARAMS.durationMin;
  const b = Number(params.durationMax) || a;
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

/**
 * The colour capability this model really has.
 *
 * A profile is a hand-edited document, and one that says a xenon tube mixes
 * RGB describes a lamp that does not exist. Read as the nearest lamp that
 * does: a combination the source cannot have falls back to white.
 *
 * @public
 * @param {Object} params strobe parameters
 * @returns {String} one of {@link STROBE_COLOURS}
 */
export function colourOf(params) {
  const source = params.source || DEFAULT_STROBE_PARAMS.source;
  const wanted = params.colour || DEFAULT_STROBE_PARAMS.colour;
  const allowed = COLOURS_FOR_SOURCE[source] || COLOURS_FOR_SOURCE[STROBE_SOURCES.LED];
  return allowed.includes(wanted) ? wanted : STROBE_COLOURS.WHITE;
}

/**
 * Whether this model mixes colour from three emitters.
 *
 * @public
 * @param {Object} params strobe parameters
 * @returns {Boolean}
 */
export function mixesColour(params) {
  return colourOf(params) === STROBE_COLOURS.RGB;
}

/**
 * Whether this model colours a white lamp through a gel scroller.
 *
 * @public
 * @param {Object} params strobe parameters
 * @returns {Boolean}
 */
export function usesScroller(params) {
  return colourOf(params) === STROBE_COLOURS.SCROLLER;
}

/**
 * The scroller's gel string, in order. The shipped string when the profile
 * has none, or has one with nothing usable in it.
 *
 * @public
 * @param {Object} params strobe parameters
 * @returns {Array} `[{ name, colour }]`
 */
export function gelsOf(params) {
  return gelsIn(params.gels);
}

/**
 * The colour the unit flashes at full, as linear RGB with its brightest
 * channel at one.
 *
 * A white unit flashes its lamp's white. An RGB unit flashes the mix of its
 * three levels, in per cent, with the three at full adding up to the same
 * white -- so an RGB strobe left at its defaults and a white one of the same
 * temperature look alike. A scroller flashes the white through what is in
 * front of it at position `gel`, one frame or two; see `gel_string.js`.
 *
 * @public
 * @param {Object} params strobe parameters
 * @param {Object} [levels] `{ red, green, blue }` in per cent, `gel` a
 *   position on the string
 * @returns {Array} `[r, g, b]`
 */
export function lampColour(params, levels = {}) {
  const kelvin = Number(params.colorTemperature) || DEFAULT_STROBE_PARAMS.colorTemperature;
  const white = whitePoint(kelvin);
  if (usesScroller(params)) {
    return throughGel(white, gelsOf(params), levels[STROBE_CHANNELS.GEL]);
  }
  if (!mixesColour(params)) return white;
  const level = (key) => Math.min(Math.max(Number(levels[key]) || 0, 0), 100) / 100;
  return [
    white[0] * level(STROBE_CHANNELS.RED),
    white[1] * level(STROBE_CHANNELS.GREEN),
    white[2] * level(STROBE_CHANNELS.BLUE),
  ];
}

/**
 * The flood's half-angles, in radians.
 *
 * @public
 * @param {Object} params strobe parameters
 * @returns {Object} `{ h, v }`
 */
export function floodHalfAngles(params) {
  const h = Number(params.floodAngleH) || DEFAULT_STROBE_PARAMS.floodAngleH;
  const v = Number(params.floodAngleV) || DEFAULT_STROBE_PARAMS.floodAngleV;
  const clampHalf = (degrees) => (Math.min(Math.max(degrees, 1), 180) / 2) * RAD;
  return { h: clampHalf(h), v: clampHalf(v) };
}

/**
 * The solid angle the flood fills, in steradians.
 *
 * A rectangular pyramid of half-angles h and v subtends `4 asin(sin h sin v)`,
 * which is the hemisphere at 180 by 180 and closes on the small-angle product
 * below it. It is what turns lumens into candela: the same light over a wider
 * flood is dimmer in every direction.
 *
 * @public
 * @param {Object} params strobe parameters
 * @returns {Number}
 */
export function floodSolidAngle(params) {
  const { h, v } = floodHalfAngles(params);
  return 4 * Math.asin(Math.min(Math.sin(h) * Math.sin(v), 1));
}

/**
 * The lumens the lamp makes at full, from its rated power and what its kind of
 * lamp makes of a watt.
 *
 * @public
 * @param {Object} params strobe parameters
 * @returns {Number}
 */
export function lumens(params) {
  const source = params.source || DEFAULT_STROBE_PARAMS.source;
  const efficacy = EFFICACY[source] || EFFICACY[STROBE_SOURCES.LED];
  return Math.max(Number(params.power) || 0, 0) * efficacy;
}

/**
 * Whether the lamp is a flash tube, whose light comes in discharges, rather
 * than an array that shines for as long as it is on.
 *
 * @public
 * @param {Object} params strobe parameters
 * @returns {Boolean}
 */
export function isXenon(params) {
  return (params.source || DEFAULT_STROBE_PARAMS.source) === STROBE_SOURCES.XENON;
}

/**
 * The light one flash of a tube carries, in lumen-seconds.
 *
 * A flash tube's rated watts are what its supply draws on average, and every
 * joule of it leaves in the discharges: at ten flashes a second each carries a
 * tenth of a second's power, at one a second a whole second's. That is why a
 * strobe blinds where a lamp of the same watts merely lights, and why it is
 * brightest at its slowest. Below the profile's slowest rate the capacitor is
 * simply full, so the energy stops growing there.
 *
 * Nothing here says how bright a flash *looks*: that is its energy over the
 * time it is seen in, which the renderer knows and this does not.
 *
 * @public
 * @param {Object} params strobe parameters
 * @param {Number} rate flashes per second, as set
 * @returns {Number} lumen-seconds
 */
export function flashLumenSeconds(params, rate) {
  const slowest = rateRange(params).min;
  const perSecond = Math.max(Number(rate) || 0, slowest);
  return lumens(params) / Math.max(perSecond, 1e-6);
}

/**
 * The lamp's intensity in candela while held on: its lumens spread over its
 * flood.
 *
 * @public
 * @param {Object} params strobe parameters
 * @returns {Number}
 */
export function candela(params) {
  return lumens(params) / Math.max(floodSolidAngle(params), 1e-6);
}

/**
 * How much light lands on a surface square to the flood at a distance, in lux,
 * while the lamp is lit.
 *
 * The number a designer can check against a meter, and the one the create
 * dialog summarises. For reference, a bright room is a few hundred lux and
 * daylight tens of thousands; a strobe at full a few metres away is well into
 * the thousands, which is why it reads as a flash and not as a light.
 *
 * @public
 * @param {Number} distance metres
 * @param {Object} params strobe parameters
 * @returns {Number} lux, 0 if the numbers are not usable
 */
export function illuminanceAt(distance, params) {
  const d = Number(distance);
  if (!(d > 0)) return 0;
  return candela(params) / (d * d);
}

/**
 * Where the emitting face sits, in the fixture's own space, in metres.
 *
 * The origin is the centre of the body, because that is what gets placed. The
 * axes are the scene's own, exactly as a projector's: +Z up, the flood along
 * -Y (the view cube's Front), so a strobe at zero rotation stands on its feet
 * and fires horizontally. Centred on the front panel: a strobe's face is the
 * whole front of the box.
 *
 * @public
 * @param {Object} params strobe parameters
 * @returns {Object} `{ x, y, z }`
 */
export function faceOrigin(params) {
  const depth = Number(params.depth) || DEFAULT_STROBE_PARAMS.depth;
  return { x: 0, y: -(depth / 2), z: 0 };
}

/**
 * The emitting face's size, in metres, kept inside the front panel.
 *
 * @public
 * @param {Object} params strobe parameters
 * @returns {Object} `{ width, height }`
 */
export function faceSize(params) {
  const width = Math.max(Number(params.width) || DEFAULT_STROBE_PARAMS.width, 0.001);
  const height = Math.max(Number(params.height) || DEFAULT_STROBE_PARAMS.height, 0.001);
  return {
    width: Math.min(Math.max(Number(params.faceWidth) || 0, 0.001), width),
    height: Math.min(Math.max(Number(params.faceHeight) || 0, 0.001), height),
  };
}

/** The mode channel's type: one step of the range per mode, in list order. */
const MODE_TYPE = new EnumType({
  options: SHUTTER_MODE_ORDER,
  initial: SHUTTER_MODES.STROBE,
  labels: SHUTTER_MODE_LABELS,
});

/**
 * The OFL capabilities the mode channel declares: one ShutterStrobe range per
 * mode, at the ranges the type itself reads, so a patch sheet says exactly
 * what the desk has to send.
 *
 * @returns {Array}
 */
function modeCapabilities() {
  return SHUTTER_MODE_ORDER.map((mode, index) => {
    const capability = {
      dmxRange: MODE_TYPE.rangeOf(index),
      type: 'ShutterStrobe',
      shutterEffect: SHUTTER_MODE_EFFECTS[mode],
    };
    if (mode === SHUTTER_MODES.RANDOM) capability.randomTiming = true;
    return capability;
  });
}

/** A colour channel: full by default, so the three add up to white. */
const colourControl = (key, label, colour) => new ControlDef(
  key,
  label,
  new PercentType({ initial: 100 }),
  { capability: { type: 'ColorIntensity', color: colour } },
);

export const CONTROL_DEFS = [
  COMMON_CONTROLS.dimmer(),
  new ControlDef(STROBE_CHANNELS.MODE, 'Mode', MODE_TYPE, { capability: modeCapabilities }),
  // The rate and the flash length span what this model can do, so a hand-set
  // value and a driven one are in the same units and the same range.
  new ControlDef(STROBE_CHANNELS.RATE, 'Rate', new RangeType({
    bounds: rateRange, parks: 'min', precision: 1, unit: 'Hz',
  }), {
    capability: (params) => {
      const { min, max } = rateRange(params);
      return { type: 'StrobeSpeed', speedStart: `${min}Hz`, speedEnd: `${max}Hz` };
    },
  }),
  new ControlDef(STROBE_CHANNELS.DURATION, 'Duration', new RangeType({
    bounds: durationRange, parks: 'min', precision: 0, unit: 'ms',
  }), {
    capability: (params) => {
      const { min, max } = durationRange(params);
      return { type: 'StrobeDuration', durationStart: `${min}ms`, durationEnd: `${max}ms` };
    },
  }),
  colourControl(STROBE_CHANNELS.RED, 'Red', 'Red'),
  colourControl(STROBE_CHANNELS.GREEN, 'Green', 'Green'),
  colourControl(STROBE_CHANNELS.BLUE, 'Blue', 'Blue'),
  // Held on at full, whatever the mode says: the strobe used as a blinder.
  new ControlDef(STROBE_CHANNELS.BLINDER, 'Blinder', new SwitchType({
    initial: false, onLabel: 'On',
  }), { capability: { type: 'Maintenance' } }),
  // One flash on the rising edge, whatever the mode says. Never fixed: a
  // profile cannot be born mid-flash.
  new ControlDef(STROBE_CHANNELS.FLASH, 'Flash', new SwitchType({
    initial: false, onLabel: 'Fire',
  }), { fixable: false, capability: { type: 'Maintenance' } }),
];

/** Derived, so a parameter cannot be in one of these and missing from another. */
export const CHANNEL_ORDER = orderOf(CONTROL_DEFS);

/** What each channel is called on a patch sheet. */
export const CHANNEL_LABELS = labelsOf(CONTROL_DEFS);

/**
 * The two colours a scroller splits the flash into, and where the boundary
 * lies across the face; see `splitThroughGel`. One colour twice, boundary at
 * zero, for any unit without a scroller.
 *
 * @public
 * @param {Object} params strobe parameters
 * @param {Object} [levels] as `lampColour` takes them
 * @returns {Object} `{ first, second, fraction }`
 */
export function lampSplit(params, levels = {}) {
  if (usesScroller(params)) {
    const kelvin = Number(params.colorTemperature) || DEFAULT_STROBE_PARAMS.colorTemperature;
    return splitThroughGel(whitePoint(kelvin), gelsOf(params), levels[STROBE_CHANNELS.GEL]);
  }
  const colour = lampColour(params, levels);
  return { first: colour, second: colour, fraction: 0 };
}

/**
 * The controls this model actually has.
 *
 * Everything, less what its colour capability does without: a white unit has
 * no colour controls at all, an RGB unit has its three levels, a scroller has
 * one gel control in their place.
 *
 * @public
 * @param {Object} params strobe parameters
 * @returns {Array}
 */
export function controlDefsFor(params) {
  if (mixesColour(params)) return CONTROL_DEFS;
  const withoutMix = CONTROL_DEFS.filter((def) => !COLOUR_KEYS.includes(def.key));
  if (!usesScroller(params)) return withoutMix;
  // The gel sits where the colour sits: after the flash length, before the
  // blinder.
  const at = withoutMix.findIndex((def) => def.key === STROBE_CHANNELS.BLINDER);
  const gel = gelControl(STROBE_CHANNELS.GEL, 'Gel', gelsOf(params));
  return [...withoutMix.slice(0, at), gel, ...withoutMix.slice(at)];
}

/**
 * The channels this strobe declares, in OFL's vocabulary.
 *
 * @public
 * @param {Object} params strobe parameters
 * @returns {Object} `{ availableChannels, modes }`
 */
export function strobeChannels(params) {
  return ControlSet.fromProfile(controlDefsFor(params), params).buildChannels();
}

/**
 * Whether a profile was made here.
 *
 * Asked of the geometry rather than of the Strobe category, for the same
 * reason `prepare3DModelInstance` asks it of `asls.bar`: a library strobe
 * carries the category and none of these parameters.
 *
 * @public
 * @param {Object} profile
 * @returns {Boolean}
 */
export function isStrobeProfile(profile) {
  return !!(profile && profile.asls && profile.asls.strobe);
}

/**
 * Builds an OFL-shaped profile for a strobe.
 *
 * @public
 * @param {Object} [overrides] parameters replacing the defaults
 * @returns {Object} a profile the fixture parser can read
 */
export function buildStrobeProfile(overrides = {}) {
  const params = { ...DEFAULT_STROBE_PARAMS, ...overrides };
  const { availableChannels, modes } = strobeChannels(params);
  const source = params.source || DEFAULT_STROBE_PARAMS.source;

  return {
    name: `Strobe ${Number(params.power) || 0}W`,
    // OFL's own category for these, so a library strobe and a generated one
    // sit together in a list.
    categories: ['Strobe'],
    meta: { generated: true },
    physical: {
      // OFL's order is width, height, depth, in millimetres. The geometry the
      // renderer needs is in `asls.strobe`; this is for whatever reads it next.
      dimensions: [params.width * 1000, params.height * 1000, params.depth * 1000],
      power: Number(params.power) || 0,
      bulb: {
        type: source === STROBE_SOURCES.XENON ? 'Xenon flash tube' : 'LED',
        colorTemperature: Number(params.colorTemperature) || DEFAULT_STROBE_PARAMS.colorTemperature,
      },
      // The flood, narrowest first, in the shape `physical.lens` uses.
      lens: {
        degreesMinMax: [
          Math.min(params.floodAngleH, params.floodAngleV),
          Math.max(params.floodAngleH, params.floodAngleV),
        ],
      },
    },
    availableChannels,
    modes,
    // Everything OFL cannot express: the lamp, the flood, the box, and how
    // each control is decided.
    asls: { strobe: params },
  };
}

export default {
  CONTROL_DEFS,
  STROBE_CHANNELS,
  STROBE_SOURCES,
  STROBE_COLOURS,
  COLOURS_FOR_SOURCE,
  CHANNEL_ORDER,
  CHANNEL_LABELS,
  DEFAULT_STROBE_PARAMS,
  buildStrobeProfile,
  strobeChannels,
  controlDefsFor,
  isStrobeProfile,
  rateRange,
  durationRange,
  colourOf,
  mixesColour,
  usesScroller,
  gelsOf,
  lampColour,
  lampSplit,
  floodHalfAngles,
  floodSolidAngle,
  lumens,
  isXenon,
  flashLumenSeconds,
  candela,
  illuminanceAt,
  faceOrigin,
  faceSize,
};
