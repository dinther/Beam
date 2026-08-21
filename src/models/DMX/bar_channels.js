import { COMPONENTS } from './generic/led_bar';

/**
 * @file A generated bar's channels, as a range rather than as objects.
 *
 * Every channel of a generated bar is the same thing: an 8-bit colour
 * intensity for one component of one pixel. A 256 x 256 tile has 196,608 of
 * them, and building a `Channel` for each cost 185 ms and most of 300 MB, to
 * describe something six numbers already say. All of them share one `type`
 * ('Color') and one of three capability shapes, differing only in an index and
 * a colour name -- both of which are arithmetic on the channel's position.
 *
 * So the values live in a `Uint8Array` and everything else is derived on
 * demand. Adding a panel stops allocating per channel, and the inbound Art-Net
 * path -- which for a bar only ever writes a number -- becomes an array store.
 *
 * This is deliberately **not** a general channel container. It works because
 * every pixel of a bar is treated identically; a fixture whose channels mean
 * different things still gets one `Channel` each, and should.
 *
 * @see channel.model.js for the object this replaces
 */

/** What a bar's channels all are. `setChannelTypes` maps ColorIntensity here. */
const BAR_CHANNEL_TYPE = 'Color';

/**
 * One channel of a bar, made when something actually asks for one.
 *
 * A view onto the range rather than a copy of it: `value` reads and writes
 * through to the owner's array, so a flyweight handed out and kept still sees
 * live DMX. Nothing caches these -- they exist for the widget's table and for
 * the odd `find`, both cold paths.
 *
 * @class BarChannel
 */
class BarChannel {
  /**
   * @param {BarChannels} owner the range this belongs to
   * @param {Number} index 0-based position in the range
   */
  constructor(owner, index) {
    this.owner = owner;
    this.index = index;
    /** 1-based, matching `Channel.id`, which callers turn back into an index. */
    this.id = index + 1;
    this.type = BAR_CHANNEL_TYPE;
    this.color = owner.componentAt(index);
    this.name = owner.nameAt(index);
    this.isFine = false;
    this.active = true;
    /** No bar has a 16-bit channel, and `setChannel` tests this length. */
    this.fineChannels = [];
    this.fineChannelAliases = null;
    this.qaIndex = index;
  }

  /**
   * DMX value, shaped as `Channel` shapes it.
   *
   * @type {Object}
   */
  get value() {
    return { DMX: this.owner.valueAt(this.index), model: 0 };
  }

  set value(value) {
    this.owner.setValueAt(this.index, value);
  }
}

/**
 * A bar's channels, addressed by index and stored as bytes.
 *
 * Implements the part of `Array` that fixtures and the UI actually use --
 * `length`, `map`, `forEach`, `find` and indexed access through `at` -- and
 * nothing else. Anything reaching for a method that is not here is asking a
 * question a bar cannot answer cheaply, and should be looked at rather than
 * quietly served.
 *
 * @class BarChannels
 */
class BarChannels {
  /**
   * @param {Object} bar the profile's `asls.bar` parameters
   */
  constructor(bar) {
    const order = String((bar && bar.order) || '').toUpperCase();
    /** Component names in wire order, e.g. ['Red','Green','Blue']. */
    this.components = order.split('')
      .filter((letter) => COMPONENTS[letter])
      .map((letter) => COMPONENTS[letter]);
    this.pixels = Math.max(0, (bar.columns || 0) * (bar.rows || 0));
    this.length = this.pixels * this.components.length;
    this.values = new Uint8Array(this.length);
  }

  /**
   * Which component a channel carries.
   *
   * @param {Number} index 0-based channel index
   * @returns {String} colour name
   */
  componentAt(index) {
    return this.components[index % this.components.length];
  }

  /**
   * A channel's name, the same one `ledBarChannels` writes into the profile.
   *
   * @param {Number} index 0-based channel index
   * @returns {String} e.g. 'P17 Green'
   */
  nameAt(index) {
    const pixel = Math.floor(index / this.components.length) + 1;
    return `P${pixel} ${this.componentAt(index)}`;
  }

  /**
   * @param {Number} index 0-based channel index
   * @returns {Number} DMX value, 0-255
   */
  valueAt(index) {
    return this.values[index] || 0;
  }

  /**
   * @param {Number} index 0-based channel index
   * @param {Number} value DMX value; clamped and rounded by the caller
   */
  setValueAt(index, value) {
    if (index < 0 || index >= this.length) return;
    this.values[index] = value;
  }

  /** Sets every channel to one value, without materialising any of them. */
  fill(value) {
    this.values.fill(value);
  }

  /**
   * A channel, built on demand.
   *
   * @param {Number} index 0-based channel index
   * @returns {BarChannel|undefined}
   */
  at(index) {
    if (index < 0 || index >= this.length) return undefined;
    return new BarChannel(this, index);
  }

  /**
   * @param {Function} fn callback, given `(channel, index)`
   * @returns {Array}
   */
  map(fn) {
    const out = new Array(this.length);
    for (let i = 0; i < this.length; i += 1) out[i] = fn(new BarChannel(this, i), i);
    return out;
  }

  /**
   * @param {Function} fn callback, given `(channel, index)`
   */
  forEach(fn) {
    for (let i = 0; i < this.length; i += 1) fn(new BarChannel(this, i), i);
  }

  /**
   * @param {Function} fn predicate, given `(channel, index)`
   * @returns {BarChannel|undefined}
   */
  find(fn) {
    for (let i = 0; i < this.length; i += 1) {
      const channel = new BarChannel(this, i);
      if (fn(channel, i)) return channel;
    }
    return undefined;
  }
}

export { BarChannel };
export default BarChannels;
