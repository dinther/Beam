import DeviceSettings, { COMMON_ATTRIBUTES, clamp } from './device_settings';
import {
  PROJECTOR_CHANNELS, CHANNEL_ORDER, throwRange, clampThrow,
} from './generic/projector';

/**
 * @file What one projector is set to.
 *
 * The rule -- stored values, with a declared channel taking one over -- lives in
 * `device_settings.js` and is shared with every other device that has both
 * hand-set values and optional DMX. What is here is only what makes a
 * projector a projector: a lens that zooms and optics that shift.
 *
 * The profile says what the *model* can do -- its zoom range, how far the
 * optics may shift, which channels it has. This says where inside that envelope
 * this particular machine is set. Same split as an LED bar, whose profile says
 * "60 pixels, GRB" while the placement says where it stands and what address it
 * answers to.
 *
 * **The units are the same whether a value is typed or driven**, because the
 * profile defines the range both are expressed in. Patching a projector
 * therefore never changes what it is currently doing.
 */

/**
 * The attributes a projector carries, keyed exactly as its channels are.
 *
 * One vocabulary rather than two: a channel called `dimmer` drives the
 * attribute called `dimmer`, so nothing has to translate between them and
 * there is no table to fall out of step.
 *
 * @constant {Object}
 */
export const PROJECTOR_ATTRIBUTES = PROJECTOR_CHANNELS;

/**
 * How far the optics may shift, as a percentage of the image.
 *
 * @param {Object} params
 * @param {String} axis 'H' or 'V'
 * @returns {Number}
 */
function shiftLimit(params, axis) {
  return Math.abs(Number(params[`shiftLimit${axis}`]) || 0);
}

/**
 * What a projector can be told to do.
 *
 * @constant {Object}
 */
/**
 * The soft-edge blend, per edge, as a percentage of the image.
 *
 * Not channels, and deliberately: a blend width is a property of where the
 * machine was installed and what it overlaps, not of the machine. Two
 * projectors covering one facade are set up once and left; nothing on a console
 * wants to ride them, and giving them channels would put four rows in a patch
 * that no desk would ever address.
 *
 * Per edge rather than one number, because the end machine of an array blends
 * on its inner edge only -- ramping both would darken the outside of the
 * picture against nothing.
 *
 * @constant {Object}
 */
export const PROJECTOR_BLEND = {
  LEFT: 'blendLeft',
  RIGHT: 'blendRight',
  TOP: 'blendTop',
  BOTTOM: 'blendBottom',
};

/** A blend wider than this is not a blend, it is a dissolve. */
const MAX_BLEND = 45;

const blendEdge = {
  initial: () => 0,
  coerce: (value) => clamp(value, 0, MAX_BLEND, 0),
};

export const PROJECTOR_SPEC = {
  [PROJECTOR_BLEND.LEFT]: blendEdge,
  [PROJECTOR_BLEND.RIGHT]: blendEdge,
  [PROJECTOR_BLEND.TOP]: blendEdge,
  [PROJECTOR_BLEND.BOTTOM]: blendEdge,
  // Parked at the wide end, which is where a lens sits until someone has a
  // reason to narrow it, and the end the frustum is drawn at.
  [PROJECTOR_ATTRIBUTES.ZOOM]: {
    initial: (params) => throwRange(params).min,
    coerce: (value, params) => clampThrow(params, value),
    // DMX 0 is the *narrow* end, because the capability writes the narrowest
    // angle as its start -- and a narrow angle is a long throw ratio. So the
    // ratio runs from max down to min, not the other way about. Backwards
    // inverts every projector's zoom, invisibly.
    fromDmx: (dmx, params) => {
      const { min, max } = throwRange(params);
      const level = Math.min(Math.max(Number(dmx) || 0, 0), 255) / 255;
      return max + (min - max) * level;
    },
  },
  // Centred at half scale, so a console sitting at 128 leaves the image where
  // the optics put it.
  [PROJECTOR_ATTRIBUTES.SHIFT_H]: {
    initial: () => 0,
    coerce: (value, params) => clamp(value, -shiftLimit(params, 'H'), shiftLimit(params, 'H'), 0),
    fromDmx: (dmx, params) => {
      const level = Math.min(Math.max(Number(dmx) || 0, 0), 255) / 255;
      return (level * 2 - 1) * shiftLimit(params, 'H');
    },
  },
  [PROJECTOR_ATTRIBUTES.SHIFT_V]: {
    initial: () => 0,
    coerce: (value, params) => clamp(value, -shiftLimit(params, 'V'), shiftLimit(params, 'V'), 0),
    fromDmx: (dmx, params) => {
      const level = Math.min(Math.max(Number(dmx) || 0, 0), 255) / 255;
      return (level * 2 - 1) * shiftLimit(params, 'V');
    },
  },
  [PROJECTOR_ATTRIBUTES.SOURCE]: COMMON_ATTRIBUTES.source,
  [PROJECTOR_ATTRIBUTES.DIMMER]: COMMON_ATTRIBUTES.dimmer,
  [PROJECTOR_ATTRIBUTES.SHUTTER]: COMMON_ATTRIBUTES.shutter,
};

class ProjectorSettings extends DeviceSettings {
  /**
   * @param {Object} params the profile's `asls.projector` -- the envelope
   * @param {Object} [data] stored values from the show
   */
  constructor(params, data = {}) {
    super(PROJECTOR_SPEC, CHANNEL_ORDER, params, data);
  }

  /** How far the optics may shift, as a percentage of the image. */
  get shiftLimitH() { return shiftLimit(this._params, 'H'); }

  get shiftLimitV() { return shiftLimit(this._params, 'V'); }

  /** The zoom range the profile allows. */
  get range() { return throwRange(this._params); }

  /** Whether this model's lens zooms at all, or is a prime. */
  get zooms() {
    const { min, max } = this.range;
    return max - min > 1e-9;
  }
}

export default ProjectorSettings;
