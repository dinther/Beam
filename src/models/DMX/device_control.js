/* eslint-disable max-classes-per-file */
// One subject -- how a controllable parameter is decided -- expressed as a small
// family of classes. Splitting them across files would separate a type from the
// parameter that holds it and the set that holds them both.
/**
 * @file A controllable parameter of a generic fixture, as an object.
 *
 * Every such parameter is one of three things, chosen when the fixture is
 * defined: **Fixed** (baked into the profile), **Adjustable** (hand-set per
 * placement, stored in the show) or **DMX** (driven from a console at a
 * relative channel and a bit depth). That rule is described in
 * `device_settings.js`, which applies it at run time; this file is what a
 * parameter *is* before anyone applies anything to it.
 *
 * Three things used to be spread apart and had to be kept in step by hand: a
 * plain `{ mode, value, channel, bits }` record in the profile, a free function
 * that laid its bytes out as OFL channels, and a label in a lookup table beside
 * an ordering array. A parameter that gained a column had to be edited in all
 * three, per kind, and the create dialog then rebuilt the same record shape a
 * fourth time. They are one object now:
 *
 * - **`ControlType`** and its subclasses say what a parameter is *worth* -- its
 *   range, its default, how to keep a hand-set value legal, and which editor
 *   can show it. A shutter is not a small number and a video source is not a
 *   number at all, so the editor follows from the type rather than from a
 *   special case at each call site.
 * - **`ControlDef`** is the parameter a *kind* has: a key, a human label and a
 *   type. A kind declares its parameters once, in order, and its channel order
 *   and label table are derived from that declaration.
 * - **`DeviceControl`** is one parameter of one profile: a definition plus the
 *   choice made about it. It knows its own mode, its byte span and its value.
 * - **`ControlSet`** is all of them together, and owns everything that is a
 *   property of the collection rather than of any member -- the DMX footprint,
 *   the offset-to-parameter map, and the OFL channel list a fixture is patched
 *   through.
 *
 * The compatibility path lives here too, in one place: a profile made before
 * any of this carries a `channels` array of the keys that were ticked, which
 * meant DMX, 8-bit, numbered in the kind's order. `ControlSet.fromProfile`
 * reads either shape, so nothing made earlier loses its patch.
 */

/** The three ways a parameter can be decided. */
export const CONTROL_MODES = {
  FIXED: 'fixed',
  ADJUSTABLE: 'adjustable',
  DMX: 'dmx',
};

/** In the order the mode select offers them. */
export const CONTROL_MODE_ORDER = [
  CONTROL_MODES.FIXED,
  CONTROL_MODES.ADJUSTABLE,
  CONTROL_MODES.DMX,
];

/** What the mode select calls them. */
export const CONTROL_MODE_LABELS = ['Fixed', 'Adjustable', 'DMX'];

/** The bit depths a DMX channel may declare, and what the select calls them. */
export const BIT_DEPTHS = [8, 16, 24];
export const BIT_DEPTH_LABELS = ['8-bit', '16-bit', '24-bit'];

/** Which editor a row shows for a Fixed or Adjustable value. */
export const EDITORS = {
  NUMBER: 'number',
  SWITCH: 'switch',
  CHOICE: 'choice',
};

/**
 * Keeps a number inside a range, falling back when it is not a number at all.
 *
 * @param {*} value
 * @param {Number} low
 * @param {Number} high
 * @param {Number} fallback
 * @returns {Number}
 */
export function clamp(value, low, high, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, low), high);
}

/**
 * What a parameter is worth: its range, its default and its editor.
 *
 * Ranges take the profile's parameters because some of them depend on the
 * machine -- a zoom runs between the throw ratios that model's lens actually
 * offers, and a lens shift is bounded by how far its optics move. A type that
 * needs nothing simply ignores the argument.
 *
 * @abstract
 */
