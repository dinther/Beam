import DeviceSettings from './device_settings';
import { DISPLAY_CHANNELS, CONTROL_DEFS } from './generic/display';

/**
 * @file What one display is set to.
 *
 * Nothing here but the wiring: what a display's parameters *are* is declared
 * once in `generic/display.js`, and the rule -- parked values, with a declared
 * channel taking one over -- lives in `device_settings.js`. A screen has no
 * lens, so unlike a projector it adds nothing of its own.
 *
 * That is the point of the split. If a display needed its own copy of the
 * override rule to say this little, the rule would be in the wrong place.
 */

/**
 * The attributes a display carries, keyed exactly as its channels are.
 *
 * @constant {Object}
 */
export const DISPLAY_ATTRIBUTES = DISPLAY_CHANNELS;

class DisplaySettings extends DeviceSettings {
  /**
   * @param {Object} params the profile's `asls.display` -- the envelope
   * @param {Object} [data] stored values from the show
   */
  constructor(params, data = {}) {
    super(CONTROL_DEFS, params, data);
  }
}

export default DisplaySettings;
