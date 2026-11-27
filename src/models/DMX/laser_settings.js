import DeviceSettings, { FULL, valueInRange } from './device_settings';
import {
  ControlDef, ControlType, EnumType, TextType, ChoiceType, clamp,
} from './device_control';
import {
  LASER_CHANNELS, CONTROL_DEFS, LASER_MODES, MODE_LABELS,
} from './generic/laser';
import { coerceClipList, selectedClip, testPatternClip } from './laser_clips';

export { LASER_MODES, MODE_LABELS };

/**
 * @file What one laser is set to.
 *
 * What a laser's output stage *is* -- a master, three colour balances, scale,
 * position and two mounting flips -- is declared once in `generic/laser.js`,
 * and the rule that decides who owns each of them lives in
 * `device_settings.js`. What is left here is how the laser is *fed*, which is a
 * fact about the rig rather than about the performance.
 */

/**
 * The attributes a laser carries, keyed exactly as its channels are.
 *
 * @constant {Object}
 */
export const LASER_ATTRIBUTES = LASER_CHANNELS;

/**
 * Every protocol a laser may be *stored* as, including withdrawn ones, so a
 * show naming one still loads and says what it was set to.
 */
export const LASER_PROTOCOLS = ['ponk', 'idn', 'etherdream', 'lasercube', 'clips', 'thru'];

/**
 * What the dropdown offers.
 *
 * **LaserCube is withdrawn, and the code is kept.** Its host binds the
 * device's own well-known ports -- `m_cmdsocket->bind(cmd_port)` in
 * Wickedlasers' own `LaserDockNetworkDevice.cpp` -- so a host and an emulated
 * cube on one machine need the same UDP port and only one can have it. No
 * choice of address helps, because the host binds that port on whichever
 * address it talks to the cube on. It works only against a host on another
 * machine, which is not a thing to offer in a list. Put it back here if that
 * ever changes; nothing else has to be rebuilt.
 */
export const SELECTABLE_PROTOCOLS = ['clips', 'ponk', 'idn', 'etherdream', 'thru'];

/** What each protocol is called on screen. */
export const PROTOCOL_LABELS = {
  ponk: 'Ponk',
  idn: 'IDN',
  etherdream: 'Ether Dream',
  lasercube: 'LaserCube',
  clips: 'Standalone',
  thru: 'Thru',
};

/**
 * The protocol a laser plays its standalone list from, as from its own memory
 * card: nothing is received, so it is never waiting for a stream.
 */
export const CLIPS_PROTOCOL = 'clips';

/**
 * The protocol of a laser fed from another laser's input, as by an ILDA cable
 * from its thru port. `source` names that laser as `laser:<uid>`. The points
 * are the other laser's input; the output stage (flips, scale, position,
 * colour) is this laser's own.
 */
export const THRU_PROTOCOL = 'thru';

/** The `source` value that names a laser to take the input of. */
export const THRU_PREFIX = 'laser:';

/**
 * A laser's clip list: an array of clips, see `laser_clips.js`. Held per
 * placement and saved with the show; no console rides it.
 */
class ClipListType extends ControlType {
  // eslint-disable-next-line class-methods-use-this
  initial() { return []; }

  // eslint-disable-next-line class-methods-use-this
  coerce(value) { return coerceClipList(value); }

  // eslint-disable-next-line class-methods-use-this
  fromLevel() { return []; }
}

/**
 * An IDN service number, 1-255, or null for the next one free on the laser's
 * address. Lasers given the same number draw the same stream.
 */
class ServiceType extends ControlType {
  // eslint-disable-next-line class-methods-use-this
  initial() { return null; }

  // eslint-disable-next-line class-methods-use-this
  coerce(value) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n >= 1 && n <= 255 ? n : null;
  }

  // eslint-disable-next-line class-methods-use-this
  range() { return { min: 1, max: 255 }; }

  // eslint-disable-next-line class-methods-use-this
  fromLevel() { return null; }
}

/**
 * How the laser is fed. None of these is addressable, and that is the point:
 * they describe the rig, not the show.
 *
 * `protocol` is how the laser presents itself -- a real one has a DAC in it, so
 * "this is a LaserCube" belongs to the fixture. `address` is which of the
 * machine's addresses it lives at, which is what decides how many lasers a
 * protocol can carry: Ether Dream and LaserCube name a device only by its
 * address, so one laser each, while IDN offers a named service per laser at one
 * address. `source` holds the chosen Ponk stream, or for Thru the laser whose input
 * this one takes -- neither has a number a console could name it by.
 *
 * @constant {Array}
 */