export class ControlType {
  /**
   * @param {Object} [options]
   * @param {String} [options.unit] shown beside the field
   * @param {Number} [options.precision] decimals the field displays
   * @param {String} [options.editor] which editor can show it
   */
  constructor({ unit = '', precision = 0, editor = EDITORS.NUMBER } = {}) {
    this.unit = unit;
    this.precision = precision;
    /**
     * Which editor can show this -- the reason the types exist at all. A
     * shutter is a checkbox, a source is a list, everything else is a number.
     */
    this.editor = editor;
  }

  /**
   * The value a parameter starts at when nobody has chosen one.
   *
   * @param {Object} params the profile's `asls.*` block
   * @returns {*}
   */
  // eslint-disable-next-line no-unused-vars, class-methods-use-this
  initial(params) { return 0; }

  /**
   * Keeps a hand-set or stored value legal.
   *
   * @param {*} value
   * @param {Object} params
   * @returns {*}
   */
  // eslint-disable-next-line class-methods-use-this
  coerce(value) { return value; }

  /**
   * The bounds an editor should enforce. Meaningless for a switch or a choice,
   * which say so by not being asked.
   *
   * @param {Object} params
   * @returns {{min: Number, max: Number}}
   */
  // eslint-disable-next-line no-unused-vars, class-methods-use-this
  range(params) { return { min: 0, max: 0 }; }

  /**
   * What the wire is saying, as a value in this parameter's own units.
   *
   * The level is the assembled channel value over its full range, whatever the
   * bit depth, so one implementation serves an 8-bit and a 24-bit version of
   * the same parameter without knowing which arrived. **The units are identical
   * whether a value is typed or driven**, because the profile defines the range
   * both are expressed in -- which is what lets patching a fixture never change
   * what it is already doing.
   *
   * @param {Number} level 0..1
   * @param {Object} params
   * @returns {*}
   */
  // eslint-disable-next-line no-unused-vars, class-methods-use-this
  fromLevel(level, params) { return level; }
}

/**
 * A percentage, either 0-100 or symmetric about zero.
 *
 * The symmetric case takes its limit from the profile, because lens shift is
 * bounded by the optics rather than by the units: `limit` is a function of the
 * parameters, not a constant.
 */
export class PercentType extends ControlType {
  /**
   * @param {Object} [options]
   * @param {Number} [options.initial] where it parks
   * @param {Function} [options.limit] `(params) => Number`; symmetric when given
   */
  constructor({
    initial = 0, limit = null, max = 100, ...rest
  } = {}) {
    super({ unit: '%', ...rest });
    this._initial = initial;
    this._limit = limit;
    this._max = max;
  }

  range(params) {
    if (!this._limit) return { min: 0, max: this._max };
    const limit = Math.abs(Number(this._limit(params)) || 0);
    return { min: -limit, max: limit };
  }

  initial() { return this._initial; }

  coerce(value, params) {
    const { min, max } = this.range(params);
    return clamp(value, min, max, this._initial);
  }

  fromLevel(level, params) {
    const l = clamp(level, 0, 1, 0);
    if (!this._limit) return l * this._max;
    const { max } = this.range(params);
    // Centred at half scale, so a console parked in the middle leaves the
    // image where the optics put it.
    return (l * 2 - 1) * max;
  }
}

/**
 * A ratio in the machine's own units -- a throw ratio, where the range is the
 * lens's and neither end is a round number.
 */
export class RatioType extends ControlType {
  /**
   * @param {Object} options
   * @param {Function} options.bounds `(params) => ({ min, max })`
   * @param {String} [options.parks] 'min' or 'max' -- which end it rests at
   */
  constructor({ bounds, parks = 'min', ...rest }) {
    super({ precision: 2, ...rest });
    this._bounds = bounds;
    this._parks = parks;
  }

  range(params) { return this._bounds(params); }

  initial(params) {
    const { min, max } = this.range(params);
    return this._parks === 'max' ? max : min;
  }

