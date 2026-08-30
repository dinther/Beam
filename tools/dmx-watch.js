/* eslint-disable no-console */
/* eslint-disable no-bitwise */
// Bit twiddling is the subject matter here: a packet header is fields packed
// into bytes, and spelling that as arithmetic would obscure the one thing a
// reader needs to check it against, which is the spec's own diagram.
const dgram = require('dgram');

/**
 * @file Who is sending DMX at this machine, on both wires.
 *
 * `artnet-log.js` answers "what are the bytes"; this answers "who is putting
 * them there", which is the other question that costs an evening. Two sources
 * writing one universe is the failure that made MadMapper's 65,535-channel
 * ceiling look like LEDfx losing alignment: each one's limit reads as the
 * other's fault, and until sACN there was nothing on the wire that said which
 * application a packet came from.
 *
 * sACN packets name their source and carry a priority, so those are printed as
 * they arrive. Art-Net carries no identity at all, so a sender there can only
 * be named by its address -- which is exactly why two applications on one
 * machine still cannot be told apart on that wire.
 *
 * Stands apart from the app and only listens; it never sends. Run it beside
 * Beam and both will hear the same traffic.
 *
 * Usage:
 *   node tools/dmx-watch.js
 *   node tools/dmx-watch.js --seconds 20
 *   node tools/dmx-watch.js --multicast 1-8    also join those sACN groups
 */

const ARTNET_PORT = 6454;
const SACN_PORT = 5568;
const ARTNET_ID = Buffer.from('Art-Net\0', 'latin1');
const ACN_ID = Buffer.from([0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37, 0, 0, 0]);
const OP_DMX = 0x5000;

/**
 * @param {Array<String>} argv arguments after the script name
 * @returns {Object} `{ seconds, groups }`
 */
function parseArgs(argv) {
  const options = { seconds: Infinity, groups: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    switch (argv[i]) {
      case '--seconds': options.seconds = Number(value); i += 1; break;
      case '--multicast': {
        const [from, to] = String(value).split('-');
        for (let u = Number(from); u <= (to === undefined ? Number(from) : Number(to)); u += 1) {
          options.groups.push(u);
        }
        i += 1;
        break;
      }
      default:
        console.error(`unknown option: ${argv[i]}`);
        process.exit(1);
    }
  }
  return options;
}

/** Everything heard, keyed protocol + source. */
const sources = new Map();

/**
 * Records one packet.
 *
 * @param {String} protocol 'artnet' or 'sacn'
 * @param {String} key what tells this sender from the others
 * @param {String} name what to call it
 * @param {Number} universe as the protocol numbers it
 * @param {Number} beamUniverse as Beam's address space numbers it
 * @param {Number} priority
 */
function note(protocol, key, name, universe, beamUniverse, priority) {
  const id = `${protocol}/${key}`;
  let record = sources.get(id);
  if (!record) {
    record = {
      protocol, name, priority, universes: new Map(), packets: 0, since: Date.now(),
    };
    sources.set(id, record);
  }
  record.name = name;
  record.priority = priority;
  record.packets += 1;
  record.universes.set(universe, beamUniverse);
}

/**
 * Prints what has been heard since the last report.
 */
function report() {
  console.clear();
  console.log(`listening: Art-Net ${ARTNET_PORT}, sACN ${SACN_PORT}\n`);
  if (!sources.size) {
    console.log('nothing on either wire yet.');
    return;
  }

  const seconds = (record) => Math.max(1, (Date.now() - record.since) / 1000);
  const byUniverse = new Map();

  [...sources.entries()].forEach(([id, record]) => {
    const list = [...record.universes.keys()].sort((a, b) => a - b);
    const shown = list.slice(0, 8).join(', ') + (list.length > 8 ? ` … +${list.length - 8}` : '');
    console.log(`${record.protocol.padEnd(7)} ${record.name}`);
    console.log(`        ${Math.round(record.packets / seconds(record))} packets/s, `
      + `priority ${record.priority}, ${list.length} universe(s): ${shown}`);
    // The mapping, spelled out for the one universe most likely to be looked
    // at, because this is where an off-by-one is caught.
    const first = list[0];
    console.log(`        ${record.protocol} universe ${first} `
      + `= Beam universe ${record.universes.get(first)}\n`);
    list.forEach((universe) => {
      const beam = record.universes.get(universe);
      if (!byUniverse.has(beam)) byUniverse.set(beam, []);
      byUniverse.get(beam).push(`${record.name} (${record.protocol}, priority ${record.priority})`);
    });
    return id;
  });

  const contended = [...byUniverse.entries()].filter(([, who]) => who.length > 1);
  if (contended.length) {
    console.log('two sources on one universe:');
    contended.slice(0, 10).forEach(([beam, who]) => {
      console.log(`  Beam universe ${beam}: ${who.join('  vs  ')}`);
    });
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  const artnet = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  artnet.on('message', (msg, rinfo) => {
    if (msg.length < 18 || !msg.subarray(0, 8).equals(ARTNET_ID)) return;
    if (msg.readUInt16LE(8) !== OP_DMX) return;
    const universe = ((msg.readUInt8(15) << 8) | msg.readUInt8(14)) & 0x7fff;
    // Art-Net counts from zero, as Beam's address space does.
    note('artnet', rinfo.address, rinfo.address, universe, universe, 100);
  });
  artnet.bind(ARTNET_PORT, '0.0.0.0', () => artnet.setBroadcast(true));

  const sacn = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sacn.on('message', (msg) => {
    // The identifier is four bytes in, after the preamble sizes.
    if (msg.length < 126 || !msg.subarray(4, 16).equals(ACN_ID)) return;
    if (msg.readUInt32BE(18) !== 0x00000004) return;
    if (msg.readUInt32BE(40) !== 0x00000002) return;
    if (msg.readUInt8(125) !== 0) return;
    const universe = msg.readUInt16BE(113);
    const cid = msg.subarray(22, 38).toString('hex');
    const name = msg.subarray(44, 108).toString('utf8').replace(/\0.*$/, '').trim();
    // E1.31 counts from one; Beam's address space counts from zero.
    note('sacn', cid, name || cid.slice(0, 8), universe, universe - 1, msg.readUInt8(108));
  });
  sacn.bind(SACN_PORT, '0.0.0.0', () => {
    options.groups.forEach((universe) => {
      try {
        sacn.addMembership(`239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`);
      } catch (err) {
        console.warn(`could not join universe ${universe}: ${err.message}`);
      }
    });
  });

  const timer = setInterval(report, 1000);
  report();

  const finish = () => {
    clearInterval(timer);
    artnet.close();
    sacn.close();
    process.exit(0);
  };
  if (Number.isFinite(options.seconds)) setTimeout(finish, options.seconds * 1000);
  process.on('SIGINT', finish);
}

main();
