/* eslint-disable no-console */
/* eslint-disable no-bitwise */
// Bit twiddling is the subject matter here: a packet header is fields packed
// into bytes, and spelling that as arithmetic would obscure the one thing a
// reader needs to check it against, which is the spec's own diagram.
import DmxReceiver from './dmx_receiver';

/**
 * Art-Net UDP engine (main process).
 *
 * Parses inbound ArtDMX packets; everything after the parse -- the reused
 * per-universe buffers, the dirty set, the one packed message per display
 * frame -- belongs to `DmxReceiver` and is shared with sACN.
 *
 * Art-Net is a plain UDP protocol; browsers cannot touch it, so all socket work
 * lives here in the Electron main process and is bridged to the renderer over
 * IPC.
 *
 * @see https://art-net.org.uk/ (ArtDMX / OpDmx = 0x5000)
 */

const ARTNET_PORT = 6454;
/** "Art-Net" + null terminator (8 bytes) */
const ARTNET_ID = Buffer.from('Art-Net\0', 'latin1');
/** OpDmx opcode, stored little-endian in the packet */
const OP_DMX = 0x5000;
/** Minimum valid ArtDMX packet: 18-byte header + at least some data */
const MIN_PACKET = 18;

class ArtNet extends DmxReceiver {
  constructor() {
    super({ name: 'artnet', port: ARTNET_PORT });
  }

  /**
   * Art-Net is broadcast as often as not, so the socket has to accept it.
   *
   * @param {Object} socket the bound socket
   */
  // eslint-disable-next-line class-methods-use-this
  onBound(socket) {
    try {
      socket.setBroadcast(true);
    } catch (err) {
      console.warn('[artnet] could not enable broadcast:', err.message);
    }
  }

  /**
   * Reads an ArtDMX packet.
   *
   * Art-Net universes are counted from zero and Beam's address space is an
   * offset from zero, so the number on the wire is the number used here.
   *
   * The protocol carries no identity: nothing in a packet says which program
   * sent it. The sender's address is the only thing there is to tell two
   * sources apart by, which is why two applications on one machine still
   * cannot be told apart on this wire -- and why sACN, which names its
   * sources, is worth having.
   *
   * @param {Buffer} msg
   * @param {Object} rinfo sender address and port
   * @returns {Object|null} `{ universe, data, source }`
   */
  // eslint-disable-next-line class-methods-use-this
  parse(msg, rinfo) {
    if (msg.length < MIN_PACKET) return null;
    // Validate the "Art-Net\0" identifier
    if (!msg.subarray(0, 8).equals(ARTNET_ID)) return null;
    // Opcode is little-endian; only ArtDMX is handled for now (ArtPoll etc. ignored)
    if (msg.readUInt16LE(8) !== OP_DMX) return null;

    const subUni = msg.readUInt8(14);
    const net = msg.readUInt8(15);
    const universe = ((net << 8) | subUni) & 0x7fff;
    const length = msg.readUInt16BE(16);
    const count = Math.min(length, msg.length - MIN_PACKET);

    return {
      universe,
      data: msg.subarray(MIN_PACKET, MIN_PACKET + count),
      source: {
        key: (rinfo && rinfo.address) || 'unknown',
        name: (rinfo && rinfo.address) || 'unknown',
        // Art-Net has no priority field. 100 is what sACN calls normal, so the
        // two protocols can be compared without a special case downstream.
        priority: 100,
      },
    };
  }
}

export default new ArtNet();
export { ARTNET_PORT };