  coerce(value, params) {
    const { min, max } = this.range(params);
    return clamp(value, min, max, this.initial(params));
  }

  fromLevel(level, params) {
    const { min, max } = this.range(params);
    const l = clamp(level, 0, 1, 0);
    // Level 0 is the *narrow* end when a lens parks wide, because the
    // capability writes the narrowest angle as its start -- and a narrow angle
    // is a long throw ratio. So the ratio runs from max down to min, not the
    // other way about. Backwards inverts every projector's zoom, invisibly.
    return this._parks === 'max' ? min + (max - min) * l : max + (min - max) * l;
  }
}

/**
 * On or off. A shutter is a blade, not a fader, and a row that showed it as a
 * number was asking the definer to encode a boolean by hand.
 */
export class SwitchType extends ControlType {
  /**
   * @param {Object} [options]
   * @param {Boolean} [options.initial]
   * @param {String} [options.onLabel] what true is called on this machine
   */
  constructor({ initial = true, onLabel = 'Open', ...rest } = {}) {
    super({ ...rest, editor: EDITORS.SWITCH });
    this._initial = initial;
    this.onLabel = onLabel;
  }

  initial() { return this._initial; }

  // eslint-disable-next-line class-methods-use-this
  coerce(value) { return !!value; }

  // Half scale, the usual place for a blade to read as open.
  // eslint-disable-next-line class-methods-use-this
  fromLevel(level) { return clamp(level, 0, 1, 0) >= 0.5; }
}

/**
 * One of a list the app supplies -- a video connector, a DAC stream.
 *
 * The options are not known here and must not be: they are a fact about the
 * show being edited, not about the kind of machine. A row asks the type what
 * shape the editor is and the dialog supplies what goes in it.
 */
export class ChoiceType extends ControlType {
  /**
   * @param {Object} [options]
   * @param {String} [options.source] which list the app should offer:
   *   'connectors' or 'dacStreams'
   */
  constructor({ source = 'connectors', ...rest } = {}) {
    super({ ...rest, editor: EDITORS.CHOICE });
    this.source = source;
  }

  // eslint-disable-next-line class-methods-use-this
  initial() { return null; }

  // eslint-disable-next-line class-methods-use-this
  coerce(value) {
    return value === null || value === undefined || value === '' ? null : value;
  }

  // A channel has only a number to give, so it names a **one-based position**
  // where a hand-set value names an id -- an id survives the list being
  // reordered, where an index would silently re-point.
  // eslint-disable-next-line class-methods-use-this
  fromLevel(level) { return Math.round(clamp(level, 0, 1, 0) * 255) || null; }
}

/**
 * One of a fixed list the machine itself defines -- which protocol a laser
 * speaks. Unlike a {@link ChoiceType} the options are known here, because they
 * are a property of the kind rather than of the show.
 */
export class EnumType extends ControlType {
  /**
   * @param {Object} options
   * @param {Array} options.options the legal values
   * @param {*} options.initial
   * @param {Object} [options.labels] value to display name
   */
  constructor({
    options, initial, labels = {}, ...rest
  }) {
    super({ ...rest, editor: EDITORS.CHOICE });
    this.options = options;
    this._initial = initial;
    this.labels = labels;
  }

  initial() { return this._initial; }

  coerce(value) { return this.options.includes(value) ? value : this._initial; }

  // Never driven -- these are not addressable, see ControlDef.
  fromLevel() { return this._initial; }
}

/**
 * A string, or nothing. A machine address someone typed.
 */
export class TextType extends ControlType {
  // eslint-disable-next-line class-methods-use-this
  initial() { return null; }

  // eslint-disable-next-line class-methods-use-this
  coerce(value) { return typeof value === 'string' && value ? value : null; }

  // eslint-disable-next-line class-methods-use-this
  fromLevel() { return null; }
}

