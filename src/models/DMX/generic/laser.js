/**
 * @file Generic RGB show laser: a galvo-steered pencil beam fed a point stream.
 *
 * The same argument as the generic bar and projector -- thousands of models,
 * no library will carry them all -- so a laser is described here from the
 * handful of numbers that actually characterise one, rather than fetched.
 *
 * Like `led_bar.js` and `projector.js`, the generated document is OFL-shaped so
 * `Fixture` reads it through the same path as a library profile, and everything
 * OFL cannot express lives under `asls.laser`.
 *
 * **A laser is not driven over DMX; it is driven by a point stream.** The picture
 * -- every position and colour -- arrives from a DAC (Ether Dream or LaserCube,
 * see `src/electron/etherdream.js` / `lasercube.js`), the same way a display is
 * fed a video connector rather than pixel channels. So, like a projector, a
 * laser may carry no DMX at all, and what it is *doing* -- which stream it
 * shows, its master level -- belongs to the placement, not the profile. The
 * profile only says what the machine is: its optical power, how wide it can
 * scan, and how fine its beam is.
 *
 * The geometry here is the part the renderer stands on. A galvo pair maps the
 * DAC's signed full-scale X/Y onto a pair of deflection angles, so a point at
 * full scale leaves the aperture at `scanAngle / 2` off the axis; the renderer
 * turns each streamed point into a ray from those two angles. Beam width and
 * divergence set how thick that ray is drawn and how it grows with distance.
 */
import { COMMON_CONTROLS } from '../device_settings';
import {
  ControlSet, ControlDef, PercentType, SwitchType, orderOf, labelsOf,
} from '../device_control';

/** Radians to degrees, and back, for the scan-angle maths below. */
const DEG = 180 / Math.PI;

/**
 * The channels a laser may expose over DMX.
 *
 * **The picture is never on DMX** -- every position and colour is in the point
 * stream from the DAC, and a channel that set them would fight it. What a desk
 * *can* drive is an output stage the fixture applies over the stream: a master
 * dimmer and a blanking shutter, a per-colour balance, and a geometric
 * correction -- scale and offset in each axis, to size and place the figure on
 * the rig without editing the content. `source` -- which DAC stream a laser
 * shows -- is deliberately not here: it is set by hand, like patching a cable,
 * not ridden from a console.
 *
 * Keys, not labels, because they are stored in the profile and must survive a
 * relabelling.
 *
 * @constant {Object}
 */
export const LASER_CHANNELS = {
  DIMMER: 'dimmer',
  SHUTTER: 'shutter',
  RED: 'red',
  GREEN: 'green',
  BLUE: 'blue',
  X_SCALE: 'xScale',
  Y_SCALE: 'yScale',
  X_POS: 'xPos',
  Y_POS: 'yPos',
  MIRROR_X: 'mirrorX',
  MIRROR_Y: 'mirrorY',
};

/**
 * The order channels are laid out in when a laser declares several.
 *
 * Fixed here rather than following the order they were ticked, so two lasers
 * with the same channels always address alike -- see `projector.js` for why
 * that matters on a patch sheet. Intensity first, then colour, then geometry,
 * which is the order a desk tech expects to find them in.
 *
 * @constant {Array}
 */
/**
 * Sits at full unless driven down: the master and the three colour balances.
 *
 * @returns {PercentType}
 */
const atFull = () => new PercentType({ initial: 100 });

/**
 * A galvo cannot deflect past its own maximum, so a laser can only be scaled
 * *down* from full scan -- 100 % is as large as the picture gets.
 *
 * @returns {PercentType}
 */
const scale = () => new PercentType({ initial: 100 });

/**
 * A -100..+100 % offset, centred by default: moves the figure within the scan
 * field, the same convention as the projector's lens shift.
 *
 * @returns {PercentType}
 */
const offset = () => new PercentType({ initial: 0, limit: () => 100 });

/**
 * A mounting flip: off by default.
 *
 * Turning the field over rather than moving it, so a laser hung upside down or
 * bounced off a mirror shows its content the right way round without the
 * content being re-authored. Drivable, because a console may want to flip a
 * whole rig at once.
 *
 * @returns {SwitchType}
 */
const mirror = () => new SwitchType({ initial: false, onLabel: 'Flipped' });

