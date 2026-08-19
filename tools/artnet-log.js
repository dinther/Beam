/* eslint-disable no-console */
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');

/**
 * @file Art-Net recorder: raw DMX values out to CSV, for reading by eye.
 *
 * Stands entirely apart from the app. It binds the Art-Net port itself, keeps
 * the most recent frame of every universe it hears, and writes them out as
 * plain numbers -- 512 per line, comma delimited, one line per universe, in
 * universe order. Line 0 is universe 0, so a fixture that spans universes 127
 * and 128 is read by looking at those two lines end to end.
 *
 * Written for one question: where exactly does a value stop landing where it
 * should. That is a question about bytes, so this deliberately produces bytes
 * and no interpretation at all.
 *
 * Usage:
 *   node tools/artnet-log.js                    3 seconds, ./artnet-<stamp>.csv
 *   node tools/artnet-log.js --seconds 10
 *   node tools/artnet-log.js --out D:/tmp/a.csv
 *   node tools/artnet-log.js --universes 120-140
 *   node tools/artnet-log.js --diff             also write a change map
 *
 * @see https://art-net.org.uk/ (ArtDMX / OpDmx = 0x5000)
 */

/** The port Art-Net is defined to use. `--port` exists for testing, not for rigs. */
const ARTNET_PORT = 6454;

/** "Art-Net" plus its null terminator, the first eight bytes of every packet. */
const ARTNET_ID = Buffer.from('Art-Net\0', 'latin1');

/** OpDmx. Stored little-endian, unlike most of the rest of the header. */
const OP_DMX = 0x5000;

/** Channels in a universe, and so numbers on a line. */
const UNIVERSE_SIZE = 512;

/** Header bytes before the channel data begins. */
const HEADER_LENGTH = 18;

/**
 * Reads the command line into options.
 *
 * Deliberately small: an unknown flag is an error rather than something
 * ignored, because a silently dropped `--universes` would produce a file that
 * looks right and answers a different question.
 *
 * @param {Array<String>} argv arguments after the script name
 * @returns {Object} `{ seconds, out, from, to, diff }`
 */