/**
 * A parameter a *kind* of fixture has: what it is called and what it is worth.
 *
 * A kind declares these once, in addressing order. Its channel order and its
 * label table are then derived rather than maintained, so a parameter cannot
 * exist in one and be missing from the other.
 */
export class ControlDef {
  /**
   * @param {String} key how the profile and the settings spec both name it
   * @param {String} label what a patch sheet calls it
   * @param {ControlType} type
   * @param {Object} [options]
   * @param {Boolean} [options.addressable] whether a console may drive it
   * @param {Boolean} [options.fixable] whether it may be baked into the profile
   * @param {Object|Function} [options.capability] the OFL capability its
   *   channel declares, or a function of the profile's parameters returning one
   */
  constructor(key, label, type, {
    addressable = true, fixable = true, capability = null,
  } = {}) {
    this.key = key;
    this.label = label;
    this.type = type;
    /**
     * Whether Fixed is a sensible thing to be.
     *
     * A profile describes a *model of machine*, so a fixed value has to be one
     * the machine is born with: a prime lens's zoom, a projector with no
     * dimmer. Which video connector a screen is watching is not that -- it
     * belongs to the placement, and every machine of that model in the show
     * would be stuck on the same feed. So a source offers Adjustable or DMX
     * and nothing else.
     */
    this.fixable = fixable;
    /**
     * What the generated OFL channel says it does.
     *
     * Nothing routes on it -- `Fixture.setChannel` sends a device's bytes to
     * `writeChannel` by position, deliberately, because OFL has no vocabulary
     * for half of these (`BeamPosition` writes pan *and* tilt for one axis, so
     * two lens-shift channels would overwrite each other). It is what a patch
     * sheet and an export read, so it is worth being honest in: a dimmer really
     * is an intensity, and a projector's zoom really does span a known pair of
     * angles.
     *
     * Maintenance is OFL's catch-all for a channel that acts on the machine
     * rather than on the light, which is what most of these are.
     */
    this._capability = capability;
    /**
     * Whether this parameter can be put on a channel at all.
     *
     * Some attributes belong to the machine rather than to the performance:
     * which protocol a laser speaks and which address it answers on, or how
     * wide a projector's soft-edge blend is. They are stored and hand-set like
     * anything else, but no console rides them, so they take no channel, get no
     * row in the create dialog, and never appear in a kind's channel order.
     */
    this.addressable = addressable;
  }

  /**
   * The modes this parameter may be in, canonical indices into
   * {@link CONTROL_MODE_ORDER}.
   *
   * @returns {Array} `[{ mode, index, label }]`
   */
  modeChoices() {
    return CONTROL_MODE_ORDER
      .map((mode, index) => ({ mode, index, label: CONTROL_MODE_LABELS[index] }))
      .filter((choice) => {
        if (choice.mode === CONTROL_MODES.FIXED && !this.fixable) return false;
        if (choice.mode === CONTROL_MODES.DMX && !this.addressable) return false;
        return true;
      });
  }

  /**
   * The OFL capability for this parameter, given the machine it belongs to.
   *
   * @param {Object} params the profile's `asls.*` block
   * @returns {Object}
   */
  capabilityFor(params) {
    if (typeof this._capability === 'function') return this._capability(params);
    return this._capability || { type: 'Maintenance' };
  }
}

/**
 * Derives the ordered key list a kind's channels are addressed in.
 *
 * @param {Array} defs
 * @returns {Array}
 */
export function orderOf(defs) {
  return defs.filter((def) => def.addressable).map((def) => def.key);
}

/**
 * Derives the key-to-label table.
 *
 * @param {Array} defs
 * @returns {Object}
 */
export function labelsOf(defs) {
  return Object.fromEntries(defs.filter((def) => def.addressable)
    .map((def) => [def.key, def.label]));
}

/**
 * One parameter of one profile: its definition, and the choice made about it.
 */