export const CONTROL_DEFS = [
  COMMON_CONTROLS.dimmer(),
  COMMON_CONTROLS.shutter('Shutter', 'Open'),
  new ControlDef(LASER_CHANNELS.RED, 'Red Balance', atFull()),
  new ControlDef(LASER_CHANNELS.GREEN, 'Green Balance', atFull()),
  new ControlDef(LASER_CHANNELS.BLUE, 'Blue Balance', atFull()),
  new ControlDef(LASER_CHANNELS.X_SCALE, 'X Scale', scale()),
  new ControlDef(LASER_CHANNELS.Y_SCALE, 'Y Scale', scale()),
  new ControlDef(LASER_CHANNELS.X_POS, 'X Position', offset()),
  new ControlDef(LASER_CHANNELS.Y_POS, 'Y Position', offset()),
  new ControlDef(LASER_CHANNELS.MIRROR_X, 'Mirror X', mirror()),
  new ControlDef(LASER_CHANNELS.MIRROR_Y, 'Mirror Y', mirror()),
];

/** Derived, so a parameter cannot be in one of these and missing from another. */
export const CHANNEL_ORDER = orderOf(CONTROL_DEFS);

/** What each channel is called on a patch sheet. */
export const CHANNEL_LABELS = labelsOf(CONTROL_DEFS);

/**
 * A mid-sized RGB show laser: a few watts, a wide scan, a fine beam.
 *
 * Real numbers off a real class of machine rather than round ones, so the first
 * laser anyone makes behaves like a laser. Lengths are metres; angles degrees;
 * the beam is in millimetres and its divergence in milliradians, as the trade
 * quotes them.
 *
 * @constant {Object}
 */
export const DEFAULT_LASER_PARAMS = {
  /**
   * Total optical power, in watts.
   *
   * The brightness anchor: dwell over area times this is what a swept beam
   * lands on the air and on a surface. Worth entering honestly -- a 5 W machine
   * is drawn far brighter than a 1 W one, because nothing here normalises it
   * away. RGB show lasers run roughly 1-10 W.
   */
  power: 5,
  /**
   * The full galvo scan angle, in degrees, horizontal and vertical.
   *
   * The optical deflection at the DAC's full scale: a point at +full-scale X
   * leaves the aperture at `scanAngleH / 2` to one side. 40-60 degrees is the
   * usual range; a wider scanner throws a bigger picture at the same distance,
   * exactly as a wider lens does on a projector.
   */
  scanAngleH: 50,
  scanAngleV: 50,
  /**
   * The beam at the aperture, in millimetres, and how fast it grows.
   *
   * `beamDiameter` is how wide the pencil is where it leaves the machine;
   * `divergence` (milliradians, full angle) is how much it opens with distance
   * -- 1 mrad is about 2 cm added over 20 m. Together they set how thick a beam
   * is drawn, which the minimum-width rule then never lets fall below a pixel.
   */
  beamDiameter: 3,
  divergence: 1,
  /**
   * The highest point rate the machine can scan, in points per second.
   *
   * Informational for the profile -- the DAC and the stream decide the real
   * rate -- but it is the number a laser is sold on (ILDA @ 30k), and it bounds
   * how much of a frame can be lit at once.
   */
  maxPointRate: 30000,
  /**
   * The body, in metres: a box, measured as it stands facing you. "Depth"
   * rather than "length", which says nothing for a box -- see `projector.js`.
   */
  width: 0.30,
  height: 0.16,
  depth: 0.34,
  /**
   * Where the aperture sits on the front panel, in metres from its centre.
   *
   * Same convention and same settled sign rule as a projector's lens: measured
   * facing the front of the machine, positive right and up, neither negated in
   * the renderer, because the beam leaves along -Y with +Z up. See
   * `projector.js` `lensOrigin`.
   */
  apertureX: 0,
  apertureY: 0,
  /** The aperture opening, in metres, drawn on the front panel. */
  apertureDiameter: 0.03,
  /**
   * How each controllable parameter is decided, keyed as the attributes are.
   *
   * `{ key: { mode, value, channel, bits } }` -- mode 'fixed' | 'adjustable' |
   * 'dmx'. **Empty by default**, which reads as every parameter adjustable:
   * most show lasers carry no DMX, and a hand-set output stage is the honest
   * starting point. The create dialog fills this in; see `device_settings.js`.
   */
  controls: {},
};

/**
 * Where the aperture sits, in the fixture's own space, in metres.
 *
 * The origin is the centre of the body -- that is what gets placed -- and the
 * beam leaves from the front face wherever the maker put the aperture. The
 * axes are the scene's own, exactly as a projector's: +Z up, the beam along
 * -Y (the view cube's Front), so a laser at zero rotation stands on its feet
 * and fires horizontally rather than at the ceiling.
 *
 * @public
 * @param {Object} params laser parameters
 * @returns {Object} `{ x, y, z }` -- x across, y forward (negative), z up
 */
