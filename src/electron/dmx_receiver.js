/* eslint-disable no-console */
import dgram from 'dgram';

/**
 * What every DMX-over-IP receiver does that has nothing to do with its protocol.
 *
 * Art-Net and sACN differ in two places only: which port they arrive on, and
 * what a packet looks like. Everything after that is identical and is the part
 * that took the tuning -- one reused buffer per universe so the hot path
 * allocates nothing, a dirty set, and one packed message per display frame
 * rather than one per packet. A rig sending a 256 x 256 tile is 386 universes
 * at 40 fps, which is 15,437 packets a second; the renderer cannot be woken
 * that often and does not need to be, because a later frame for a universe
 * wholly replaces an earlier one. That is what DMX means.
 *
 * So a protocol supplies a port and a `parse`, and inherits the rest. Written
 * as two classes it was going to be written twice, and the second copy is
 * where the frame rate quietly goes.
 *
 * Receive only, both protocols. This is a visualizer: whatever is driving the
 * rig owns the wire, and a second transmitter on it would only raise the
 * question of which application to believe.
 */

/** DMX512 universe payload length. */
export const DMX_LENGTH = 512;

/**
 * How often the accumulated universes are handed to the renderer, in ms.
 *
 * The display rate. Coalescing to it turns those 15,437 packets into about 60
 * messages a second carrying the same bytes.
 */
const FLUSH_INTERVAL = 16;

/** How often the receive log may repeat itself, in ms. */
const LOG_INTERVAL = 1000;

/**
 * How long a source may go quiet before it is treated as gone, in ms.
 *
 * E1.31's network data loss timeout. Art-Net has no such rule, but a source
 * that has stopped is the same event on either wire, and the answer is the
 * same: the values are held -- a rig that blacks out looks like a fault in
 * Beam -- and the source is marked stale so the readout can say so.
 */
const SOURCE_TIMEOUT_MS = 2500;

class DmxReceiver {
  /**
   * @param {Object} options
   * @param {String} options.name short protocol name, used in logs
   * @param {Number} options.port UDP port to bind
   */
  constructor({ name, port }) {
    this.name = name;
    this.port = port;
    this.socket = null;
    this.onFrames = null;
    this.bindAddress = '0.0.0.0';
    /** Latest values per universe, reused so the hot path allocates nothing. */
    this.buffers = new Map();
    /** Universes that changed since the last flush. */
    this.dirty = new Set();
    /**
     * Who is sending, keyed however the protocol identifies a source: a CID
     * for sACN, the sender's address for Art-Net, which carries no identity.
     */
    this.sources = new Map();
    this.flushTimer = null;
    this.rxCount = 0;
    this.lastLog = 0;
  }

  get listening() {
    return !!this.socket;
  }

