import DeviceSettings, { FULL } from './device_settings';
import { clamp } from './device_control';
import {
  STROBE_CHANNELS, controlDefsFor, lampColour, lampSplit, rateRange, durationRange, mixesColour,
  usesScroller, gelsOf, colourOf,
} from './generic/strobe';
import { frameName } from './generic/gel_string';
import { SHUTTER_MODES } from '../../plugins/visualizer/shutter';

/**
 * @file What one strobe is set to.
 *
 * What a strobe's controls *are* is declared once in `generic/strobe.js`, and
 * the rule that decides who owns each of them lives in `device_settings.js`.
 * What is left here is what the renderer asks each frame, answered in one
 * place beside the values it reads so the two cannot drift: how bright, what
 * colour, and how the shutter is to run.
 */

/**
 * The attributes a strobe carries, keyed exactly as its channels are.
 *
 * @constant {Object}
 */
export const STROBE_ATTRIBUTES = STROBE_CHANNELS;

class StrobeSettings extends DeviceSettings {
  /**
   * @param {Object} params the profile's `asls.strobe` -- the envelope
   * @param {Object} [data] stored values from the show
   */
  constructor(params, data = {}) {
    // The model's own controls: a white unit has no colour channels, so none
    // are held for it and a byte addressed to one goes nowhere.
    super(controlDefsFor(params || {}), params, data);
  }

  /** Whether this model mixes colour from three emitters. */
  get mixesColour() { return mixesColour(this._params); }

  /** Whether this model colours a white lamp through a gel scroller. */
  get usesScroller() { return usesScroller(this._params); }

  /** The colour capability this model really has; see `colourOf`. */
  get colourMode() { return colourOf(this._params); }

  /** The scroller's gel string, in order. */
  get gels() { return gelsOf(this._params); }

  /** The scroller's position, 1 to the string's length; 1 without one. */
  get gelPosition() { return Number(this.value(STROBE_CHANNELS.GEL)) || 1; }

  /** What is in front of the lamp, in words: one gel, or two across a split. */
  get gelName() {
    return this.usesScroller ? frameName(this.gels, this.gelPosition) : '';
  }

  /**
   * The two colours the flash is split into and where the boundary lies,
   * for a renderer that can draw both halves. See `lampSplit`.
   *
   * @readonly
   * @type {Object} `{ first, second, fraction }`
   */
  get lampSplit() {
    return lampSplit(this._params, {
      red: this.value(STROBE_CHANNELS.RED),
      green: this.value(STROBE_CHANNELS.GREEN),
      blue: this.value(STROBE_CHANNELS.BLUE),
      gel: this.value(STROBE_CHANNELS.GEL),
    });
  }

  /** The rates the profile allows, in hertz. */
  get rateRange() { return rateRange(this._params); }

  /** The flash lengths the profile allows, in milliseconds. */
  get durationRange() { return durationRange(this._params); }

  /**
   * What to multiply the lamp's output by: the dimmer, 0..1.
   *
   * @readonly
   * @type {Number}
   */
  get gain() {
    return clamp(Number(this.value(STROBE_CHANNELS.DIMMER)), 0, FULL, FULL) / FULL;
  }

  /**
   * The colour the lamp flashes at full, as linear RGB.
   *
   * @readonly
   * @type {Array} `[r, g, b]`
   */
  get lamp() {
    return lampColour(this._params, {
      red: this.value(STROBE_CHANNELS.RED),
      green: this.value(STROBE_CHANNELS.GREEN),
      blue: this.value(STROBE_CHANNELS.BLUE),
      gel: this.value(STROBE_CHANNELS.GEL),
    });
  }

  /**
   * How the shutter is to run: the mode channel, unless the blinder holds the
   * lamp on over the top of it.
   *
   * @readonly
   * @type {String} one of the shutter modes
   */
  get shutterMode() {
    if (this.value(STROBE_CHANNELS.BLINDER)) return SHUTTER_MODES.ON;
    return this.value(STROBE_CHANNELS.MODE) || SHUTTER_MODES.OFF;
  }

  /** Flashes per second, as set. */
  get rate() { return Number(this.value(STROBE_CHANNELS.RATE)) || 0; }

  /** Flash length in milliseconds, as set. */
  get duration() { return Number(this.value(STROBE_CHANNELS.DURATION)) || 0; }

  /** Whether the flash trigger is currently held. */
  get flashHeld() { return !!this.value(STROBE_CHANNELS.FLASH); }
}

export default StrobeSettings;
