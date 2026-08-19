/* eslint-disable no-console */
import dgram from 'dgram';

/**
 * Art-Net UDP engine (main process).
 *
 * Owns a single UDP/4 socket bound to the Art-Net port, parses inbound ArtDMX
 * packets and forwards {universe, data} frames.
 *
 * Receive only: this is a visualizer, and MadMapper owns the wire. Transmitting
 * from here would invite confusion about which application is driving the rig.
 *
 * Art-Net is a plain UDP protocol; browsers cannot touch it, so all socket work
 * lives here in the Electron main process and is bridged to the renderer over IPC.
 *
 * @see https://art-net.org.uk/ (ArtDMX / OpDmx = 0x5000)
 */

const ARTNET_PORT = 6454;
/** "Art-Net" + null terminator (8 bytes) */
const ARTNET_ID = Buffer.from('Art-Net\0', 'latin1');
/** OpDmx opcode, stored little-endian in the packet */
const OP_DMX = 0x5000;
/** DMX512 universe payload length */
const DMX_LENGTH = 512;
/** Minimum valid ArtDMX packet: 18-byte header + at least some data */
const MIN_PACKET = 18;

/**
 * How often the accumulated universes are handed to the renderer, in ms.
 *
 * A packet per IPC message does not survive contact with a real rig: a
 * 256 x 256 tile arrives as 386 universes at 40 fps, which is 15,437 messages
 * a second, each one a structured clone and an event-loop wake-up. The
 * renderer cannot drain that, and nothing upstream throttles, so the queue
 * grows without bound and what the 3D view shows falls minutes behind the wire.
 *
 * Coalescing to the display rate turns that into about 60 messages a second
 * carrying the same bytes. Nothing is lost by dropping the intermediate
 * frames: a later frame for a universe wholly replaces an earlier one, which
 * is what DMX means.
 */
const FLUSH_INTERVAL = 16;

/** How often the receive log may repeat itself, in ms. */
const LOG_INTERVAL = 1000;

class ArtNet {
  constructor() {
    this.socket = null;
    this.onFrames = null;
    this.bindAddress = '0.0.0.0';
    /** Latest values per universe, reused so the hot path allocates nothing. */
    this.buffers = new Map();
    /** Universes that changed since the last flush. */
    this.dirty = new Set();
    this.flushTimer = null;
    this.rxCount = 0;
    this.lastLog = 0;
  }

  get listening() {
    return !!this.socket;
  }

  /**
   * Opens the UDP socket and begins listening for ArtDMX.
   *
   * @param {(batch: {universes: Uint16Array, data: Uint8Array}) => void} onFrames
   * @param {Object} [opts]
   * @param {string} [opts.bind] local interface to bind (default 0.0.0.0)
   */
  start(onFrames, opts = {}) {
    this.onFrames = onFrames || this.onFrames;
    if (this.socket) return;

    this.bindAddress = opts.bind || '0.0.0.0';
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    socket.on('message', (msg) => this.handleMessage(msg));
    socket.on('error', (err) => {
      console.error('[artnet] socket error:', err);
      this.stop();
    });
    socket.bind(ARTNET_PORT, this.bindAddress, () => {
      try {
        socket.setBroadcast(true);
      } catch (err) {
        console.warn('[artnet] could not enable broadcast:', err.message);
      }
      console.log(`[artnet] listening on ${this.bindAddress}:${ARTNET_PORT}`);
    });

    this.socket = socket;
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL);
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
   * Parses an inbound datagram and forwards it if it is a valid ArtDMX frame.
   *
   * @param {Buffer} msg
   */
  handleMessage(msg) {
    if (msg.length < MIN_PACKET) return;
    // Validate the "Art-Net\0" identifier
    if (!msg.subarray(0, 8).equals(ARTNET_ID)) return;
    // Opcode is little-endian; only ArtDMX is handled for now (ArtPoll etc. ignored)
    if (msg.readUInt16LE(8) !== OP_DMX) return;

    const subUni = msg.readUInt8(14);
    const net = msg.readUInt8(15);
    const universe = ((net << 8) | subUni) & 0x7fff;
    const length = msg.readUInt16BE(16);

    // One buffer per universe, reused. This runs 15,000 times a second on a
    // real rig, so it allocates nothing and copies in one go.
    let buffer = this.buffers.get(universe);
    if (!buffer) {
      buffer = new Uint8Array(DMX_LENGTH);
      this.buffers.set(universe, buffer);
    }
    const count = Math.min(length, msg.length - MIN_PACKET, DMX_LENGTH);
    buffer.set(msg.subarray(MIN_PACKET, MIN_PACKET + count));
    // A short frame leaves the tail of a reused buffer holding the last frame's
    // values; a freshly allocated one used to be zero there.
    if (count < DMX_LENGTH) buffer.fill(0, count);

    this.dirty.add(universe);

    this.rxCount += 1;
    // Once a second, not every hundredth frame: at 15,000 frames a second that
    // rule wrote 154 lines a second into the hot path.
    const now = Date.now();
    if (this.rxCount === 1 || now - this.lastLog >= LOG_INTERVAL) {
      this.lastLog = now;
      console.log(`[artnet] rx frame #${this.rxCount} universe ${universe} (${count} ch)`);
    }
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
    if (!this.socket) return;
    try {
      this.socket.close();
    } catch (err) {
      // already closing
    }
    this.socket = null;
    console.log('[artnet] stopped');
  }
}

export default new ArtNet();
export { ARTNET_PORT };
