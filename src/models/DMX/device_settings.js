/* eslint-disable no-bitwise */
// Assembling a 16- or 24-bit value from its DMX bytes is the subject matter
// here; the shifts and masks are the clearest way to write it.
/**
 * @file What one device is currently doing, and who decides it.
 *
 * A generic fixture's parameters are declared once, as {@link ControlDef}s, in
 * the file that defines the kind -- see `device_control.js` for what a
 * parameter *is*. This file is the other half: what one *placed* machine is
 * currently set to, given those declarations and whatever the wire is saying.
 *
 * One panel and one rule serve all three modes, and nothing about the panel
 * changes shape when a fixture is patched. Three consequences, each easy to get
 * wrong:
 *
 * - **Ownership is asked of the definition, not of whether a frame has landed.**
 *   A row that became editable whenever a console paused would be a race.
 * - **A live value is held, not cleared.** When DMX stops the last value
 *   stands: a dropped frame must not snap the rig to a parked default, and
 *   there is no telling a stopped console from a slow one.
 * - **Only non-fixed values travel in the show.** A fixed value lives in the
 *   profile; what DMX is saying is a fact about one machine at one moment.
 */

import {
  ControlSet, ControlDef, PercentType, SwitchType, ChoiceType, clamp, BIT_DEPTHS,
} from './device_control';

export {
  clamp, BIT_DEPTHS, ControlSet, ControlDef,
};

/** Percent, for the attributes measured in it. */
export const FULL = 100;

/** Above this fraction a shutter reads as open. Half scale, the usual place. */
export const SHUTTER_OPEN_AT = 0.5;

/**
 * The parameters most video devices share, so a kind that wants an ordinary
 * dimmer does not describe one again.
 *
 * These are factories rather than shared instances because a definition carries
 * its own label -- a display's blade is called Blank where a projector's is
 * called Shutter, and a laser's Source picks a DAC stream where a projector's
 * picks a video connector.
 */
export const COMMON_CONTROLS = {
  /** 0-100 %, full by default -- a device nobody has dimmed is on. */
  dimmer: (label = 'Dimmer') => new ControlDef('dimmer', label, new PercentType({ initial: FULL }), {
    capability: { type: 'Intensity', brightnessStart: '0%', brightnessEnd: '100%' },
  }),
  /** Open or shut. A dowser is a blade, not a fader. */
  shutter: (label = 'Shutter', onLabel = 'Open') => new ControlDef('shutter', label, new SwitchType({ initial: true, onLabel }), {
    capability: { type: 'ShutterStrobe', shutterEffect: 'Open' },
  }),
  /**
   * Which feed, as an **id** when set by hand and a **one-based position** when
   * driven -- see {@link ChoiceType}.
   */
  source: (label = 'Source Select', source = 'connectors') => new ControlDef('source', label, new ChoiceType({ source }), { fixable: false }),
};

class DeviceSettings {
  /**
   * @param {Array} defs the kind's parameter declarations, in addressing order
   * @param {Object} params the profile's `asls.*` block -- the envelope, and
   *   the source of `controls` (or the legacy `channels` tick-list)
   * @param {Object} [data] stored values from the show
   */
  constructor(defs, params, data = {}) {
    this._defs = defs;
    this._params = params || {};
    this._controls = ControlSet.fromProfile(defs, this._params);
    const stored = data || {};

    /**
     * The parked value per attribute: what the profile bakes in for a fixed
     * one, what the show carries for anything else, and the definition's own
     * default when the show says nothing.
     */
    this._stored = {};
    this._controls.controls.forEach((control) => {
      if (control.isFixed || stored[control.key] === undefined) {
        this._stored[control.key] = control.value;
      } else {
        this._stored[control.key] = control.type.coerce(stored[control.key], this._params);
      }
    });

    /** What DMX last said, per attribute. Absent until a frame arrives. */
    this._live = {};
    /** The assembled raw integer per driven attribute, across its bytes. */
    this._raw = {};
    this._byteMap = this._controls.byteMap();
  }

