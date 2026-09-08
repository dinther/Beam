/* eslint-disable no-bitwise */
// Assembling a 16- or 24-bit value from its DMX bytes is the subject matter
// here; the shifts and masks are the clearest way to write it.
/**
 * @file What one device is currently doing, and who decides it.
 *
 * Every controllable parameter of a generic fixture is one of three things,
 * chosen when the fixture is defined:
 *
 * - **Fixed** -- a value baked into the profile. Not shown per placement, never
 *   driven. A prime lens's zoom, a laser with no dimmer.
 * - **Adjustable** -- hand-set per placement and stored in the show. The state
 *   *is* the stored value, and the panel lets you edit it. Most projectors and
 *   displays, which have no DMX socket at all.
 * - **DMX** -- driven from a console. The definition gives a **relative
 *   channel** (a 1-based offset within the fixture) and a **bit depth**
 *   (8/16/24), and the channel owns the row: the stored value becomes a parked
 *   default the device falls back to.
 *
 * One panel and one rule serve all three, and nothing about the panel changes
 * shape when a fixture is patched. Three consequences, each easy to get wrong:
 *
 * - **Ownership is asked of the definition, not of whether a frame has landed.**
 *   A row that became editable whenever a console paused would be a race.
 * - **A live value is held, not cleared.** When DMX stops the last value
 *   stands: a dropped frame must not snap the rig to a parked default, and
 *   there is no telling a stopped console from a slow one.
 * - **Only non-fixed values travel in the show.** A fixed value lives in the
 *   profile; what DMX is saying is a fact about one machine at one moment.
 *
 * A device supplies a **spec**: one entry per attribute saying what it is worth
 * initially, how to keep a hand-set value legal, and how to read a level off
 * the wire. The three modes and the multi-byte assembly are then the same code
 * for every device.
 *
 * **Controls, and the older tick-list.** A profile carries a `controls` block
 * -- `{ key: { mode, value, channel, bits } }` -- built by the create dialog.
 * Profiles made before this existed carry a `channels` array of the keys that
 * were ticked; those are read through a compatibility path that treats each as
 * DMX, 8-bit, addressed in the kind's fixed order, which is exactly what the
 * tick-list meant. So nothing made before this change loses its patch.
 */

/** Percent, for the attributes measured in it. */
export const FULL = 100;

/** Above this fraction a shutter reads as open. Half scale, the usual place. */
export const SHUTTER_OPEN_AT = 0.5;

/** The bit depths a DMX channel may declare. */
export const BIT_DEPTHS = [8, 16, 24];

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
 * `fromLevel` takes a normalised 0..1 -- the assembled channel value over its
 * full range, whatever the bit depth -- so the same entry serves an 8-bit and
 * a 16-bit dimmer without knowing which it is.
 *
 * @constant {Object}
 */
export const COMMON_ATTRIBUTES = {
  /** 0-100 %, full by default -- a device nobody has dimmed is on. */
  dimmer: {
    initial: () => FULL,
    coerce: (value) => clamp(value, 0, FULL, FULL),
    fromLevel: (level) => clamp(level, 0, 1, 1) * FULL,
  },
  /** Open or shut. A dowser is a blade, not a fader. */
  shutter: {
    initial: () => true,
    coerce: (value) => !!value,
    fromLevel: (level) => level >= SHUTTER_OPEN_AT,
  },
  /**
   * Which video connector, as an **id** when set by hand and a **one-based
   * position** when driven. An id survives connectors being reordered where an
   * index would re-point; a channel has only a number to give.
   */
  source: {
    initial: () => null,
    coerce: (value) => (value === null || value === undefined ? null : value),
    fromLevel: (level) => Math.round(clamp(level, 0, 1, 0) * 255) || null,
  },
};

