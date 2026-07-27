/* eslint-disable no-console */
import dgram from 'dgram';

/**
 * Art-Net UDP engine (main process).
 *
 * Owns a single UDP/4 socket bound to the Art-Net port and provides:
 *  - receive: parses inbound ArtDMX packets and forwards {universe, data} frames
 *  - send:    builds and emits ArtDMX packets for output
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
/** Art-Net protocol version (14) */
const PROT_VER = 14;
/** DMX512 universe payload length */
const DMX_LENGTH = 512;
/** Minimum valid ArtDMX packet: 18-byte header + at least some data */
const MIN_PACKET = 18;

class ArtNet {
  constructor() {
    this.socket = null;
    this.onFrame = null;
    this.seq = 0;
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
   * Builds and sends an ArtDMX packet.
   *
   * @param {Object} packet
   * @param {number} [packet.universe] 15-bit Art-Net port address
   * @param {Uint8Array|number[]} packet.data up to 512 channel values
   * @param {string} [packet.ip] destination (unicast or broadcast)
   * @param {number} [packet.port] destination port
   */
  send({
    universe = 0, data, ip = '255.255.255.255', port = ARTNET_PORT,
  }) {
    if (!this.socket) return;

    const buf = Buffer.alloc(MIN_PACKET + DMX_LENGTH);
    ARTNET_ID.copy(buf, 0);
    buf.writeUInt16LE(OP_DMX, 8);
    buf.writeUInt16BE(PROT_VER, 10);
    this.seq = (this.seq + 1) & 0xff;
    buf.writeUInt8(this.seq, 12); // Sequence
    buf.writeUInt8(0, 13); // Physical
    buf.writeUInt8(universe & 0xff, 14); // SubUni (low byte)
    buf.writeUInt8((universe >> 8) & 0x7f, 15); // Net (high 7 bits)
    buf.writeUInt16BE(DMX_LENGTH, 16); // Length

    if (data) {
      for (let i = 0; i < DMX_LENGTH; i += 1) {
        buf[MIN_PACKET + i] = data[i] || 0;
      }
    }

    this.socket.send(buf, 0, buf.length, port, ip);
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
