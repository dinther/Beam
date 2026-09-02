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
 * The lowest address at or after `address` that a fixture may start on.
 *
 * A fixture keeping its pixels whole cannot begin so late in a universe that
 * its first pixel would not fit in what is left: the tail is dead space and
 * the fixture starts at the next universe instead. Everything else, including
 * a pixel too wide to ever be kept whole, starts exactly where it is put.
 *
 * @param {Number} address absolute address to start looking from
 * @param {Number} [pixelSize] channels per pixel
 * @return {Number} first legal start address at or after it
 */
function alignedStart(address, pixelSize = 1) {
  if (!(pixelSize > 1) || pixelSize > DMX_UNIVERSE_LENGTH) return address;
  const offset = address % DMX_UNIVERSE_LENGTH;
  if (DMX_UNIVERSE_LENGTH - offset >= pixelSize) return address;
  return address + (DMX_UNIVERSE_LENGTH - offset);
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
     * Every patched fixture as one span, in address order and never
     * overlapping.
     *
     * This replaces a Map holding one entry per DMX channel. A 512 x 512 panel
     * is 786,432 channels, so that map was 786,432 entries saying "these all
     * belong to one fixture" -- rebuilt on every patch, and probed once per
     * channel per frame. A rig has tens of fixtures, not hundreds of thousands
     * of channels, so the index that matters is over fixtures: a lookup
     * becomes a binary search and a patch becomes an insert.
     *
     * A span reaches from the fixture's address to where its last channel
     * really lands -- `channelAddress`, never `start + length`, which a
     * fixture keeping its pixels whole outruns.
     *
     * @type {Array<Object>}
     */
    this._runs = [];
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
   * Index of the first run ending at or after an address.
   *
   * Runs never overlap and are held in address order, so this doubles as the
   * insertion point for a new run starting there.
   *
   * @public
   * @param {Number} address absolute channel
   * @return {Number} index into the run list, possibly its length
   */
  seekRun(address) {
    let lo = 0;
    let hi = this._runs.length;
    while (lo < hi) {
      // eslint-disable-next-line no-bitwise
      const mid = (lo + hi) >> 1;
      if (this._runs[mid].end < address) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * The run whose span covers an address, if any.
   *
   * Covering the span is not the same as occupying the channel. A fixture
   * keeping its pixels whole leaves the unfillable tail of each universe
   * empty, and those channels sit inside its span while belonging to none of
   * its channels. Anything that needs the channel itself has to confirm by
   * asking `channelAddress` where that index actually landed.
   *
   * @public
   * @param {Number} address absolute channel
   * @return {Object} run, or null
   */
  runAt(address) {
    const run = this._runs[this.seekRun(address)];
    return run && run.start <= address ? run : null;
  }

  /**
   * Whether a run of channels is free.
   *
   * @public
   * @param {Number} address absolute start address
   * @param {Number} chCount how many channels the run occupies
   * Spans are treated as solid, so the dead tail a pixel-aligned fixture
   * leaves at the end of each universe counts as occupied. Nothing could
   * usefully live in those one or two orphan channels -- they exist precisely
   * because a pixel would not fit -- and taking them as part of the fixture is
   * what lets a patched rig be an ordered list of spans rather than a map of
   * every channel.
   *
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
    const end = channelAddress(address, chCount - 1, pixelSize);
    for (let i = this.seekRun(address); i < this._runs.length; i += 1) {
      const run = this._runs[i];
      if (run.start > end) break;
      if (run.start !== ignoreAddress) return false;
    }
    return true;
  }

  /**
   * Start addresses for a set of N identical fixtures laid end to end.
   *
   * Each one begins where the one before it really ended, which is not its
   * start plus its channel count: a fixture keeping its pixels whole steps
   * over the tail of a universe, so it reaches further than counting suggests.
   * Spacing a batch by channel count alone therefore lands every fixture after
   * the first boundary crossing inside its predecessor.
   *
   * The first address is returned as given, dead space or not, so that an
   * address the user typed is validated rather than silently moved.
   *
   * @public
   * @param {Number} address absolute start address
   * @param {Number} chCount per-instance channel count
   * @param {Number} amount how many instances
   * @param {Number} [pixelSize] channels per pixel
   * @return {Array<Number>} one absolute start address per instance
   */
  // eslint-disable-next-line class-methods-use-this
  addressRun(address, chCount, amount, pixelSize = 1) {
    const run = [];
    if (address < 0 || chCount <= 0 || amount <= 0) return run;
    let start = address;
    for (let i = 0; i < amount; i += 1) {
      run.push(start);
      start = alignedStart(channelAddress(start, chCount - 1, pixelSize) + 1, pixelSize);
    }
    return run;
  }

  /**
   * Whether a set of N identical fixtures, laid end to end, is patchable.
   *
   * Each instance is tested where it will actually be addressed, rather than
   * the batch being collapsed into one long fixture: the two are laid out
   * differently once pixels are kept whole, and the long-fixture answer said
   * yes to batches that could not then be patched.
   *
   * @public
   * @param {Number} address absolute start address
   * @param {Number} chCount per-instance channel count
   * @param {Number} amount how many instances
   * @param {Number} [pixelSize] channels per pixel
   * @return {Boolean} whether the whole run can be patched
   */
  canPatchMany(address, chCount, amount, pixelSize = 1) {
    const run = this.addressRun(address, chCount, amount, pixelSize);
    if (!run.length || run.length !== amount) return false;
    const last = channelAddress(run[run.length - 1], chCount - 1, pixelSize);
    if (last >= this.addressSpaceLength) return false;
    return run.every((start) => this.canPatch(start, chCount, null, pixelSize));
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
    // A run occupies at least its channel count, so nothing can start later
    // than this even when the layout stretches it further.
    const limit = this.addressSpaceLength - total;
    let i = Math.max(from, 0);
    while (i <= limit) {
      if (this.canPatchMany(i, chCount, amount, pixelSize)) return i;
      // Skip past whatever blocked us rather than retesting every address in
      // between. This used to step one channel at a time and jump only when it
      // landed *on* an occupied channel, so a free gap merely too small for the
      // run was walked byte by byte -- which for a panel's channel counts is
      // hundreds of thousands of probes to cross ground already known to be
      // free. A run carries where it really ends, so the whole blocker is one
      // step.
      const placed = this.addressRun(i, chCount, amount, pixelSize);
      const end = placed.length === amount
        ? channelAddress(placed[placed.length - 1], chCount - 1, pixelSize)
        : i;
      let next = i + 1;
      const blocker = this._runs[this.seekRun(i)];
      if (blocker && blocker.start <= end) next = blocker.end + 1;
      // A fixture keeping its pixels whole can also be refused for starting too
      // late in a universe to fit one; this moves past exactly that tail.
      next = alignedStart(next, pixelSize);
      // Only ever forwards. A jump that can move backwards is what turned an
      // off-by-some into a silent hang the last time this loop was wrong.
      i = next > i ? next : i + 1;
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
    // A fixture may legitimately have no channels at all: most projectors have
    // no DMX socket, and one is still worth placing because it shows where the
    // image lands. It claims no address space, so patching it is a **no-op
    // rather than an error** -- there is nothing to collide with and nothing to
    // record. Without this, `Show.patchFixtures` throws part way through
    // loading any show that contains one, which is a far worse failure than
    // the dialog's, and it takes the rest of the rig with it.
    if (chCount <= 0) return;
    const pixelSize = fixture.alignmentPixelSize;
    if (!this.canPatch(fixture.address, chCount, fixture, pixelSize)) {
      throw new Error('Cannot patch fixture on this interval');
    }
    this.unpatchFixture(fixture);
    this._patch.set(fixture.address, fixture);
    this._runs.splice(this.seekRun(fixture.address), 0, {
      start: fixture.address,
      end: channelAddress(fixture.address, chCount - 1, pixelSize),
      chCount,
      pixelSize,
      fixture,
      // Asked once, here, rather than per universe per frame.
      takesRange: !!fixture.takesChannelRange,
    });
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
    const at = this.seekRun(fixture.address);
    if (this._runs[at] && this._runs[at].start === fixture.address) this._runs.splice(at, 1);
    this.invalidateInputShadow();
  }

  /**
   * Drops every patched fixture.
   *
   * @public
   */
  clearAll() {
    this._patch.clear();
    this._runs.length = 0;
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
    const run = this.runAt(channel);
    if (!run) return null;
    return this.indexIn(run, channel) < 0 ? null : run.fixture;
  }

  /**
   * Which channel of a run an absolute address is, or -1 if it is none of them.
   *
   * The span test in `runAt` is deliberately coarse; this is the exact one.
   * `channelIndexAt` inverts the layout only for addresses the fixture really
   * occupies -- handed one of the orphan channels in a universe tail it still
   * returns a plausible in-range index -- so the answer is only trusted once
   * `channelAddress` agrees it lands back where we asked.
   *
   * @public
   * @param {Object} run entry from the run list
   * @param {Number} channel absolute channel
   * @return {Number} channel index within the fixture, or -1
   */
  // eslint-disable-next-line class-methods-use-this
  indexIn(run, channel) {
    const index = channelIndexAt(run.start, channel, run.pixelSize);
    if (index < 0 || index >= run.chCount) return -1;
    if (run.pixelSize > 1 && channelAddress(run.start, index, run.pixelSize) !== channel) return -1;
    return index;
  }

  /**
   * Writes one absolute channel through to whichever fixture holds it.
   *
   * @public
   * @param {Number} channel absolute channel
   * @param {Number} value DMX value
   */
  writeChannel(channel, value) {
    const run = this.runAt(channel);
    if (!run) return;
    const index = this.indexIn(run, channel);
    if (index < 0) return;
    run.fixture.setChannel(index, value);
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
    if (length <= 0) return;
    const first = universe * DMX_UNIVERSE_LENGTH;
    const last = first + length - 1;

    let shadow = null;
    let primed = false;
    for (let i = this.seekRun(first); i < this._runs.length; i += 1) {
      const run = this._runs[i];
      if (run.start > last) break;
      if (run.takesRange) {
        this.writeRunBulk(run, first, length, data);
      } else {
        if (!shadow) {
          shadow = this.shadowFor(universe);
          primed = this._diffInput && this._primed.has(universe);
        }
        this.writeRunChannels(run, first, length, data, primed ? shadow : null);
      }
    }
    // Only universes carrying a fixture that pays per channel are worth
    // shadowing. A panel's are not: its write is already a memcpy, so diffing
    // one would cost the same read it saves.
    if (shadow) {
      shadow.set(data.subarray(0, length));
      this._primed.add(universe);
    }
  }

  /**
   * Every universe the patched rig actually occupies.
   *
   * Read off the run list, which is already the patch in address order, so a
   * fixture straddling a boundary contributes both of the universes it touches.
   *
   * sACN is what wants this: it arrives on one multicast group per universe,
   * and joining a group per universe in the whole space would be 32,768 IGMP
   * memberships where a real switch gives up in the hundreds. The rig's own
   * patch is the only honest answer to which ones are worth joining.
   *
   * @public
   * @return {Array} universe numbers, ascending
   */
  patchedUniverses() {
    const universes = new Set();
    this._runs.forEach((run) => {
      const first = Math.floor(run.start / DMX_UNIVERSE_LENGTH);
      const last = Math.floor(run.end / DMX_UNIVERSE_LENGTH);
      for (let universe = first; universe <= last; universe += 1) universes.add(universe);
    });
    return [...universes].sort((a, b) => a - b);
  }

  /**
   * The diffing baseline for a universe, made on first use.
   *
   * @public
   * @param {Number} universe Art-Net universe
   * @return {Uint8Array} shadow buffer, 512 long
   */
  shadowFor(universe) {
    let shadow = this._shadows.get(universe);
    if (!shadow) {
      shadow = new Uint8Array(DMX_UNIVERSE_LENGTH);
      this._shadows.set(universe, shadow);
    }
    return shadow;
  }

  /**
   * Routes the part of a frame a bar occupies, as one copy.
   *
   * This is the whole point of the run list. Within a single universe a
   * fixture's channels are contiguous in address *and* in index -- the only
   * break a pixel-aligned layout makes is the tail it cannot fill, which is
   * where this stops -- so the frame's bytes are already in the order the
   * fixture wants them and the routing is a `set` on a typed array.
   *
   * Nothing is diffed here. A bar's emitters read the DMX texture directly, so
   * the values being written feed the widget's table and little else; comparing
   * them against a shadow would read as many bytes as writing them.
   *
   * @public
   * @param {Object} run entry from the run list
   * @param {Number} first absolute address of the frame's channel 0
   * @param {Number} length channels the frame carries
   * @param {Uint8Array} data the frame
   */
  writeRunBulk(run, first, length, data) {
    const from = Math.max(run.start, first);
    const to = Math.min(run.end, first + length - 1);
    if (to < from) return;
    const index = this.indexIn(run, from);
    if (index < 0) return;
    const offset = from % DMX_UNIVERSE_LENGTH;
    // How many of its channels the fixture can still place in this universe:
    // the whole remainder when channels simply run on, and whole pixels only
    // when they are being kept intact.
    const room = run.pixelSize > 1
      ? Math.floor((DMX_UNIVERSE_LENGTH - offset) / run.pixelSize) * run.pixelSize
      : DMX_UNIVERSE_LENGTH - offset;
    const count = Math.min(run.chCount - index, room, to - from + 1);
    if (count <= 0) return;
    const at = from - first;
    run.fixture.setChannelRange(index, data.subarray(at, at + count));
  }

  /**
   * Routes the part of a frame a fixture occupies, one channel at a time.
   *
   * For anything but a bar a channel means something -- a capability lookup, a
   * write into the 3D model -- so this stays per channel, and keeps the diff
   * that makes an unchanged channel free. That is affordable here because such
   * a fixture has tens of channels, not hundreds of thousands.
   *
   * @public
   * @param {Object} run entry from the run list
   * @param {Number} first absolute address of the frame's channel 0
   * @param {Number} length channels the frame carries
   * @param {Uint8Array} data the frame
   * @param {Uint8Array} shadow previous frame to diff against, or null to
   *                            write every channel through
   */
  writeRunChannels(run, first, length, data, shadow) {
    const from = Math.max(run.start, first);
    const to = Math.min(run.end, first + length - 1);
    for (let address = from; address <= to; address += 1) {
      const at = address - first;
      const value = data[at];
      if (!shadow || shadow[at] !== value) {
        const index = this.indexIn(run, address);
        if (index >= 0) run.fixture.setChannel(index, value);
      }
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
