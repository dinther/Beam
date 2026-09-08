import DeviceSettings, { COMMON_ATTRIBUTES, clamp, FULL } from './device_settings';
import { LASER_CHANNELS, CHANNEL_ORDER } from './generic/laser';

/**
 * @file What one laser is set to.
 *
 * The rule -- stored values, with a declared channel taking one over -- lives in
 * `device_settings.js` and is shared with every device that has both hand-set
 * values and optional DMX. What is here is only what makes a laser a laser: an
 * output stage the fixture lays over the DAC's point stream.
 *
 * **The picture comes from the stream; this only corrects it.** The DAC decides
 * every position and colour; the fixture then dims it, blanks it, balances its
 * colours, and scales and offsets its geometry so a figure sized for one rig
 * lands on another without touching the content. Each of those is hand-set
 * until the profile declares a channel for it, at which point a desk drives it
 * in the same units -- the projector's bargain exactly.
 *
 * `source` -- which DAC stream this laser shows -- is here too, but never a
 * channel: it is set by hand, the video equivalent of choosing which cable is
 * plugged in, not something a console rides.
 */

/**
 * The attributes a laser carries, keyed exactly as its channels are.
 *
 * One vocabulary, so a channel called `red` drives the attribute called `red`
 * with no table in between -- the same discipline as the projector.
 *
 * @constant {Object}
 */
export const LASER_ATTRIBUTES = LASER_CHANNELS;

/**
 * A 0-100 % attribute that sits at full unless driven down: the master and the
 * three colour balances. DMX maps the full byte across 0-100 %.
 *
 * @constant {Object}
 */
const balance = {
  initial: () => FULL,
  coerce: (value) => clamp(value, 0, FULL, FULL),
  fromLevel: (level) => clamp(level, 0, 1, 1) * FULL,
};

/**
 * A 0-100 % scale, native by default.
 *
 * A galvo cannot deflect past its own maximum, so a laser can only be scaled
 * *down* from full scan -- 100 % is as large as the picture gets. DMX maps the
 * byte across 0-100 %.
 *
 * @constant {Object}
 */
const scale = {
  initial: () => FULL,
  coerce: (value) => clamp(value, 0, FULL, FULL),
  fromLevel: (level) => clamp(level, 0, 1, 1) * FULL,
};

/**
 * A -100..+100 % offset, centred by default.
 *
 * Moves the figure within the scan field. DMX centres at 128, so a console left
 * at half scale leaves the picture where the stream put it -- the same
 * convention as the projector's lens shift.
 *
 * @constant {Object}
 */
const offset = {
  initial: () => 0,
  coerce: (value) => clamp(value, -FULL, FULL, 0),
  fromLevel: (level) => (clamp(level, 0, 1, 0.5) * 2 - 1) * FULL,
};

/**
 * A mounting flip: off by default, on above half.
 *
 * Turning the field over rather than moving it, so a laser hung upside down or
 * bounced off a mirror shows its content the right way round without the
 * content being re-authored. Boolean like the shutter, and drivable, because a
 * console may want to flip a whole rig at once.
 *
 * @constant {Object}
 */
const mirror = {
  initial: () => false,
  coerce: (value) => !!value,
  fromLevel: (level) => level >= 0.5,
};

/**
 * What a laser can be told to do.
 *
 * @constant {Object}
 */
export const LASER_SPEC = {
  [LASER_ATTRIBUTES.DIMMER]: COMMON_ATTRIBUTES.dimmer,
  [LASER_ATTRIBUTES.SHUTTER]: COMMON_ATTRIBUTES.shutter,
  [LASER_ATTRIBUTES.RED]: balance,
  [LASER_ATTRIBUTES.GREEN]: balance,
  [LASER_ATTRIBUTES.BLUE]: balance,
  [LASER_ATTRIBUTES.X_SCALE]: scale,
  [LASER_ATTRIBUTES.Y_SCALE]: scale,
  [LASER_ATTRIBUTES.X_POS]: offset,
  [LASER_ATTRIBUTES.Y_POS]: offset,
  [LASER_ATTRIBUTES.MIRROR_X]: mirror,
  [LASER_ATTRIBUTES.MIRROR_Y]: mirror,
  // In the spec but not in CHANNEL_ORDER, so it is never driven: a hand-set
  // choice of which DAC stream to show. Same shape as the projector's source
  // (an id by hand), minus the one-based DMX reading it will never get.
  source: COMMON_ATTRIBUTES.source,
};

class LaserSettings extends DeviceSettings {
  /**
   * @param {Object} params the profile's `asls.laser` -- the envelope
   * @param {Object} [data] stored values from the show
   */
  constructor(params, data = {}) {
    super(LASER_SPEC, params, data, CHANNEL_ORDER);
  }

  /**
   * The combined intensity to multiply the streamed colours by, 0..1.
   *
   * Dimmer times the shutter: a closed shutter is nothing on the wall, not a
   * dark picture. The renderer reads this once per frame rather than working it
   * out itself, the way the projector reads its `gain`.
   *
   * @readonly
   * @type {Number}
   */
  get gain() {
    if (!this.value('shutter')) return 0;
    return clamp(this.value('dimmer'), 0, FULL, FULL) / FULL;
  }
}

export default LaserSettings;
