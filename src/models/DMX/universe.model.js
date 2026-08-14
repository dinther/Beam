import ukColors from '@/views/components/uikit/colors/uikit.colors';
import FixturePool from './fixture.pool.model';
import PatchSingleton from './patch.model';

/**
 * DMX512 universe length
 *
 * @constant {Number} DMX_UNIVERSE_LENGTH
 */
const DMX_UNIVERSE_LENGTH = 512;
/**
 * Minimum universe ID
 *
 * @constant {Number} DMX_UNIVERSE_LENGTH
 */
const MIN_UNIVERSE_ID = 0;
/**
 * Maximum universe ID
 *
 * @constant {Number} DMX_UNIVERSE_LENGTH
 */
const MAX_UNIVERSE_ID = 65535;

/**
 * Default universe data
 *
 * @constant {Object} DEFAULT_UNIVERSE_DATA
 * @todo remove this ?
 */
const DEFAULT_UNIVERSE_DATA = {
  name: 'Universe',
};

/**
 * @class Universe
 * @classdesc Universes are a set of DMX compatible fixtures connected to the same.
 * DMX daisy chain using the same set of 512 DMX channels
 */
class Universe {
  /**
   * Creates an instance of Universe.
   *
   * @param {*} [data={}]
   * @param {Number} data.id Universe ID
   * @param {String} data.name Universe name
   * @param {String} data.color Universe color string
   * @memberof Universe
   */
  constructor(data = {}) {
    this.id = data.id;
    this.name = data.name;
    this.color = data.color;
    this.connection = null;
    this.fixturePool = new FixturePool();
    // The patch, address map and diffing shadow live in the show-wide address
    // space now; a universe is a 512-channel window onto it.
    this.diffInput = data.diffInput !== false;
  }

  /**
   * Whether inbound DMX frames are diffed against the previous frame, so that
   * unchanged channels are discarded instead of written through to fixtures.
   *
   * DMX repeats every channel on every frame by design, because on a real wire
   * a packet may be lost and the value has to be re-asserted. A visualizer has
   * no such wire: a value identical to the one already held cannot change what
   * is drawn, so writing it is pure cost. Measured against live MadMapper
   * output at 72 universes, roughly half of all inbound channels are unchanged
   * even on fast-moving content.
   *
   * Left switchable per universe because the saving depends on what the
   * universe drives. Skipping a write is worth most where the write is
   * expensive — a mover's pan channel recomputes transforms — and least where
   * it is trivial, such as a flat colour value.
   *
   * @memberof Universe
   * @type {Boolean}
   */
  // eslint-disable-next-line class-methods-use-this
  set diffInput(enabled) {
    PatchSingleton.diffInput = !!enabled;
  }

  // eslint-disable-next-line class-methods-use-this
  get diffInput() {
    return PatchSingleton.diffInput;
  }

  /**
   * Discards the diffing baseline, forcing the next inbound frame to be written
   * through in full.
   *
   * Required whenever fixture values may have been changed by something other
   * than an inbound frame — a patch change, or manual control — since the
   * shadow would otherwise claim a value is already set when it is not.
   *
   * @public
   */
  // eslint-disable-next-line class-methods-use-this
  invalidateInputShadow() {
    PatchSingleton.invalidateInputShadow();
  }

  /**
   * Universe color string
   *
   * @memberof Universe
   */
  set color(color) {
    this._color = color;
  }

  get color() {
    return this._color
      || ukColors[Object.keys(ukColors)[(this.id * 3) % Object.keys(ukColors).length]];
  }

  /**
   * Universe name
   *
   * @memberof Universe
   */
  set name(name) {
    this._name = name;
  }

  get name() {
    return this._name || `${DEFAULT_UNIVERSE_DATA.name} ${this.id}`;
  }

  /**
   * Universe ID
   *
   * @memberof Universe
   */
  set id(id) {
    this._id = Math.min(Math.max(parseInt(id, 10), MIN_UNIVERSE_ID), MAX_UNIVERSE_ID);
  }

  get id() {
    return this._id;
  }

  /**
   * Universe simplified channel set
   *
   * @memberof Universe
   */
  set simplifiedChannels(channels) {
    channels.forEach((channelData) => {
      const absolute = this.absolute(channelData.id - 1);
      const fixture = PatchSingleton.fixtureAt(absolute);
      if (fixture) {
        fixture.setChannel(absolute - fixture.address, channelData.value);
      }
    });
    // Values were set from outside the inbound frame path, so the diffing
    // baseline no longer reflects the fixtures' actual state.
    this.invalidateInputShadow();
  }

