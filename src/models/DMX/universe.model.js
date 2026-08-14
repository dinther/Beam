import ukColors from '@/views/components/uikit/colors/uikit.colors';
import FixturePool from './fixture.pool.model';

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
 * Universe channels lengh
 *
 * @constant {Number} DMX_UNIVERSE_CHANNELS_LENGTH
 */
const DMX_UNIVERSE_CHANNELS_LENGTH = 512;

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
    this._patch = {};
    this._addressMap = new Array(DMX_UNIVERSE_LENGTH).fill(undefined);
    this.fixturePool = new FixturePool();
    // Last inbound frame, used to skip channels whose value did not change.
    this._inputShadow = new Uint8Array(DMX_UNIVERSE_CHANNELS_LENGTH);
    this._shadowPrimed = false;
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
  set diffInput(enabled) {
    this._diffInput = !!enabled;
    // The shadow is meaningless until a full pass has populated it.
    this._shadowPrimed = false;
  }

  get diffInput() {
    return this._diffInput;
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
  invalidateInputShadow() {
    this._shadowPrimed = false;
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
      const fixtureAddress = this._addressMap[channelData.id - 1];
      const fixtureChannel = channelData.id - fixtureAddress - 1;
      if (this._patch[fixtureAddress]) {
        this._patch[fixtureAddress].setChannel(fixtureChannel, channelData.value);
      }
    });
    // Values were set from outside the inbound frame path, so the diffing
    // baseline no longer reflects the fixtures' actual state.
    this.invalidateInputShadow();
  }

  get simplifiedChannels() {
    if (this._patch) {
      return Object.keys(this._patch).map((fixtureAddress) => {
        const fixture = this._patch[fixtureAddress];
        return fixture.simplifiedChannels;
      }).flat() || [];
    }
    return [];
  }

  /**
   * Universe's DMX512 channel data buffer
   *
   * @memberof Universe
   */
  set DMX512Data(DMX512ValueBuffer) {
    const length = Math.min(DMX512ValueBuffer.length, DMX_UNIVERSE_LENGTH);

    if (this._diffInput && this._shadowPrimed) {
      const shadow = this._inputShadow;
      for (let channel = 0; channel < length; channel += 1) {
        const value = DMX512ValueBuffer[channel];
        if (value !== shadow[channel]) {
          shadow[channel] = value;
          this.writeChannel(channel, value);
        }
      }
      return;
    }

    // Full pass: either diffing is off, or the shadow needs (re)populating.
    for (let channel = 0; channel < length; channel += 1) {
      const value = DMX512ValueBuffer[channel];
      this.writeChannel(channel, value);
    }
    if (this._diffInput) {
      this._inputShadow.set(DMX512ValueBuffer.subarray(0, length));
      this._shadowPrimed = true;
    }
  }

  get DMX512Data() {
    const DMX_PACKET_LENGTH = 512;
    const DMX_BUFF = new Uint8Array(DMX_PACKET_LENGTH);
    this._addressMap.forEach((address, index) => {
      const fixture = this._patch[address];
      if (fixture) {
        const fixtureChannelIndex = index - fixture.chStart;
        DMX_BUFF[index] = fixture.channels[fixtureChannelIndex].value.DMX || 0;
      } else {
        DMX_BUFF[index] = 0;
      }
    });
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
    const fixtureAddress = this._addressMap[channel];
    const fixture = this._patch[fixtureAddress];
    if (fixture) {
      fixture.setChannel(channel - fixtureAddress, value);
    }
  }

  /**
   * Universe's exportable show data chunk
   *
   * @readonly
   * @type {Object}
   */
  get showData() {
    return {
      id: this.id,
      name: this.name,
      color: this.color,
      diffInput: this.diffInput,
      fixtures: this.fixturePool.showData,
    };
  }

  /**
   * Patch a fixture into the universe
   *
   * @public
   * @param {Object} fixture Fixture instance
   */
  patchFixture(fixture) {
    if (this.checkPatchCapability(fixture.chStart, fixture.chCount)) {
      fixture.universe = this.id;
      this._patch[fixture.chStart] = fixture;
      this.fixturePool.addExisting(fixture);
      for (let i = fixture.chStart; i < fixture.chStop; i++) {
        this._addressMap[i] = fixture.chStart;
      }
      // The new fixture's channels start at zero regardless of what the shadow
      // remembers for those addresses.
      this.invalidateInputShadow();
    } else {
      throw new Error('Cannot patch fixture on this interval');
    }
  }

  /**
   * Unpatches a universe's fixture
   *
   * @public
   * @param {Object} fixture Fixture instance
   */
  unpatchFixture(fixture) {
    this.fixturePool.delete(fixture);
    delete this._patch[fixture.chStart];
    this._addressMap = this._addressMap.map((address) => (
      address === fixture.chStart
        ? undefined
        : address
    ));
    this.invalidateInputShadow();
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
    const chStop = chStart + chCount;
    // eslint-disable-next-line consistent-return
    Object.keys(this._patch).forEach((fixtureAddress) => {
      const fixture = this._patch[fixtureAddress];
      if (chStart <= fixture.chStop && fixture.chStart <= chStop) {
        return false;
      }
    });
    return true;
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
    const total = chCount * amount;
    for (let i = chStart; i < chStart + total; i++) {
      if (this._addressMap[i]) {
        return false;
      }
    }
    return true;
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
    const total = chCount * amount;
    for (let i = 0; i < DMX_UNIVERSE_LENGTH; i++) {
      let canPatch = true;
      for (let j = 0; j < total; j++) {
        if (j + i >= DMX_UNIVERSE_LENGTH || this._addressMap[j + i] != null) {
          canPatch = false;
          break;
        }
      }
      if (canPatch) {
        return i;
      }
    }
    return -1;
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
