/**
 * @file What one device is currently doing, and who decides it.
 *
 * The rule this exists for, which is the same for every device that has both
 * hand-set values and optional DMX: **every attribute has a stored value, and a
 * channel the profile declares takes it over.** Unpatched -- which is most
 * projectors and most displays, since neither usually has a DMX socket -- the
 * stored value *is* the state and the panel lets you edit it. Where a channel
 * exists, the channel owns the row and the stored value becomes a parked
 * default. One panel serves both, and nothing about it changes shape when the
 * device is patched.
 *
 * Three consequences worth stating because they are each easy to get wrong:
 *
 * - **Ownership is asked of the profile, not of whether a frame has landed.** A
 *   row that became editable whenever a console paused would be a race.
 * - **A live value is held, not cleared.** When DMX stops arriving the last
 *   value stands: a dropped frame must not snap the rig back to a parked
 *   default, and there is no way to tell a stopped console from a slow one.
 * - **Only parked values travel in the show.** What DMX happens to be saying is
 *   a fact about one machine at one moment -- the same line the app already
 *   draws between a fixture's address and the frame on the wire.
 *
 * A device supplies a **spec**: one entry per attribute saying what it is worth
 * initially, how to keep a hand-set value legal, and how to read one off the
 * wire. Everything above is then the same code for all of them, which is the
 * point -- the rule is subtle enough that a second copy of it would drift.
 */

/** Percent, for the attributes measured in it. */
export const FULL = 100;

/** Above this a shutter reads as open. Half scale, which is the usual place. */
export const SHUTTER_OPEN_AT = 128;

/**
 * Keeps a number inside a range.
 *
 * @param {*} value
 * @param {Number} low
 * @param {Number} high
 * @param {Number} fallback used when the value is not a number at all
 * @returns {Number}
 */
export function clamp(value, low, high, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, low), high);
}

/**
 * Spec entries the common attributes share, so a device that wants an ordinary
 * dimmer does not describe one again.
 *
 * @constant {Object}
 */
export const COMMON_ATTRIBUTES = {
  /** 0-100 %, full by default -- a device nobody has dimmed is on. */
  dimmer: {
    initial: () => FULL,
    coerce: (value) => clamp(value, 0, FULL, FULL),
    fromDmx: (dmx) => (Math.min(Math.max(Number(dmx) || 0, 0), 255) / 255) * FULL,
  },
  /** Open or shut. A dowser is a blade, not a fader. */
  shutter: {
    initial: () => true,
    coerce: (value) => !!value,
    fromDmx: (dmx) => Number(dmx) >= SHUTTER_OPEN_AT,
  },
  /**
   * Which video connector, as an **id** when set by hand and a **one-based
   * position** when driven.
   *
   * An id survives connectors being added, removed and reordered, where an
   * index would quietly re-point at whatever moved into the slot. A channel has
   * only a number to give, and one-based is what makes `Source Select = 1` read
   * as the first connector -- which is the whole reason connectors are named
   * after input sockets.
   */
  source: {
    initial: () => null,
    coerce: (value) => (value === null || value === undefined ? null : value),
    fromDmx: (dmx) => Math.round(Number(dmx) || 0) || null,
  },
};

class DeviceSettings {
  /**
   * @param {Object} spec `{ key: { initial, coerce, fromDmx } }`, in no
   *   particular order -- `order` decides addressing
   * @param {Array} order every channel key this kind may declare, in the order
   *   they are addressed
   * @param {Object} params the profile's `asls.*` block -- the envelope
   * @param {Object} [data] stored values from the show
   */
  constructor(spec, order, params, data = {}) {
    this._spec = spec;
    this._order = order;
    this._params = params || {};
    const stored = data || {};

    this._stored = {};
    Object.keys(spec).forEach((key) => {
      const entry = spec[key];
      this._stored[key] = stored[key] === undefined
        ? entry.initial(this._params)
        : entry.coerce(stored[key], this._params);
    });

    /**
     * What DMX last said, per attribute.
     *
     * Absent until a frame arrives, so a patched device that nothing is driving
     * still shows its parked values rather than a row of zeroes.
     */
    this._live = {};
  }

  /**
   * The channels this model declares, in the order they are addressed.
   *
   * @readonly
   * @type {Array}
   */
  get channels() {
    const declared = this._params.channels || [];
    return this._order.filter((key) => declared.includes(key));
  }

  /**
   * Whether a channel drives this attribute -- which is what decides whether
   * the panel lets you edit it.
   *
   * @public
   * @param {String} key
   * @returns {Boolean}
   */
  isDriven(key) {
    return this.channels.includes(key);
  }

  /**
   * What the device is actually doing: the live value if one has arrived,
   * otherwise the stored one.
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
   * The parked value, whatever DMX may be saying over the top of it.
   *
   * @public
   * @param {String} key
   * @returns {*}
   */
  stored(key) {
    return this._stored[key];
  }

  /**
   * Sets the stored value, keeping it inside what the profile allows.
   *
   * Accepted even for a driven attribute: parking a value under a channel is a
   * legitimate thing to do, and it is what the device falls back to if the
   * profile later changes. The panel is what refuses the edit, not this.
   *
   * @public
   * @param {String} key
   * @param {*} value
   */
  set(key, value) {
    const entry = this._spec[key];
    if (!entry) return;
    this._stored[key] = entry.coerce(value, this._params);
  }

  /**
   * Takes one channel's DMX value and turns it into what that attribute means.
   *
   * The index is into this device's own channel list, which is the order the
   * profile addressed them in -- so it survives a model gaining a channel,
   * where a hard-coded offset would not.
   *
   * @public
   * @param {Number} index channel index within the fixture's mode
   * @param {Number} dmx 0-255
   */
  writeChannel(index, dmx) {
    const key = this.channels[index];
    const entry = key && this._spec[key];
    if (!entry) return;
    this._live[key] = entry.fromDmx(dmx, this._params);
  }

  /**
   * Whether a channel value has ever arrived for an attribute.
   *
   * The panel uses it to say "waiting" rather than showing a parked value as
   * though it were live.
   *
   * @public
   * @param {String} key
   * @returns {Boolean}
   */
  hasLive(key) {
    return this._live[key] !== undefined;
  }

  /**
   * Only the stored values travel in the show.
   *
   * @readonly
   * @type {Object}
   */
  get showData() {
    const data = {};
    Object.keys(this._spec).forEach((key) => { data[key] = this._stored[key]; });
    return data;
  }
}

export default DeviceSettings;