  get simplifiedChannels() {
    return this.fixturePool.fixtures.map((fixture) => fixture.simplifiedChannels).flat();
  }

  /**
   * Universe's DMX512 channel data buffer
   *
   * @memberof Universe
   */
  set DMX512Data(DMX512ValueBuffer) {
    PatchSingleton.writeUniverse(this.id, DMX512ValueBuffer);
  }

  get DMX512Data() {
    const DMX_BUFF = new Uint8Array(DMX_UNIVERSE_LENGTH);
    for (let channel = 0; channel < DMX_UNIVERSE_LENGTH; channel += 1) {
      const absolute = this.absolute(channel);
      const fixture = PatchSingleton.fixtureAt(absolute);
      if (fixture) {
        const fixtureChannel = fixture.channels[absolute - fixture.address];
        DMX_BUFF[channel] = (fixtureChannel && fixtureChannel.value.DMX) || 0;
      }
    }
    return DMX_BUFF;
  }

  /**
   * Writes a single DMX channel value through to whichever fixture is patched
   * at that address. Addresses with no fixture patched are ignored.
   *
   * @private
   * @param {Number} channel universe channel index (0-based)
   * @param {Number} value channel value (0-255)
   */
  writeChannel(channel, value) {
    PatchSingleton.writeChannel(this.absolute(channel), value);
  }

  /**
   * Universe's exportable show data chunk
   *
   * @readonly
   * @type {Object}
   */
  get showData() {
    // Display metadata only: which fixtures live here is derived from their
    // addresses, and diffing is a property of the whole address space.
    return {
      id: this.id,
      name: this.name,
      color: this.color,
    };
  }

  /**
   * Patch a fixture into the universe
   *
   * @public
   * @param {Object} fixture Fixture instance
   */
  patchFixture(fixture) {
    // The address space is global; a universe is one 512-channel window onto
    // it. Setting universe here only moves the fixture's absolute address.
    if (fixture.universe !== this.id) {
      fixture.universe = this.id;
    }
    PatchSingleton.patchFixture(fixture);
    this.fixturePool.addExisting(fixture);
  }

  /**
   * Unpatches a universe's fixture
   *
   * @public
   * @param {Object} fixture Fixture instance
   */
  unpatchFixture(fixture) {
    this.fixturePool.delete(fixture);
    PatchSingleton.unpatchFixture(fixture);
  }

  /**
   * Check whether or not a configuration is patchable
   *
   * @public
   * @param {Number} chStart start channel universe address
   * @param {Number} chCount Amount of channels to be patched
   * @return {Boolean} patching capability
   */
  checkPatchCapability(chStart, chCount) {
    return PatchSingleton.canPatch(this.absolute(chStart), chCount);
  }

  /**
   * Absolute address of a channel within this universe.
   *
   * @public
   * @param {Number} chStart universe-relative channel
   * @return {Number} absolute address
   */
  absolute(chStart) {
    return this.id * DMX_UNIVERSE_LENGTH + chStart;
  }

  /**
   * Check whether a set of N similar fixtures is patchable or not
   *
   * @public
   * @param {Number} chStart start channel universe address
   * @param {Number} chCount per-instance count of channels to be patched
   * @param {Number} amount Amount of instances to be patched
   * @return {Boolean} patching capability
   */
  canPatchMany(chStart, chCount, amount) {
    return PatchSingleton.canPatchMany(this.absolute(chStart), chCount, amount);
  }

  /**
   * Finds patch start address for a set of N similar fixtures
   *
   * @public
   * @param {Number} chCount per-instance count of channels to be patched
   * @param {Number} amount Amount of instances to be patched
   * @return {Number} Available address
   */
  findChStartAutoPatch(chCount, amount) {
    // Search from this universe's start, but no longer stop at its end: a run
    // that crosses the boundary is legal now.
    const address = PatchSingleton.findFreeAddress(chCount, amount, this.absolute(0));
    return address === -1 ? -1 : address - this.absolute(0);
  }

  /**
   * Manually remove universe instance reference from memory
   *
   * @private
   * @param {Object} instance handle to universe instance to be freed
   */
  static deleteInstance(instance) {
    Object.keys(instance).forEach((prop) => {
      delete instance[prop];
    });
    instance = null;
  }
}

export default Universe;