export class DeviceControl {
  /**
   * @param {ControlDef} def
   * @param {Object} [choice] `{ mode, value, channel, bits }` as stored
   * @param {Object} [params] the profile's `asls.*` block, for coercion
   */
  constructor(def, choice = {}, params = {}) {
    this.def = def;
    // A mode the parameter cannot be in falls back rather than being honoured:
    // a hand-edited profile, or one written before a parameter stopped being
    // fixable, must not bake a value the placement is supposed to own.
    const wanted = CONTROL_MODE_ORDER.includes(choice.mode)
      ? choice.mode : CONTROL_MODES.ADJUSTABLE;
    const allowed = (wanted !== CONTROL_MODES.FIXED || def.fixable)
      && (wanted !== CONTROL_MODES.DMX || def.addressable);
    this.mode = allowed ? wanted : CONTROL_MODES.ADJUSTABLE;
    this.channel = Math.max(1, Math.round(Number(choice.channel) || 1));
    this.bits = BIT_DEPTHS.includes(Number(choice.bits)) ? Number(choice.bits) : 8;
    this.value = choice.value === undefined
      ? def.type.initial(params)
      : def.type.coerce(choice.value, params);
  }

  get key() { return this.def.key; }

  get label() { return this.def.label; }

  get type() { return this.def.type; }

  get isFixed() { return this.mode === CONTROL_MODES.FIXED; }

  get isDriven() { return this.mode === CONTROL_MODES.DMX; }

  get isAdjustable() { return this.mode === CONTROL_MODES.ADJUSTABLE; }

  /** How many DMX bytes it occupies. Coarse-first when there are several. */
  get bytes() { return this.bits / 8; }

  /** The 0-based offset of its first byte. */
  get firstOffset() { return this.channel - 1; }

  /** One past its last byte, which is what a footprint is measured against. */
  get endOffset() { return this.isDriven ? this.firstOffset + this.bytes : 0; }

  /**
   * Whether this parameter occupies a given byte offset.
   *
   * @param {Number} offset 0-based
   * @returns {Boolean}
   */
  covers(offset) {
    return this.isDriven && offset >= this.firstOffset && offset < this.endOffset;
  }

  /**
   * As the profile stores it. A fixed or adjustable parameter keeps its channel
   * and depth so that switching it to DMX and back does not forget them.
   *
   * @returns {Object}
   */
  toJSON() {
    return {
      mode: this.mode,
      value: this.value,
      channel: this.channel,
      bits: this.bits,
    };
  }
}

/**
 * Every controllable parameter of one profile, and everything that is true of
 * the collection rather than of any one member.
 */
export class ControlSet {
  /**
   * @param {Array} defs the kind's declarations, in addressing order
   * @param {Array} controls `DeviceControl` instances, matching `defs`
   */
  constructor(defs, controls, params = {}) {
    this.defs = defs;
    this.controls = controls;
    this.params = params;
    this._byKey = Object.fromEntries(controls.map((c) => [c.key, c]));
  }

  /**
   * Reads whichever shape a profile carries.
   *
   * A `controls` block is the current form. A `channels` array is what profiles
   * made before it carry: the keys that were ticked, which meant DMX, 8-bit,
   * numbered in the kind's own order. A profile with neither -- a fixture being
   * defined right now -- starts every parameter Adjustable at its default, with
   * channels pre-numbered in order so that ticking a run of them to DMX lands
   * contiguously without anyone having to think about it.
   *
   * @param {Array} defs
   * @param {Object} [params] the profile's `asls.*` block
   * @returns {ControlSet}
   */
  static fromProfile(defs, params = {}) {
    const stored = params.controls;
    if (stored) {
      return new ControlSet(defs, defs.map(
        (def, i) => new DeviceControl(def, { channel: i + 1, ...(stored[def.key] || {}) }, params),
      ), params);
    }

    const ticked = Array.isArray(params.channels) ? params.channels : null;
    if (ticked) {
      let channel = 1;
      return new ControlSet(defs, defs.map((def) => {
        if (!ticked.includes(def.key)) {
          return new DeviceControl(def, { mode: CONTROL_MODES.ADJUSTABLE }, params);
        }
        const control = new DeviceControl(def, {
          mode: CONTROL_MODES.DMX, channel, bits: 8,
        }, params);
        channel += 1;
        return control;
      }), params);
    }

    return new ControlSet(defs, defs.map(
      (def, i) => new DeviceControl(def, { channel: i + 1 }, params),
    ), params);
  }

