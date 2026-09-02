import DeviceSettings, { COMMON_ATTRIBUTES } from './device_settings';
import { DISPLAY_CHANNELS, CHANNEL_ORDER } from './generic/display';

/**
 * @file What one display is set to.
 *
 * Nothing here but the spec: the rule -- stored values, with a declared channel
 * taking one over -- lives in `device_settings.js`, and a display's three
 * attributes are the ones every video device shares. A screen has no lens, so
 * unlike a projector it adds nothing of its own.
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

/**
 * What a display can be told to do.
 *
 * @constant {Object}
 */
export const DISPLAY_SPEC = {
  [DISPLAY_ATTRIBUTES.DIMMER]: COMMON_ATTRIBUTES.dimmer,
  [DISPLAY_ATTRIBUTES.SHUTTER]: COMMON_ATTRIBUTES.shutter,
  [DISPLAY_ATTRIBUTES.SOURCE]: COMMON_ATTRIBUTES.source,
};

class DisplaySettings extends DeviceSettings {
  /**
   * @param {Object} params the profile's `asls.display` -- the envelope
   * @param {Object} [data] stored values from the show
   */
  constructor(params, data = {}) {
    super(DISPLAY_SPEC, CHANNEL_ORDER, params, data);
  }
}

export default DisplaySettings;