/**
 * Builds the OFL channels a `controls` block implies, at the offsets it names.
 *
 * The fixture is drawn by other machinery from a mode's ordered channel list,
 * and `setChannel` routes each byte to `writeChannel` by its position in that
 * list. So a DMX parameter at relative channel 3, 16-bit, has to leave a
 * channel entry at offsets 3 and 4, and any offset nothing uses has to be a
 * real (do-nothing) channel so the ones after it keep their numbers. The
 * capability types are cosmetic here -- routing is by position, in
 * `DeviceSettings.writeChannel` -- so every slot is a plain Maintenance
 * channel, which is OFL's catch-all for a channel that acts on the machine.
 *
 * @public
 * @param {Object} controls `{ key: { mode, channel, bits } }`
 * @param {Object} labels `{ key: 'Human Name' }`
 * @returns {Object} `{ availableChannels, modes, footprint }`
 */
export function buildControlChannels(controls, labels) {
  const driven = Object.keys(controls || {})
    .filter((key) => controls[key] && controls[key].mode === 'dmx')
    .map((key) => ({
      key,
      channel: Math.max(1, Math.round(Number(controls[key].channel) || 1)),
      bytes: Math.max(1, Math.round((Number(controls[key].bits) || 8) / 8)),
    }))
    .sort((a, b) => a.channel - b.channel);

  let footprint = 0;
  driven.forEach((d) => { footprint = Math.max(footprint, d.channel - 1 + d.bytes); });

  const slots = new Array(footprint).fill(null);
  driven.forEach((d) => {
    const label = labels[d.key] || d.key;
    for (let i = 0; i < d.bytes; i += 1) {
      const offset = d.channel - 1 + i;
      // Overlap: two parameters claiming the same byte. Left to the last one
      // written; the create dialog is what refuses it, this only lays it out.
      //
      // The extra bytes are numbered, never called "fine": the fixture parser
      // treats any channel whose name contains " fine" as a native 16-bit fine
      // channel and links it to a coarse one, which doubles and reorders these.
      // Routing here is purely by position, so each byte is its own plain
      // channel -- "Dimmer", "Dimmer 2", "Dimmer 3".
      slots[offset] = d.bytes > 1 && i > 0 ? `${label} ${i + 1}` : label;
    }
  });

  const availableChannels = {};
  const channels = slots.map((name, offset) => {
    const resolved = name || `Reserved ${offset + 1}`;
    availableChannels[resolved] = { capability: { type: 'Maintenance' } };
    return resolved;
  });

  return { availableChannels, modes: [{ name: 'Default', channels }], footprint };
}

class DeviceSettings {
  /**
   * @param {Object} spec `{ key: { initial, coerce, fromLevel } }`
   * @param {Object} params the profile's `asls.*` block -- the envelope, and
   *   the source of `controls` (or the legacy `channels`)
   * @param {Object} [data] stored values from the show
   * @param {Array} [order] every key this kind may declare, in the order the
   *   legacy tick-list addressed them -- used only to read old profiles
   */
  constructor(spec, params, data = {}, order = null) {
    this._spec = spec;
    this._params = params || {};
    this._order = order || Object.keys(spec);
    this._controls = this.resolveControls();
    const stored = data || {};

    this._stored = {};
    Object.keys(spec).forEach((key) => {
      const entry = spec[key];
      const ctrl = this._controls[key];
      if (ctrl && ctrl.mode === 'fixed') {
        // Baked in the profile, not the show.
        this._stored[key] = entry.coerce(ctrl.value, this._params);
      } else if (stored[key] !== undefined) {
        this._stored[key] = entry.coerce(stored[key], this._params);
      } else if (ctrl && ctrl.value !== undefined) {
        this._stored[key] = entry.coerce(ctrl.value, this._params);
      } else {
        this._stored[key] = entry.initial(this._params);
      }
    });

    /** What DMX last said, per attribute. Absent until a frame arrives. */
    this._live = {};
    /** The assembled raw integer per driven attribute, across its bytes. */
    this._raw = {};
    this._byteMap = this.buildByteMap();
  }

  /**
   * The controls block, from the profile or reconstructed from a legacy
   * `channels` tick-list.
   *
   * @returns {Object} `{ key: { mode, value, channel, bits } }`
   */
  resolveControls() {
    if (this._params.controls) return this._params.controls;
    // Legacy: a ticked channel was DMX, 8-bit, addressed in the kind's order.
    const declared = this._params.channels || [];
    const controls = {};
    let channel = 1;
    this._order.forEach((key) => {
      if (declared.includes(key)) {
        controls[key] = { mode: 'dmx', channel, bits: 8 };
        channel += 1;
      }
    });
    return controls;
  }