export function apertureOrigin(params) {
  const depth = Number(params.depth) || DEFAULT_LASER_PARAMS.depth;
  return {
    x: Number(params.apertureX) || 0,
    y: -(depth / 2),
    z: Number(params.apertureY) || 0,
  };
}

/**
 * The scan half-angles, in radians, that the DAC's full scale maps to.
 *
 * The whole of a galvo's geometry: a streamed point's normalised position
 * (-1..1 in each axis) times these is the ray's angle off the aperture axis.
 * Half, because a point at full scale sits at half the *full* scan angle either
 * side of centre.
 *
 * @public
 * @param {Object} params laser parameters
 * @returns {Object} `{ h, v }` half-angles in radians
 */
export function scanHalfAngles(params) {
  const h = Number(params.scanAngleH) || DEFAULT_LASER_PARAMS.scanAngleH;
  const v = Number(params.scanAngleV) || DEFAULT_LASER_PARAMS.scanAngleV;
  return { h: (h / 2) / DEG, v: (v / 2) / DEG };
}

/**
 * How wide the beam is at a given distance, in metres.
 *
 * The aperture width plus what the divergence has opened over the distance --
 * the floor the renderer draws a beam at before the screen-space minimum takes
 * over. Divergence is a full angle in milliradians, so the added diameter is
 * `distance * divergence / 1000`.
 *
 * @public
 * @param {Number} distance metres from the aperture
 * @param {Object} params laser parameters
 * @returns {Number} beam diameter in metres
 */
export function beamWidthAt(distance, params) {
  const base = (Number(params.beamDiameter) || 0) / 1000;
  const div = (Number(params.divergence) || 0) / 1000;
  return base + Math.max(0, Number(distance) || 0) * div;
}

/**
 * The image a full-scale scan makes at a given distance, in metres.
 *
 * The readout that answers the only question anyone aiming a laser has: how big
 * is the picture there. Width and height from the two scan angles.
 *
 * @public
 * @param {Number} distance metres to the surface, along the axis
 * @param {Object} params laser parameters
 * @returns {Object} `{ width, height }` in metres
 */
export function imageSizeAt(distance, params) {
  const d = Math.max(0, Number(distance) || 0);
  const { h, v } = scanHalfAngles(params);
  return { width: 2 * d * Math.tan(h), height: 2 * d * Math.tan(v) };
}

/**
 * Whether a profile was made here.
 *
 * Asked of the geometry rather than a category, for the same reason
 * `prepare3DModelInstance` asks it of `asls.bar` and `asls.projector`.
 *
 * @public
 * @param {Object} profile
 * @returns {Boolean}
 */
export function isLaserProfile(profile) {
  return !!(profile && profile.asls && profile.asls.laser);
}

/**
 * Builds an OFL-shaped profile for a laser.
 *
 * @public
 * @param {Object} [overrides] parameters replacing the defaults
 * @returns {Object} a profile the fixture parser can read
 */
export function buildLaserProfile(overrides = {}) {
  const params = { ...DEFAULT_LASER_PARAMS, ...overrides };
  const { availableChannels, modes } = ControlSet.fromProfile(CONTROL_DEFS, params).buildChannels();

  return {
    name: `Laser ${Number(params.power) || 0}W`,
    // OFL's catch-all: it has no laser category, and inventing one would put a
    // word in the fixture list no library profile can match.
    categories: ['Other'],
    meta: { generated: true },
    physical: {
      // OFL's order is width, height, depth, in millimetres. Nothing reads it
      // -- the geometry the renderer needs is in `asls.laser` -- but a profile
      // stating its size wrongly is a trap for whatever reads it next.
      dimensions: [params.width * 1000, params.height * 1000, params.depth * 1000],
      bulb: { type: 'Laser' },
      // The full scan angle, widest first, in the shape `physical.lens` uses.
      // A laser has no lens, but the field is where anything already reading a
      // fixture's angular spread will look.
      lens: {
        degreesMinMax: [
          Math.max(params.scanAngleH, params.scanAngleV),
          Math.max(params.scanAngleH, params.scanAngleV),
        ],
      },
    },
    availableChannels,
    modes,
    // Everything OFL cannot express: the optics, the box, the scan and beam,
    // and which channels this model actually has.
    asls: { laser: params },
  };
}

export default {
  CONTROL_DEFS,
  LASER_CHANNELS,
  CHANNEL_ORDER,
  CHANNEL_LABELS,
  DEFAULT_LASER_PARAMS,
  buildLaserProfile,
  isLaserProfile,
  apertureOrigin,
  scanHalfAngles,
  beamWidthAt,
  imageSizeAt,
};
