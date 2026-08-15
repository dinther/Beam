import { toRaw } from 'vue';

/**
 * DMX512 universe length. Universes remain the unit the wire is addressed in —
 * an ArtDMX packet carries at most this many channels for one port address —
 * but they are no longer the unit fixtures are patched into.
 *
 * @constant {Number} DMX_UNIVERSE_LENGTH
 */
const DMX_UNIVERSE_LENGTH = 512;

/**
 * Absolute address of a fixture's nth channel.
 *
 * `pixelSize` is how many channels one pixel occupies, and saying it is more
 * than one asks for pixels to be kept whole. Such a fixture lays its pixels
 * out from its own start address and jumps to the beginning of the next
 * universe as soon as the following pixel would not fit in what is left, so
 * the number of channels stepped over is a remainder -- anywhere from none to
 * `pixelSize - 1` -- and depends on where the fixture starts.
 *
 * This replaces a fixed "skip 511 and 512", which was only ever this rule's
 * answer for a three-channel pixel starting on a universe boundary. Applied
 * globally it split pixels for any fixture out of phase with that grid: three
 * channels per pixel from address 100 put one pixel on 508, 509 and 512.
 *
 * A one-channel pixel can never be split, so 1 -- the default -- means the
 * channels simply run on, crossing boundaries freely.
 *
 * @param {Number} start fixture's absolute start address
 * @param {Number} index channel index within the fixture
 * @param {Number} [pixelSize] channels per pixel
 * @return {Number} absolute address of that channel
 */
function channelAddress(start, index, pixelSize = 1) {
  if (!(pixelSize > 1)) return start + index;
  const perUniverse = Math.floor(DMX_UNIVERSE_LENGTH / pixelSize);
  // A pixel wider than a universe cannot be kept whole wherever it is put.
  if (perUniverse < 1) return start + index;

  const universe = Math.floor(start / DMX_UNIVERSE_LENGTH);
  const offset = start % DMX_UNIVERSE_LENGTH;
  const inFirst = Math.floor((DMX_UNIVERSE_LENGTH - offset) / pixelSize);
  const pixel = Math.floor(index / pixelSize);
  const within = index % pixelSize;

  if (pixel < inFirst) return start + pixel * pixelSize + within;
  const beyond = pixel - inFirst;
  return (universe + 1 + Math.floor(beyond / perUniverse)) * DMX_UNIVERSE_LENGTH
    + (beyond % perUniverse) * pixelSize + within;
}

/**
 * Which channel of a fixture an absolute address corresponds to.
 *
 * The inverse of `channelAddress`, and it has to be told the same pixel size.
 *
 * @param {Number} start fixture's absolute start address
 * @param {Number} address absolute address
 * @param {Number} [pixelSize] channels per pixel
 * @return {Number} channel index within the fixture
 */
function channelIndexAt(start, address, pixelSize = 1) {
  if (!(pixelSize > 1)) return address - start;
  const perUniverse = Math.floor(DMX_UNIVERSE_LENGTH / pixelSize);
  if (perUniverse < 1) return address - start;

  const universe = Math.floor(start / DMX_UNIVERSE_LENGTH);
  const offset = start % DMX_UNIVERSE_LENGTH;
  const here = Math.floor(address / DMX_UNIVERSE_LENGTH);
  const at = address % DMX_UNIVERSE_LENGTH;

  if (here === universe) {
    return Math.floor((at - offset) / pixelSize) * pixelSize + ((at - offset) % pixelSize);
  }
  const inFirst = Math.floor((DMX_UNIVERSE_LENGTH - offset) / pixelSize);
  const pixel = inFirst + (here - universe - 1) * perUniverse + Math.floor(at / pixelSize);
  return pixel * pixelSize + (at % pixelSize);
}

/**
 * @class PatchMap
 * @classdesc The show's DMX address space, as one continuous run of channels
 * rather than a set of 512-channel islands.
 *
 * A fixture holds a single absolute address; which universe that lands in is
 * arithmetic (`address / 512`), not ownership. A fixture whose channels cross a
 * universe boundary therefore needs no special handling: its channels are
 * contiguous here, and each inbound frame fills in the part of the range it
 * happens to cover.
 */
class PatchMap {
  constructor() {
    /**
     * Fixtures by absolute start address.
     *
     * @type {Map<Number, Object>}
     */
    this._patch = new Map();
    /**
     * Absolute channel -> start address of the fixture occupying it. Sparse by
     * design: the address space is 32768 universes wide and a show uses a
     * handful of runs of it.
     *
     * @type {Map<Number, Number>}
     */
    this._addressMap = new Map();
    /**
     * Last inbound frame per universe, for diffing. Allocated on first frame.
     *
     * @type {Map<Number, Uint8Array>}
     */
    this._shadows = new Map();
    /**
     * Which universes hold a shadow that is safe to diff against.
     *
     * @type {Set<Number>}
     */
    this._primed = new Set();
    this.diffInput = true;
  }