  /**
   * offset (0-based) -> `{ key, byteIndex, bytes }` for every driven byte.
   *
   * @returns {Object}
   */
  buildByteMap() {
    const map = {};
    Object.keys(this._controls).forEach((key) => {
      const ctrl = this._controls[key];
      if (!ctrl || ctrl.mode !== 'dmx' || !this._spec[key]) return;
      const channel = Math.max(1, Math.round(Number(ctrl.channel) || 1));
      const bytes = Math.max(1, Math.round((Number(ctrl.bits) || 8) / 8));
      for (let i = 0; i < bytes; i += 1) {
        map[channel - 1 + i] = { key, byteIndex: i, bytes };
      }
    });
    return map;
  }

  /**
   * How many DMX channels this fixture occupies: the furthest byte any driven
   * parameter reaches.
   *
   * @readonly
   * @type {Number}
   */
  get footprint() {
    let footprint = 0;
    Object.keys(this._byteMap).forEach((offset) => {
      footprint = Math.max(footprint, Number(offset) + 1);
    });
    return footprint;
  }

  /**
   * The keys this fixture drives over DMX.
   *
   * @readonly
   * @type {Array}
   */
  get channels() {
    return Object.keys(this._controls).filter((key) => this._controls[key].mode === 'dmx');
  }

  /**
   * The mode of a parameter: 'fixed', 'dmx' or 'adjustable' (the default for a
   * spec key no control names).
   *
   * @public
   * @param {String} key
   * @returns {String}
   */
  mode(key) {
    const ctrl = this._controls[key];
    return ctrl && ctrl.mode ? ctrl.mode : 'adjustable';
  }

  /**
   * Whether a channel drives this attribute -- what decides whether the panel
   * lets you edit it.
   *
   * @public
   * @param {String} key
   * @returns {Boolean}
   */
  isDriven(key) {
    return this.mode(key) === 'dmx';
  }

  /**
   * Whether this attribute is baked in the profile and not shown per placement.
   *
   * @public
   * @param {String} key
   * @returns {Boolean}
   */
  isFixed(key) {
    return this.mode(key) === 'fixed';
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
   * The parked value, whatever DMX may be saying over the top.
   *
   * @public
   * @param {String} key
   * @returns {*}
   */
  stored(key) {
    return this._stored[key];
  }

  /**
   * Sets the stored value, keeping it inside what the profile allows. Refused
   * for a fixed attribute, whose value belongs to the profile.
   *
   * @public
   * @param {String} key
   * @param {*} value
   */
  set(key, value) {
    const entry = this._spec[key];
    if (!entry || this.isFixed(key)) return;
    this._stored[key] = entry.coerce(value, this._params);
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
    const spec = this._spec[entry.key];
    if (!spec) return;
    const shift = (entry.bytes - 1 - entry.byteIndex) * 8;
    const raw = this._raw[entry.key] || 0;
    // Replace just this byte, leave the others.
    const mask = 0xff << shift;
    const next = (raw & ~mask) | ((Math.min(Math.max(Number(dmx) || 0, 0), 255) << shift));
    // `>>> 0` keeps it a non-negative 32-bit integer: a 24-bit value shifted
    // 16 places is well within 32 bits, but bitwise ops otherwise sign it.
    this._raw[entry.key] = next >>> 0;
    const max = (2 ** (entry.bytes * 8)) - 1;
    this._live[entry.key] = spec.fromLevel(this._raw[entry.key] / max, this._params);
  }

  /**
   * Whether a channel value has ever arrived for an attribute.
   *
   * @public
   * @param {String} key
   * @returns {Boolean}
   */
  hasLive(key) {
    return this._live[key] !== undefined;
  }

  /**
   * Only the non-fixed values travel in the show; a fixed value is in the
   * profile.
   *
   * @readonly
   * @type {Object}
   */
  get showData() {
    const data = {};
    Object.keys(this._spec).forEach((key) => {
      if (!this.isFixed(key)) data[key] = this._stored[key];
    });
    return data;
  }
}

export default DeviceSettings;