  /**
   * @param {String} key
   * @returns {DeviceControl|undefined}
   */
  get(key) { return this._byKey[key]; }

  /**
   * @param {String} key
   * @returns {String} 'fixed', 'adjustable' or 'dmx'
   */
  modeOf(key) {
    const control = this.get(key);
    return control ? control.mode : CONTROL_MODES.ADJUSTABLE;
  }

  /** The parameters a console drives, in addressing order. */
  get driven() {
    return this.controls.filter((c) => c.isDriven)
      .sort((a, b) => a.channel - b.channel);
  }

  /** The keys a console drives -- what a fixture reports as its channels. */
  get drivenKeys() { return this.driven.map((c) => c.key); }

  /**
   * How many DMX channels the fixture occupies: the furthest byte any driven
   * parameter reaches. Gaps between them are real channels that do nothing, so
   * that the parameters after a gap keep the numbers they were given.
   *
   * @readonly
   * @type {Number}
   */
  get footprint() {
    return this.controls.reduce((max, c) => Math.max(max, c.endOffset), 0);
  }

  /**
   * Two parameters claiming the same byte. The dialog is what refuses this;
   * the layout below merely lets the last one win.
   *
   * @returns {Array} one `{ offset, keys }` per contested byte
   */
  get overlaps() {
    const seen = {};
    const clashes = {};
    this.driven.forEach((control) => {
      for (let offset = control.firstOffset; offset < control.endOffset; offset += 1) {
        if (seen[offset]) {
          clashes[offset] = clashes[offset] || [seen[offset]];
          clashes[offset].push(control.key);
        } else seen[offset] = control.key;
      }
    });
    return Object.keys(clashes).map((offset) => ({
      offset: Number(offset), keys: clashes[offset],
    }));
  }

  /**
   * The first relative channel no other driven parameter is using.
   *
   * A parameter's byte span runs from its channel through
   * `channel + bits / 8 - 1`, so the next free channel is one past the
   * furthest byte any *other* driven parameter reaches. Asked when a parameter
   * is switched to DMX, so that a 16-bit dimmer at channel 1 leaves the next
   * one landing on 3 rather than colliding on 2.
   *
   * @param {String} [exceptKey] the parameter being placed, left out of the sum
   * @returns {Number}
   */
  nextFreeChannel(exceptKey) {
    return this.controls.reduce(
      (end, c) => (c.key === exceptKey ? end : Math.max(end, c.endOffset)),
      0,
    ) + 1;
  }

  /**
   * Byte offset (0-based) to the parameter that owns it.
   *
   * @returns {Object} `{ offset: { key, byteIndex, bytes } }`
   */
  byteMap() {
    const map = {};
    this.driven.forEach((control) => {
      for (let i = 0; i < control.bytes; i += 1) {
        map[control.firstOffset + i] = {
          key: control.key, byteIndex: i, bytes: control.bytes,
        };
      }
    });
    return map;
  }