  /**
   * Whether inbound frames are diffed against the previous frame, so that
   * unchanged channels are discarded instead of written through to fixtures.
   *
   * DMX repeats every channel on every frame by design, because on a real wire
   * a packet may be lost and the value has to be re-asserted. A visualizer has
   * no such wire: a value identical to the one already held cannot change what
   * is drawn, so writing it is pure cost.
   *
   * @type {Boolean}
   */
  set diffInput(enabled) {
    this._diffInput = !!enabled;
    // The shadows are meaningless until a full pass has repopulated them.
    this.invalidateInputShadow();
  }

  get diffInput() {
    return this._diffInput;
  }

  /**
   * Discards the diffing baseline, forcing the next inbound frame of every
   * universe to be written through in full.
   *
   * Required whenever fixture values may have changed by some route other than
   * an inbound frame — a patch change, or manual control — since a shadow would
   * otherwise claim a value is already set when it is not.
   *
   * @public
   */
  invalidateInputShadow() {
    this._primed.clear();
  }

  /**
   * Whether a run of channels is free.
   *
   * @public
   * @param {Number} address absolute start address
   * @param {Number} chCount how many channels the run occupies
   * @param {Object} [ignore] fixture whose own channels should not count as
   *                          occupied, for re-addressing an existing fixture
   * @return {Boolean} whether the run can be patched
   */
  canPatch(address, chCount, ignore = null, pixelSize = 1) {
    if (address < 0 || chCount <= 0) return false;
    // The start address is where the first channel actually is, so a fixture
    // keeping its pixels whole may not start so late in a universe that its
    // first pixel would have to begin in the next one.
    if (pixelSize > 1 && pixelSize <= DMX_UNIVERSE_LENGTH
      && DMX_UNIVERSE_LENGTH - (address % DMX_UNIVERSE_LENGTH) < pixelSize) {
      return false;
    }
    const ignoreAddress = ignore ? ignore.address : null;
    for (let i = 0; i < chCount; i++) {
      const occupant = this._addressMap.get(channelAddress(address, i, pixelSize));
      if (occupant !== undefined && occupant !== ignoreAddress) return false;
    }
    return true;
  }

  /**
   * Whether a set of N identical fixtures, laid end to end, is patchable.
   *
   * @public
   * @param {Number} address absolute start address
   * @param {Number} chCount per-instance channel count
   * @param {Number} amount how many instances
   * @return {Boolean} whether the whole run can be patched
   */
  canPatchMany(address, chCount, amount, pixelSize = 1) {
    return this.canPatch(address, chCount * amount, null, pixelSize);
  }

  /**
   * Finds the first free run big enough for a set of fixtures.
   *
   * Unlike the per-universe search this replaces, the run may cross a universe
   * boundary, so the only limit is the end of the address space.
   *
   * @public
   * @param {Number} chCount per-instance channel count
   * @param {Number} amount how many instances
   * @param {Number} [from] absolute address to start searching from
   * @return {Number} absolute address, or -1 when nothing fits
   */
  findFreeAddress(chCount, amount = 1, from = 0, pixelSize = 1) {
    const total = chCount * amount;
    if (total <= 0) return -1;
    const limit = this.addressSpaceLength - total;
    for (let i = from; i <= limit; i++) {
      if (this.canPatch(i, total, null, pixelSize)) return i;
      // Skip past whatever blocked us rather than retesting its every channel.
      const occupant = this._addressMap.get(i);
      if (occupant !== undefined) {
        const blocker = this._patch.get(occupant);
        if (blocker) {
          // Where the blocker really ends, not where counting its channels
          // from its start would put it: a fixture keeping its pixels whole
          // steps over the tail of a universe, so it reaches further than its
          // channel count suggests. Taking
          // the shorter figure lands back inside the blocker, and since the
          // jump may then be backwards from here, the search sits on the same
          // address forever. Only ever move forwards.
          const last = channelAddress(
            occupant,
            blocker.channels.length - 1,
            blocker.alignmentPixelSize,
          );
          if (last > i) i = last;
        }
      }
    }
    return -1;
  }

  /**
   * Total addressable channels: 32768 universes of 512.
   *
   * @readonly
   * @type {Number}
   */
  // eslint-disable-next-line class-methods-use-this
  get addressSpaceLength() {
    return 32768 * DMX_UNIVERSE_LENGTH;
  }