  /**
   * Opens the socket and begins receiving.
   *
   * @param {(batch: {universes: Uint16Array, data: Uint8Array}) => void} onFrames
   * @param {Object} [opts]
   * @param {String} [opts.bind] local interface to bind (default 0.0.0.0)
   */
  start(onFrames, opts = {}) {
    this.onFrames = onFrames || this.onFrames;
    if (this.socket) return;

    this.bindAddress = opts.bind || '0.0.0.0';
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    socket.on('message', (msg, rinfo) => this.handleMessage(msg, rinfo));
    socket.on('error', (err) => {
      console.error(`[${this.name}] socket error:`, err);
      this.stop();
    });
    socket.bind(this.port, this.bindAddress, () => {
      this.onBound(socket, opts);
      console.log(`[${this.name}] listening on ${this.bindAddress}:${this.port}`);
    });

    this.socket = socket;
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL);
  }

  /**
   * Anything the protocol wants done once the socket is bound.
   *
   * @param {dgram.Socket} socket
   * @param {Object} opts the options `start` was given
   */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  onBound(socket, opts) {}

  /**
   * Reads one datagram. Returns what it found, or null if it was not ours.
   *
   * @param {Buffer} msg
   * @param {Object} rinfo sender address and port
   * @returns {Object|null} `{ universe, data, length, source }` -- `data` a
   *   Buffer view of the slots, `source` an optional
   *   `{ key, name, priority }` describing who sent it
   */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  parse(msg, rinfo) {
    return null;
  }

  /**
   * Takes a parsed frame into the universe buffers.
   *
   * @param {Buffer} msg
   * @param {Object} rinfo
   */
  handleMessage(msg, rinfo) {
    const frame = this.parse(msg, rinfo);
    if (!frame) return;
    const { universe } = frame;

    // One buffer per universe, reused. This runs 15,000 times a second on a
    // real rig, so it allocates nothing and copies in one go.
    let buffer = this.buffers.get(universe);
    if (!buffer) {
      buffer = new Uint8Array(DMX_LENGTH);
      this.buffers.set(universe, buffer);
    }
    const count = Math.min(frame.data.length, DMX_LENGTH);
    buffer.set(frame.data.subarray(0, count));
    // A short frame leaves the tail of a reused buffer holding the last
    // frame's values; a freshly allocated one used to be zero there.
    if (count < DMX_LENGTH) buffer.fill(0, count);

    this.dirty.add(universe);
    if (frame.source) this.noteSource(frame.source, universe);

    this.rxCount += 1;
    // Once a second, not every hundredth frame: at 15,000 frames a second that
    // rule wrote 154 lines a second into the hot path.
    const now = Date.now();
    if (this.rxCount === 1 || now - this.lastLog >= LOG_INTERVAL) {
      this.lastLog = now;
      console.log(`[${this.name}] rx frame #${this.rxCount} universe ${universe} (${count} ch)`);
    }
  }

  /**
   * Records that a source is sending a universe.
   *
   * Kept because two sources on one universe is the failure that costs a whole
   * evening: each one's ceiling looks like the other's fault, and until now the
   * only way to tell one source from two was to count universes on the wire.
   * sACN names its sources, so the readout can name them too.
   *
   * @param {Object} source `{ key, name, priority }`
   * @param {Number} universe
   */
  noteSource(source, universe) {
    let record = this.sources.get(source.key);
    if (!record) {
      record = {
        key: source.key,
        name: source.name,
        priority: source.priority,
        universes: new Set(),
        packets: 0,
        since: Date.now(),
        at: 0,
      };
      this.sources.set(source.key, record);
      console.log(`[${this.name}] source "${record.name}" (${record.key}) appeared`);
    }
    record.name = source.name;
    record.priority = source.priority;
    record.universes.add(universe);
    record.packets += 1;
    record.at = Date.now();
  }

  /**
   * Who is sending right now, and what they are sending.
   *
   * @public
   * @returns {Array} one plain record per source, newest packet first
   */
  sourceReport() {
    const now = Date.now();
    return [...this.sources.values()]
      .map((record) => ({
        protocol: this.name,
        key: record.key,
        name: record.name,
        priority: record.priority,
        universes: [...record.universes].sort((a, b) => a - b),
        packets: record.packets,
        // Averaged over the source's whole life rather than sampled, which
        // needs no timer and cannot lie about a burst.
        rate: Math.round((record.packets / Math.max(1, now - record.since)) * 1000),
        stale: now - record.at > SOURCE_TIMEOUT_MS,
      }))
      .sort((a, b) => b.packets - a.packets);
  }

  /**
   * Hands every universe that changed since the last call to the renderer, as
   * one message.
   *
   * The universes travel as a single packed block rather than an array of
   * objects: one `Uint16Array` of universe numbers and one `Uint8Array` of
   * their values end to end. Structured clone charges per object, and 386
   * little ones cost far more to send than two big ones.
   */
  flush() {
    if (!this.dirty.size || !this.onFrames) return;

    const universes = new Uint16Array(this.dirty.size);
    const data = new Uint8Array(this.dirty.size * DMX_LENGTH);
    let index = 0;
    this.dirty.forEach((universe) => {
      universes[index] = universe;
      data.set(this.buffers.get(universe), index * DMX_LENGTH);
      index += 1;
    });
    this.dirty.clear();

    this.onFrames({ universes, data });
  }

  /**
   * Closes the socket.
   */
  stop() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.dirty.clear();
    this.sources.clear();
    if (!this.socket) return;
    try {
      this.socket.close();
    } catch (err) {
      // already closing
    }
    this.socket = null;
    console.log(`[${this.name}] stopped`);
  }
}

export default DmxReceiver;
export { SOURCE_TIMEOUT_MS };