  /**
   * The OFL channels this set implies, at the offsets it names.
   *
   * The fixture is drawn by other machinery from a mode's ordered channel list,
   * and `setChannel` routes each byte to `writeChannel` by its position in that
   * list. So a parameter at relative channel 3, 16-bit, has to leave an entry
   * at offsets 3 and 4, and an offset nothing uses has to be a real do-nothing
   * channel so the ones after it keep their numbers.
   *
   * The capability types are cosmetic -- routing is by position -- so every
   * slot is a plain Maintenance channel, OFL's catch-all for a channel that
   * acts on the machine. The extra bytes are numbered, never called "fine":
   * the fixture parser treats any channel whose name contains " fine" as a
   * native 16-bit fine channel and links it to a coarse one, which would double
   * and reorder these.
   *
   * @returns {Object} `{ availableChannels, modes, footprint }`
   */
  buildChannels() {
    const { footprint } = this;
    const slots = new Array(footprint).fill(null);

    this.driven.forEach((control) => {
      for (let i = 0; i < control.bytes; i += 1) {
        // Only the first byte carries the parameter's own capability: the
        // extra bytes of a 16- or 24-bit value are fine detail of the same
        // quantity, and are numbered rather than called "fine" because the
        // fixture parser links any channel whose name contains " fine" to a
        // coarse one, which would double and reorder these.
        slots[control.firstOffset + i] = {
          name: control.bytes > 1 && i > 0 ? `${control.label} ${i + 1}` : control.label,
          capability: i === 0 ? control.def.capabilityFor(this.params) : { type: 'Maintenance' },
        };
      }
    });

    const availableChannels = {};
    const channels = slots.map((slot, offset) => {
      const resolved = slot ? slot.name : `Reserved ${offset + 1}`;
      availableChannels[resolved] = {
        capability: slot ? slot.capability : { type: 'Maintenance' },
      };
      return resolved;
    });

    return { availableChannels, modes: [{ name: 'Default', channels }], footprint };
  }

  /**
   * As the profile stores it.
   *
   * @returns {Object} `{ key: { mode, value, channel, bits } }`
   */
  toJSON() {
    return Object.fromEntries(this.controls.map((c) => [c.key, c.toJSON()]));
  }
}

/**
 * The editable record a form keeps per parameter.
 *
 * A form models a select by its *index*, and holds a value for every mode so
 * that switching a parameter to DMX and back does not lose what it was set to.
 * Records are plain objects on purpose: they are what a Vue component binds to,
 * and a class instance behind a reactive proxy is a trap this app has been
 * caught by before.
 *
 * @public
 * @param {Array} defs
 * @param {Object} [params] the envelope, for the defaults that depend on it
 * @returns {Object} `{ key: { modeIndex, value, channel, bitsIndex } }`
 */
export function blankRecords(defs, params = {}) {
  const adjustable = CONTROL_MODE_ORDER.indexOf(CONTROL_MODES.ADJUSTABLE);
  return Object.fromEntries(defs.filter((def) => def.addressable).map((def, i) => [def.key, {
    modeIndex: adjustable,
    value: def.type.initial(params),
    // Numbered in order, so that switching a run of them to DMX lands
    // contiguously without anyone having to think about it.
    channel: i + 1,
    bitsIndex: 0,
  }]));
}

/**
 * Turns a form's records back into a set, which is what knows anything about
 * the collection -- the footprint, the overlaps, the channels, the profile.
 *
 * The one conversion point, so a form and the profile it writes cannot read
 * the same records differently.
 *
 * @public
 * @param {Array} defs
 * @param {Object} records
 * @param {Object} [params]
 * @returns {ControlSet}
 */
export function controlSetFromRecords(defs, records, params = {}) {
  return new ControlSet(defs, defs.map((def, i) => {
    const record = records[def.key] || {};
    return new DeviceControl(def, {
      mode: CONTROL_MODE_ORDER[record.modeIndex] || CONTROL_MODES.ADJUSTABLE,
      value: record.value,
      channel: record.channel === undefined ? i + 1 : record.channel,
      bits: BIT_DEPTHS[record.bitsIndex] || 8,
    }, params);
  }), params);
}

export default ControlSet;