function parseArgs(argv) {
  const options = {
    seconds: 3,
    out: null,
    from: 0,
    to: Infinity,
    diff: false,
    port: ARTNET_PORT,
    watch: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--seconds' || arg === '-s') {
      options.seconds = Number(argv[++i]);
      if (!(options.seconds > 0)) throw new Error('--seconds wants a positive number');
    } else if (arg === '--out' || arg === '-o') {
      options.out = argv[++i];
      if (!options.out) throw new Error('--out wants a path');
    } else if (arg === '--universes' || arg === '-u') {
      const range = String(argv[++i] || '');
      const match = range.match(/^(\d+)(?:-(\d+))?$/);
      if (!match) throw new Error('--universes wants N or N-M, e.g. 120-140');
      options.from = Number(match[1]);
      options.to = match[2] === undefined ? options.from : Number(match[2]);
      if (options.to < options.from) throw new Error('--universes wants the low number first');
    } else if (arg === '--diff' || arg === '-d') {
      options.diff = true;
    } else if (arg === '--watch' || arg === '-w') {
      options.watch = true;
    } else if (arg === '--port' || arg === '-p') {
      options.port = Number(argv[++i]);
      if (!(options.port > 0 && options.port < 65536)) throw new Error('--port wants a port number');
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

/**
 * Parses one datagram, returning its universe and channel data.
 *
 * @param {Buffer} msg inbound datagram
 * @returns {Object|null} `{ universe, data, count }`, or null if not ArtDMX
 */
function parsePacket(msg) {
  if (msg.length < HEADER_LENGTH) return null;
  if (!msg.subarray(0, 8).equals(ARTNET_ID)) return null;
  if (msg.readUInt16LE(8) !== OP_DMX) return null;

  // The 15-bit port address, split across two bytes: sub-net and universe in
  // the low one, net in the high one.
  const subUni = msg.readUInt8(14);
  const net = msg.readUInt8(15);
  // Bit twiddling because the wire is bits: this is one 15-bit field written
  // across two bytes, not a number anyone chose to compute.
  // eslint-disable-next-line no-bitwise
  const universe = ((net << 8) | subUni) & 0x7fff;

  const declared = msg.readUInt16BE(16);
  const count = Math.min(declared, msg.length - HEADER_LENGTH, UNIVERSE_SIZE);

  const data = new Uint8Array(UNIVERSE_SIZE);
  for (let i = 0; i < count; i += 1) {
    data[i] = msg[HEADER_LENGTH + i];
  }

  return { universe, data, count };
}

/**
 * One line of the CSV: a universe's 512 values.
 *
 * @param {Uint8Array|null} frame the universe's data, or null if none arrived
 * @returns {String}
 */
function formatLine(frame) {
  if (!frame) return new Array(UNIVERSE_SIZE).fill(0).join(',');
  return Array.prototype.join.call(frame, ',');
}

/**
 * A filename-safe timestamp, local time.
 *
 * @returns {String} `YYYYMMDD-HHMMSS`
 */
function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
    + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * Writes the capture out.
 *
 * Universes that never arrived are still given a line, of zeros, so that the
 * line number is always the universe number. Which ones those were is reported
 * on the console instead, where it cannot be mistaken for data.
 *
 * @param {Map} frames universe -> Uint8Array
 * @param {Object} options parsed command line
 * @returns {Object} `{ file, lines, missing }`
 */
function writeSnapshot(frames, options) {
  const seen = [...frames.keys()].sort((a, b) => a - b);
  const first = Number.isFinite(options.to) ? options.from : 0;
  const last = Number.isFinite(options.to) ? options.to : seen[seen.length - 1];

  const lines = [];
  const missing = [];
  for (let universe = first; universe <= last; universe += 1) {
    const frame = frames.get(universe);
    if (!frame) missing.push(universe);
    lines.push(formatLine(frame));
  }

  const file = path.resolve(options.out || `artnet-${stamp()}.csv`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return {
    file, lines: lines.length, missing, first, last,
  };
}

/**
 * Writes a map of which channels changed during the capture.
 *
 * A still pattern and a dead channel look identical in one snapshot. This says
 * which is which: 1 where a channel took more than one value while we watched,
 * 0 where it held still. Same shape as the snapshot, so the two files line up
 * row for row and column for column.
 *
 * @param {Map} changed universe -> Uint8Array of 0/1
 * @param {Object} result what `writeSnapshot` returned
 * @returns {String} the path written
 */
function writeChangeMap(changed, result) {
  const lines = [];
  for (let universe = result.first; universe <= result.last; universe += 1) {
    lines.push(formatLine(changed.get(universe)));
  }
  const file = `${result.file.replace(/\.csv$/, '')}.changed.csv`;
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

const HELP = `
Art-Net recorder -- raw DMX values to CSV.

  node tools/artnet-log.js [options]

  -s, --seconds N     how long to listen (default 3)
  -o, --out PATH      where to write (default ./artnet-<stamp>.csv)
  -u, --universes R   only these, as N or N-M (default: everything heard)
  -w, --watch         print what is arriving, once a second, until Ctrl-C
  -d, --diff          also write <out>.changed.csv, 1 where a channel moved
  -p, --port N        listen on another port (default 6454; for testing)
  -h, --help          this

Output is one line per universe, 512 comma-delimited values, line number =
universe number. Universes that never arrived are written as zeros and named
on the console.

Note: the app binds this same port. If nothing arrives, close Beam first --
two sockets on one port only reliably share broadcast traffic, not unicast.
`;

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[artnet-log] ${err.message}`);
    console.error(HELP);
    process.exit(1);
    return;
  }

  if (options.help) {
    console.log(HELP);
    return;
  }

  /** Latest frame per universe. */
  const frames = new Map();
  /** Per channel, whether it ever took a second value. */
  const changed = options.diff ? new Map() : null;
  let packets = 0;
  let ignored = 0;

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  socket.on('error', (err) => {
    console.error(`[artnet-log] socket error: ${err.message}`);
    if (err.code === 'EADDRINUSE') {
      console.error('[artnet-log] the port is taken outright; close Beam and try again');
    }
    socket.close();
    process.exit(1);
  });

  socket.on('message', (msg) => {
    const packet = parsePacket(msg);
    if (!packet) return;
    const { universe, data } = packet;
    if (universe < options.from || universe > options.to) {
      ignored += 1;
      return;
    }
    packets += 1;

    if (changed) {
      const previous = frames.get(universe);
      if (previous) {
        let marks = changed.get(universe);
        if (!marks) {
          marks = new Uint8Array(UNIVERSE_SIZE);
          changed.set(universe, marks);
        }
        for (let i = 0; i < UNIVERSE_SIZE; i += 1) {
          if (data[i] !== previous[i]) marks[i] = 1;
        }
      } else {
        changed.set(universe, new Uint8Array(UNIVERSE_SIZE));
      }
    }

    frames.set(universe, data);
  });

  socket.bind(options.port, '0.0.0.0', () => {
    try {
      socket.setBroadcast(true);
    } catch (err) {
      console.warn(`[artnet-log] could not enable broadcast: ${err.message}`);
    }
    const scope = Number.isFinite(options.to)
      ? `universes ${options.from}-${options.to}`
      : 'every universe';
    const duration = options.watch ? 'until Ctrl-C' : `for ${options.seconds}s`;
    console.log(`[artnet-log] listening on 0.0.0.0:${options.port}, ${scope}, ${duration}`);
  });

  if (options.watch) {
    // Answers one question -- is anything arriving -- and answers it every
    // second, because a tool that listens in silence and then writes a file
    // cannot be told apart from a tool that is broken.
    let lastCount = 0;
    setInterval(() => {
      const rate = packets - lastCount;
      lastCount = packets;
      const live = [...frames.values()].filter((f) => f.some((x) => x !== 0)).length;
      const lowest = [...frames.keys()].sort((a, b) => a - b)[0];
      const sample = lowest === undefined
        ? ''
        : `  u${lowest}: ${Array.from(frames.get(lowest).slice(0, 9)).join(',')}...`;
      if (!rate) {
        console.log('[artnet-log] nothing arriving');
        return;
      }
      console.log(`[artnet-log] ${String(rate).padStart(6)} pkt/s  `
        + `${frames.size} universes, ${live} with data${sample}`);
    }, 1000).unref();
    return;
  }

  setTimeout(() => {
    socket.close();

    if (!packets) {
      console.error('[artnet-log] no ArtDMX arrived.');
      console.error('[artnet-log] if Beam is running, close it: two sockets on one port');
      console.error('[artnet-log] share broadcast reliably but not unicast.');
      process.exit(2);
      return;
    }

    const result = writeSnapshot(frames, options);
    console.log(`[artnet-log] ${packets} packets`
      + `${ignored ? `, ${ignored} outside the range` : ''}`
      + `, ${frames.size} universes`);
    console.log(`[artnet-log] wrote ${result.lines} lines (universes ${result.first}-${result.last})`
      + ` to ${result.file}`);
    if (result.missing.length) {
      const shown = result.missing.slice(0, 20).join(', ');
      const more = result.missing.length > 20 ? `, and ${result.missing.length - 20} more` : '';
      console.log(`[artnet-log] silent, written as zeros: ${shown}${more}`);
    }
    if (changed) {
      console.log(`[artnet-log] wrote change map to ${writeChangeMap(changed, result)}`);
    }
  }, options.seconds * 1000);
}

main();