  /**
   * Claims a fixture's channels.
   *
   * @public
   * @param {Object} fixture Fixture instance carrying an absolute address
   */
  patchFixture(handle) {
    // The show is reactive, so a fixture arriving from the UI is a Vue proxy
    // while the one stored here is raw. The map is keyed on identity, and a
    // proxy never equals its target -- which silently turned re-addressing
    // into a no-op that left the old channels claimed. Normalised on entry so
    // everything in the map is raw.
    const fixture = toRaw(handle);
    const chCount = fixture.channels.length;
    const pixelSize = fixture.alignmentPixelSize;
    if (!this.canPatch(fixture.address, chCount, fixture, pixelSize)) {
      throw new Error('Cannot patch fixture on this interval');
    }
    this.unpatchFixture(fixture);
    this._patch.set(fixture.address, fixture);
    for (let i = 0; i < chCount; i++) {
      this._addressMap.set(channelAddress(fixture.address, i, pixelSize), fixture.address);
    }
    // The new fixture's channels start at zero regardless of what a shadow
    // remembers for those addresses.
    this.invalidateInputShadow();
  }

  /**
   * Releases a fixture's channels.
   *
   * @public
   * @param {Object} fixture Fixture instance to unpatch
   */
  unpatchFixture(handle) {
    const fixture = toRaw(handle);
    const existing = this._patch.get(fixture.address);
    if (existing !== fixture) return;
    this._patch.delete(fixture.address);
    const chCount = fixture.channels.length;
    const pixelSize = fixture.alignmentPixelSize;
    for (let i = 0; i < chCount; i++) {
      const address = channelAddress(fixture.address, i, pixelSize);
      if (this._addressMap.get(address) === fixture.address) this._addressMap.delete(address);
    }
    this.invalidateInputShadow();
  }

  /**
   * Drops every patched fixture.
   *
   * @public
   */
  clearAll() {
    this._patch.clear();
    this._addressMap.clear();
    this._shadows.clear();
    this.invalidateInputShadow();
  }

  /**
   * Whether a fixture currently holds a claim at its own address.
   *
   * @public
   * @param {Object} fixture Fixture instance
   * @return {Boolean} whether it is patched
   */
  isPatched(handle) {
    const fixture = toRaw(handle);
    return this._patch.get(fixture.address) === fixture;
  }

  /**
   * Fixture occupying an absolute channel, if any.
   *
   * @public
   * @param {Number} channel absolute channel
   * @return {Object} Fixture instance, or null
   */
  fixtureAt(channel) {
    const start = this._addressMap.get(channel);
    return start === undefined ? null : this._patch.get(start) || null;
  }

  /**
   * Writes one absolute channel through to whichever fixture holds it.
   *
   * @public
   * @param {Number} channel absolute channel
   * @param {Number} value DMX value
   */
  writeChannel(channel, value) {
    const start = this._addressMap.get(channel);
    if (start === undefined) return;
    const fixture = this._patch.get(start);
    if (!fixture) return;
    fixture.setChannel(channelIndexAt(start, channel, fixture.alignmentPixelSize), value);
  }

  /**
   * Feeds an inbound Art-Net frame into the address space.
   *
   * The frame's universe number only decides where in the address space it
   * lands; a fixture straddling the boundary is filled by two frames, each
   * writing the channels it covers.
   *
   * @public
   * @param {Number} universe Art-Net universe the frame was addressed to
   * @param {Uint8Array} data channel values, at most 512 of them
   */
  writeUniverse(universe, data) {
    const length = Math.min(data.length, DMX_UNIVERSE_LENGTH);
    const offset = universe * DMX_UNIVERSE_LENGTH;

    if (this._diffInput) {
      let shadow = this._shadows.get(universe);
      if (!shadow) {
        shadow = new Uint8Array(DMX_UNIVERSE_LENGTH);
        this._shadows.set(universe, shadow);
      }
      if (this._primed.has(universe)) {
        for (let channel = 0; channel < length; channel += 1) {
          const value = data[channel];
          if (value !== shadow[channel]) {
            shadow[channel] = value;
            this.writeChannel(offset + channel, value);
          }
        }
        return;
      }
      for (let channel = 0; channel < length; channel += 1) {
        this.writeChannel(offset + channel, data[channel]);
      }
      shadow.set(data.subarray(0, length));
      this._primed.add(universe);
      return;
    }

    for (let channel = 0; channel < length; channel += 1) {
      this.writeChannel(offset + channel, data[channel]);
    }
  }
}

/**
 * The show's single address space. A singleton for the same reason the show is
 * one: there is one rig, and both the models and the Art-Net input path need to
 * reach it without importing each other in a circle.
 */
const PatchSingleton = new PatchMap();

export default PatchSingleton;
export {
  PatchMap,
  DMX_UNIVERSE_LENGTH,
  channelAddress,
  channelIndexAt,
};
