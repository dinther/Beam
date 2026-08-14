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

class ArtNet {
  constructor() {
    this.socket = null;
    this.onFrame = null;
    this.bindAddress = '0.0.0.0';
  }

  get listening() {
    return !!this.socket;
  }

  /**
   * Opens the UDP socket and begins listening for ArtDMX.
   *
   * @param {(frame: {universe: number, data: Uint8Array}) => void} onFrame
   * @param {Object} [opts]
   * @param {string} [opts.bind] local interface to bind (default 0.0.0.0)
   */
  start(onFrame, opts = {}) {
    this.onFrame = onFrame || this.onFrame;
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

    const data = new Uint8Array(DMX_LENGTH);
    const count = Math.min(length, msg.length - MIN_PACKET, DMX_LENGTH);
    for (let i = 0; i < count; i += 1) {
      data[i] = msg[MIN_PACKET + i];
    }

    this.rxCount = (this.rxCount || 0) + 1;
    if (this.rxCount === 1 || this.rxCount % 100 === 0) {
      console.log(`[artnet] rx frame #${this.rxCount} universe ${universe} (${count} ch)`);
    }

    if (this.onFrame) this.onFrame({ universe, data });
  }

  /**
   * Closes the socket.
   */
  stop() {
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
