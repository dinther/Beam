import DeviceSettings, { FULL } from './device_settings';
import { ControlDef, PercentType } from './device_control';
import {
  PROJECTOR_CHANNELS, CONTROL_DEFS, throwRange,
} from './generic/projector';

/**
 * @file What one projector is set to.
 *
 * What a projector's parameters *are* -- a lens that zooms, optics that shift --
 * is declared once in `generic/projector.js`. The rule that decides who owns
 * each of them lives in `device_settings.js` and is shared with every other
 * device. What is left here is the install: the soft-edge blend, which belongs
 * to where the machine was put rather than to the machine.
 *
 * The profile says what the *model* can do. This says where inside that
 * envelope this particular machine is set. Same split as an LED bar, whose
 * profile says "60 pixels, GRB" while the placement says where it stands and
 * what address it answers to.
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
 * The soft-edge blend, per edge, as a percentage of the image.
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

/**
 * The blend edges, as parameters.
 *
 * **Not addressable, and deliberately:** a blend width is a property of where
 * the machine was installed and what it overlaps, not of the machine. Two
 * projectors covering one facade are set up once and left; nothing on a console
 * wants to ride them, and giving them channels would put four rows in a patch
 * that no desk would ever address.
 *
 * Per edge rather than one number, because the end machine of an array blends
 * on its inner edge only -- ramping both would darken the outside of the
 * picture against nothing.
 *
 * @constant {Array}
 */
const BLEND_DEFS = Object.entries({
  [PROJECTOR_BLEND.LEFT]: 'Blend Left',
  [PROJECTOR_BLEND.RIGHT]: 'Blend Right',
  [PROJECTOR_BLEND.TOP]: 'Blend Top',
  [PROJECTOR_BLEND.BOTTOM]: 'Blend Bottom',
}).map(([key, label]) => new ControlDef(
  key,
  label,
  new PercentType({ initial: 0, max: MAX_BLEND }),
  { addressable: false },
));

/** Every attribute a projector holds: what a desk may drive, plus the install. */
export const PROJECTOR_DEFS = [...CONTROL_DEFS, ...BLEND_DEFS];

class ProjectorSettings extends DeviceSettings {
  /**
   * @param {Object} params the profile's `asls.projector` -- the envelope
   * @param {Object} [data] stored values from the show
   */
  constructor(params, data = {}) {
    super(PROJECTOR_DEFS, params, data);
  }

  /** How far the optics may shift, as a percentage of the image. */
  get shiftLimitH() { return Math.abs(Number(this._params.shiftLimitH) || 0); }

  get shiftLimitV() { return Math.abs(Number(this._params.shiftLimitV) || 0); }

  /** The zoom range the profile allows. */
  get range() { return throwRange(this._params); }

  /** Whether this model's lens zooms at all, or is a prime. */
  get zooms() {
    const { min, max } = this.range;
    return max - min > 1e-9;
  }

  /**
   * What to multiply the projector's lumens by: the dimmer, gated by the
   * shutter. A closed dowser is nothing on the wall, not a dark picture.
   *
   * @readonly
   * @type {Number}
   */
  get gain() {
    if (!this.value('shutter')) return 0;
    return Math.min(Math.max(Number(this.value('dimmer')) || 0, 0), FULL) / FULL;
  }
}

export default ProjectorSettings;