  /**
   * The parameters this device declares, as objects.
   *
   * @readonly
   * @type {ControlSet}
   */
  get controls() { return this._controls; }

  /**
   * How many DMX channels this fixture occupies.
   *
   * @readonly
   * @type {Number}
   */
  get footprint() { return this._controls.footprint; }

  /**
   * The keys this fixture drives over DMX.
   *
   * @readonly
   * @type {Array}
   */
  get channels() { return this._controls.drivenKeys; }

  /**
   * The mode of a parameter: 'fixed', 'dmx' or 'adjustable'.
   *
   * @public
   * @param {String} key
   * @returns {String}
   */
  mode(key) { return this._controls.modeOf(key); }

  /**
   * Whether a channel drives this attribute -- what decides whether the panel
   * lets you edit it.
   *
   * @public
   * @param {String} key
   * @returns {Boolean}
   */
  isDriven(key) { return this.mode(key) === 'dmx'; }

  /**
   * Whether this attribute is baked in the profile and not shown per placement.
   *
   * @public
   * @param {String} key
   * @returns {Boolean}
   */
  isFixed(key) { return this.mode(key) === 'fixed'; }

  /**
   * What the device is actually doing: the live value if one has arrived,
   * otherwise the parked one.
   *
   * @public
   * @param {String} key
   * @returns {*}
   */
  value(key) {
    if (this._live[key] !== undefined) return this._live[key];
    return this._stored[key];
  }

  /**
   * The parked value, whatever DMX may be saying over the top.
   *
   * @public
   * @param {String} key
   * @returns {*}
   */
  stored(key) { return this._stored[key]; }

  /**
   * Sets the parked value, keeping it inside what the profile allows. Refused
   * for a fixed attribute, whose value belongs to the profile.
   *
   * @public
   * @param {String} key
   * @param {*} value
   */
  set(key, value) {
    const control = this._controls.get(key);
    if (!control || control.isFixed) return;
    this._stored[key] = control.type.coerce(value, this._params);
  }

  /**
   * Takes one channel's DMX byte and folds it into its attribute.
   *
   * The index is the byte's offset in the fixture's footprint. A parameter may
   * span two or three bytes, assembled coarse-first (big-endian, the DMX norm
   * for fine channels), so a 16-bit value moves smoothly rather than in 256s.
   *
   * @public
   * @param {Number} index byte offset within the fixture
   * @param {Number} dmx 0-255
   */
  writeChannel(index, dmx) {
    const entry = this._byteMap[index];
    if (!entry) return;
    const control = this._controls.get(entry.key);
    if (!control) return;
    const shift = (entry.bytes - 1 - entry.byteIndex) * 8;
    const raw = this._raw[entry.key] || 0;
    // Replace just this byte, leave the others.
    const mask = 0xff << shift;
    const next = (raw & ~mask) | ((Math.min(Math.max(Number(dmx) || 0, 0), 255) << shift));
    // `>>> 0` keeps it a non-negative 32-bit integer: a 24-bit value shifted
    // 16 places is well within 32 bits, but bitwise ops otherwise sign it.
    this._raw[entry.key] = next >>> 0;
    const max = (2 ** (entry.bytes * 8)) - 1;
    this._live[entry.key] = control.type.fromLevel(this._raw[entry.key] / max, this._params);
  }

  /**
   * Whether a channel value has ever arrived for an attribute.
   *
   * @public
   * @param {String} key
   * @returns {Boolean}
   */
  hasLive(key) { return this._live[key] !== undefined; }

  /**
   * Only the non-fixed values travel in the show; a fixed value is in the
   * profile.
   *
   * @readonly
   * @type {Object}
   */
  get showData() {
    const data = {};
    this._controls.controls.forEach((control) => {
      if (!control.isFixed) data[control.key] = this._stored[control.key];
    });
    return data;
  }
}

export default DeviceSettings;