const FEED_DEFS = [
  new ControlDef('protocol', 'Protocol', new EnumType({
    options: LASER_PROTOCOLS, initial: 'ponk', labels: PROTOCOL_LABELS,
  }), { addressable: false }),
  new ControlDef('address', 'Address', new TextType(), { addressable: false }),
  new ControlDef('service', 'Service', new ServiceType(), { addressable: false, fixable: false }),
  new ControlDef('source', 'Source', new ChoiceType({ source: 'dacStreams' }), {
    addressable: false, fixable: false,
  }),
  new ControlDef('clips', 'Clips', new ClipListType(), { addressable: false, fixable: false }),
  // The library card the list is a copy of, by key, or null for a list of
  // this placement's own. See laser_cards.js.
  new ControlDef('card', 'Card', new TextType(), { addressable: false, fixable: false }),
];

/** Every attribute a laser holds: the output stage, plus how it is fed. */
export const LASER_DEFS = [...CONTROL_DEFS, ...FEED_DEFS];

/** Degrees a second at full spin: Pangolin's FB4 table gives -60 to 60 RPM. */
export const SPIN_AT_FULL = 360;

class LaserSettings extends DeviceSettings {
  /**
   * @param {Object} params the profile's `beam.laser` -- the envelope
   * @param {Object} [data] stored values from the show
   */
  constructor(params, data = {}) {
    super(LASER_DEFS, params, data);
    /** The page the clip channel's cue is on, from a file's page channel. */
    this._page = Math.max(Math.round(Number((data || {}).clipPage)) || 1, 1);
    this._pageRaw = 0;
  }

  /**
   * The controls' values and the page the clip channel is on.
   *
   * @readonly
   * @type {Object}
   */
  get showData() {
    const data = super.showData;
    if (this._params.clipPage) data.clipPage = this._page;
    return data;
  }

  /**
   * Takes a DMX byte. A file's page channel is not a control of its own: it
   * moves the clip channel's cue to its page, see `laser_parts.js`.
   *
   * @public
   * @param {Number} index byte offset within the fixture
   * @param {Number} dmx 0-255
   */
  writeChannel(index, dmx) {
    const page = this._params.clipPage;
    const byte = page ? index - (page.channel - 1) : -1;
    if (byte < 0 || byte >= page.bits / 8) {
      super.writeChannel(index, dmx);
      return;
    }
    const shift = (page.bits / 8 - 1 - byte) * 8;
    const level = Math.min(Math.max(Number(dmx) || 0, 0), 255);
    // eslint-disable-next-line no-bitwise
    this._pageRaw = ((this._pageRaw & ~(0xff << shift)) | (level << shift)) >>> 0;
    const value = page.steps ? valueInRange(page.steps, this._pageRaw) : this._pageRaw;
    // Page 0 is a file's "Disabled": the cue stays on the first page.
    this._page = Math.max(Number(value) || 0, 1);
  }

  /**
   * The spin, in degrees a second clockwise.
   *
   * @readonly
   * @type {Number}
   */
  get spinRate() {
    return (clamp(this.value('spin'), -FULL, FULL, 0) / FULL) * SPIN_AT_FULL;
  }

  /**
   * Whether the spin channel sits in its file's Reset range, which puts the
   * figure back at its own angle rather than holding where the spin left it.
   *
   * @readonly
   * @type {Boolean}
   */
  get spinResets() {
    const curve = this._params.dmxCurves && this._params.dmxCurves.spin;
    if (!curve || curve.reset === undefined || !this.hasLive('spin')) return false;
    return (this._raw.spin || 0) <= curve.reset;
  }

  /**
   * How fast a played clip runs against the scene clock: the scan rate times
   * the speed, 1 at 100 % each.
   *
   * @readonly
   * @type {Number}
   */
  get clipClock() {
    return this.scanShare * (clamp(this.value('speed'), 0, 4 * FULL, FULL) / FULL);
  }

  /**
   * The laser's point rate against the clip's, 0..2.
   *
   * @readonly
   * @type {Number}
   */
  get scanShare() {
    return clamp(this.value('scanRate'), 0, 2 * FULL, FULL) / FULL;
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
    return (clamp(this.value('dimmer'), 0, FULL, FULL) / FULL)
      * (clamp(this.value('dimmerLimit'), 0, FULL, FULL) / FULL);
  }

  /**
   * The clip this laser plays when it plays from its list, or null.
   *
   * @readonly
   * @type {Object|null}
   */
  get currentClip() {
    const selection = this.value('clip');
    // A channel at 0 picks no clip; by hand, no choice yet means the first.
    if (selection === null && this.isDriven('clip')) return null;
    const page = this._params.clipPage;
    // A number is a position from the channel, on the page's.
    if (page && typeof selection === 'number') {
      return selectedClip(this.value('clips'), selection + (this._page - 1) * page.perPage);
    }
    return selectedClip(this.value('clips'), selection);
  }

  /**
   * The test pattern overriding the input, or null when it is Off.
   *
   * @readonly
   * @type {Object|null}
   */
  get testPattern() {
    return testPatternClip(this.value('testPattern'));
  }
}

export default LaserSettings;
