import DeviceSettings, { FULL } from './device_settings';
import {
  ControlDef, EnumType, TextType, ChoiceType, clamp,
} from './device_control';
import { LASER_CHANNELS, CONTROL_DEFS } from './generic/laser';

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
 * Every protocol a laser may be *stored* as, so a show written before one was
 * withdrawn still loads and says what it was set to.
 */
export const LASER_PROTOCOLS = ['ponk', 'idn', 'etherdream', 'lasercube'];

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
export const SELECTABLE_PROTOCOLS = ['ponk', 'idn', 'etherdream'];

/** What each protocol is called on screen. */
export const PROTOCOL_LABELS = {
  ponk: 'Ponk',
  idn: 'IDN',
  etherdream: 'Ether Dream',
  lasercube: 'LaserCube',
};

/**
 * How the laser is fed. None of these is addressable, and that is the point:
 * they describe the rig, not the show.
 *
 * `protocol` is how the laser presents itself -- a real one has a DAC in it, so
 * "this is a LaserCube" belongs to the fixture. `address` is which of the
 * machine's addresses it lives at, which is what decides how many lasers a
 * protocol can carry: Ether Dream and LaserCube name a device only by its
 * address, so one laser each, while IDN offers a named service per laser at one
 * address. `source` holds the chosen stream, and nothing else -- a DAC stream
 * has no number a console could name it by.
 *
 * @constant {Array}
 */
const FEED_DEFS = [
  new ControlDef('protocol', 'Protocol', new EnumType({
    options: LASER_PROTOCOLS, initial: 'ponk', labels: PROTOCOL_LABELS,
  }), { addressable: false }),
  new ControlDef('address', 'Address', new TextType(), { addressable: false }),
  new ControlDef('source', 'Source', new ChoiceType({ source: 'dacStreams' }), {
    addressable: false, fixable: false,
  }),
];

/** Every attribute a laser holds: the output stage, plus how it is fed. */
export const LASER_DEFS = [...CONTROL_DEFS, ...FEED_DEFS];

class LaserSettings extends DeviceSettings {
  /**
   * @param {Object} params the profile's `asls.laser` -- the envelope
   * @param {Object} [data] stored values from the show
   */
  constructor(params, data = {}) {
    super(LASER_DEFS, params, data);
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
    return clamp(this.value('dimmer'), 0, FULL, FULL) / FULL;
  }
}

export default LaserSettings;
