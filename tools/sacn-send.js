/* eslint-disable no-console */
/* eslint-disable no-bitwise */
// Bit twiddling is the subject matter here: a packet header is fields packed
// into bytes, and spelling that as arithmetic would obscure the one thing a
// reader needs to check it against, which is the spec's own diagram.
const dgram = require('dgram');
const crypto = require('crypto');

/**
 * @file sACN generator: a moving pattern on as many universes as you ask for.
 *
 * Stands entirely apart from the app. It exists so the receive path can be
 * tested without MadMapper on the wire -- and so it can be tested *against*
 * MadMapper, by sending a pattern nobody could mistake for one of its own.
 *
 * The pattern is a bright band that walks along each universe, one channel per
 * frame, with the universe number written into channel 1 as a plain byte. That
 * makes an off-by-one visible by eye rather than by arithmetic: if the show
 * says universe 4 and channel 1 reads 5, the numbering is out.
 *
 * Usage:
 *   node tools/sacn-send.js                          universe 1, 40 fps, localhost
 *   node tools/sacn-send.js --universes 1-4
 *   node tools/sacn-send.js --to 192.168.1.42
 *   node tools/sacn-send.js --multicast              239.255.0.x per universe
 *   node tools/sacn-send.js --priority 150 --name "Second source"
 *   node tools/sacn-send.js --seconds 10
 *
 * @see ANSI E1.31-2018
 */

const SACN_PORT = 5568;
const UNIVERSE_SIZE = 512;

/**
 * Reads the command line into options.
 *
 * An unknown flag is an error rather than something ignored: a silently
 * dropped `--universes` sends one universe and looks like a receiver fault.
 *
 * @param {Array<String>} argv arguments after the script name
 * @returns {Object}
 */
function parseArgs(argv) {
  const options = {
    from: 1,
    to: 1,
    fps: 40,
    seconds: Infinity,
    target: '127.0.0.1',
    multicast: false,
    priority: 100,
    name: 'Beam test source',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--universes': {
        const [from, to] = String(value).split('-');
        options.from = Number(from);
        options.to = to === undefined ? Number(from) : Number(to);
        i += 1;
        break;
      }
      case '--fps': options.fps = Number(value); i += 1; break;
      case '--seconds': options.seconds = Number(value); i += 1; break;
      case '--to': options.target = String(value); i += 1; break;
      case '--priority': options.priority = Number(value); i += 1; break;
      case '--name': options.name = String(value); i += 1; break;
      case '--multicast': options.multicast = true; break;
      default:
        console.error(`unknown option: ${flag}`);
        process.exit(1);
    }
  }
  return options;
}

/**
 * The multicast address a universe arrives on.
 *
 * @param {Number} universe counted from 1
 * @returns {String}
 */
function groupFor(universe) {
  return `239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`;
}

/**
 * Builds a data packet, ready for its sequence number and slots.
 *
 * Everything but the sequence and the values is fixed for the life of the
 * process, so the packet is built once per universe and rewritten in place.
 *
 * @param {Object} options
 * @param {Number} universe
 * @param {Buffer} cid
 * @returns {Buffer}
 */
function buildPacket(options, universe, cid) {
  const packet = Buffer.alloc(126 + UNIVERSE_SIZE);
  // Root layer. The preamble and post-amble sizes come first; the identifier
  // is four bytes in.
  packet.writeUInt16BE(0x0010, 0); // preamble size
  packet.writeUInt16BE(0x0000, 2); // post-amble size
  Buffer.from([0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37, 0, 0, 0]).copy(packet, 4);
  packet.writeUInt16BE(0x7000 | (packet.length - 16), 16);
  packet.writeUInt32BE(0x00000004, 18); // VECTOR_ROOT_E131_DATA
  cid.copy(packet, 22);
  // Framing layer
  packet.writeUInt16BE(0x7000 | (packet.length - 38), 38);
  packet.writeUInt32BE(0x00000002, 40); // VECTOR_E131_DATA_PACKET
  packet.write(options.name, 44, 64, 'utf8');
  packet.writeUInt8(options.priority, 108);
  packet.writeUInt16BE(0, 109); // synchronization address: none
  packet.writeUInt8(0, 111); // sequence, rewritten per frame
  packet.writeUInt8(0, 112); // options: not preview, not terminated
  packet.writeUInt16BE(universe, 113);
  // DMP layer
  packet.writeUInt16BE(0x7000 | (packet.length - 115), 115);
  packet.writeUInt8(0x02, 117); // VECTOR_DMP_SET_PROPERTY
  packet.writeUInt8(0xa1, 118); // address type and data type
  packet.writeUInt16BE(0, 119); // first property address
  packet.writeUInt16BE(1, 121); // address increment
  packet.writeUInt16BE(UNIVERSE_SIZE + 1, 123); // start code counts as one
  packet.writeUInt8(0, 125); // start code: dimmer data
  return packet;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const universes = [];
  for (let u = options.from; u <= options.to; u += 1) universes.push(u);
  if (!universes.length || !Number.isFinite(options.fps) || options.fps <= 0) {
    console.error('nothing to send');
    process.exit(1);
  }

  // A source is its CID, and two runs of this tool should look like two
  // sources -- that is half of what it is for.
  const cid = crypto.randomBytes(16);
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const packets = new Map(universes.map((u) => [u, buildPacket(options, u, cid)]));
  const sequence = new Map(universes.map((u) => [u, 0]));
  let frames = 0;

  socket.bind(() => {
    if (options.multicast) socket.setMulticastTTL(8);
    const where = options.multicast ? 'multicast 239.255.x.y' : options.target;
    console.log(`[sacn-send] "${options.name}" cid ${cid.toString('hex').slice(0, 8)} `
      + `-> ${where}:${SACN_PORT}`);
    console.log(`[sacn-send] universes ${options.from}-${options.to} at ${options.fps} fps, `
      + `priority ${options.priority}`);
  });

  const timer = setInterval(() => {
    universes.forEach((universe) => {
      const packet = packets.get(universe);
      const next = (sequence.get(universe) + 1) & 0xff;
      sequence.set(universe, next);
      packet.writeUInt8(next, 111);

      const slots = packet.subarray(126);
      slots.fill(0);
      // Channel 1 says which universe this is, so a receiver's numbering can
      // be read off the values instead of trusted.
      slots[0] = universe & 0xff;
      // A band walking along the universe, three channels wide so it survives
      // being looked at on a panel.
      const head = (frames * 1) % UNIVERSE_SIZE;
      for (let i = 0; i < 3; i += 1) slots[(head + i) % UNIVERSE_SIZE] = 255 - i * 60;

      const destination = options.multicast ? groupFor(universe) : options.target;
      socket.send(packet, SACN_PORT, destination);
    });
    frames += 1;
    if (frames % options.fps === 0) {
      process.stdout.write(`\r[sacn-send] ${frames} frames x ${universes.length} universes`);
    }
    if (frames / options.fps >= options.seconds) {
      clearInterval(timer);
      socket.close();
      console.log('\n[sacn-send] done');
    }
  }, 1000 / options.fps);

  process.on('SIGINT', () => {
    clearInterval(timer);
    socket.close();
    console.log('\n[sacn-send] stopped');
    process.exit(0);
  });
}

main();
