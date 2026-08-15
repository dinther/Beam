/* eslint-disable no-console */
/**
 * Art-Net channel layout probe.
 *
 * Standalone: binds the Art-Net port and reports which channels of each
 * universe a sender actually drives, so the layout it uses can be observed
 * rather than assumed. Where a sender keeps pixels whole inside a universe it
 * must leave the remainder at the end untouched, and that shows up here as
 * dead channels; where it lets a pixel straddle, they are driven like any
 * other.
 *
 * Drive one component at a time -- every pixel full red, then green, then blue
 * -- and the report reads out the wiring directly: which slot of each pixel is
 * live gives the component order, the spacing gives the pixel size, and any
 * jump in that spacing is where the sender stepped over a boundary.
 *
 * A channel counts as live if it ever leaves zero during the window, so the
 * measurement is only as good as the content: anything black is indistinguish-
 * able from anything unpatched.
 *
 * Universes sharing a layout are reported as one line, since a rig is usually
 * many copies of the same arrangement.
 *
 * Usage:
 *   node bench/artnet-layout.cjs [--bind=0.0.0.0] [--interval=5] [--pixel=3]
 */
const dgram = require('dgram');

const arg = (key, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${key}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

const BIND = arg('bind', '0.0.0.0');
const INTERVAL_S = Number(arg('interval', 5));
/** Channels per pixel to read the observed spacing against. */
const PIXEL = Number(arg('pixel', 3));

const ARTNET_PORT = 6454;
const ARTNET_ID = Buffer.from('Art-Net\0', 'latin1');
const OP_DMX = 0x5000;
const HEADER_LEN = 18;
const DMX_LEN = 512;

/** Per universe, the highest value each channel reached this window. */
let universes = new Map();
let windows = 0;

/**
 * Describes one universe's live channels.
 *
 * @param {Object} state peak values and frame count
 * @returns {Object} signature and detail
 */
function describe(state) {
  const live = [];
  state.peak.forEach((value, channel) => { if (value > 0) live.push(channel); });
  if (!live.length) return { signature: 'silent', live: 0 };

  const first = live[0];
  const last = live[live.length - 1];

  // Which slot within a pixel is driven, counted from the first live channel.
  const slots = new Set(live.map((c) => (((c - first) % PIXEL) + PIXEL) % PIXEL));

  // Anywhere the spacing departs from one pixel is where the sender jumped.
  const breaks = [];
  live.forEach((channel, i) => {
    if (i > 0 && channel - live[i - 1] !== PIXEL) {
      breaks.push(`${live[i - 1]}->${channel}`);
    }
  });

  return {
    signature: [
      `slots{${[...slots].sort().join(',')}}`,
      `first ${first}`,
      `last ${last}`,
      `dead-tail ${state.width - 1 - last}`,
      `breaks ${breaks.length ? breaks.slice(0, 3).join(' ') : 'none'}`,
    ].join('  '),
    live: live.length,
  };
}

const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

socket.on('message', (msg) => {
  if (msg.length < HEADER_LEN || !msg.subarray(0, 8).equals(ARTNET_ID)) return;
  if (msg.readUInt16LE(8) !== OP_DMX) return;

  const universe = msg.readUInt16LE(14);
  const length = Math.min(msg.readUInt16BE(16), msg.length - HEADER_LEN, DMX_LEN);
  let state = universes.get(universe);
  if (!state) {
    state = { frames: 0, peak: new Uint8Array(DMX_LEN), width: 0 };
    universes.set(universe, state);
  }
  state.frames += 1;
  state.width = Math.max(state.width, length);
  for (let i = 0; i < length; i += 1) {
    const value = msg[HEADER_LEN + i];
    if (value > state.peak[i]) state.peak[i] = value;
  }
});

socket.bind(ARTNET_PORT, BIND, () => {
  try { socket.setBroadcast(true); } catch (err) { /* not fatal */ }
  console.log(`listening on ${BIND}:${ARTNET_PORT}, reporting every ${INTERVAL_S}s`);
  console.log(`reading against ${PIXEL} channels per pixel; channel numbers are 0-based\n`);
});

setInterval(() => {
  windows += 1;
  const captured = universes;
  universes = new Map();

  if (!captured.size) {
    console.log(`[${windows}] no ArtDMX received`);
    return;
  }

  // One line per distinct layout, listing the universes that share it.
  const groups = new Map();
  [...captured.entries()].sort((a, b) => a[0] - b[0]).forEach(([universe, state]) => {
    const { signature, live } = describe(state);
    if (!groups.has(signature)) groups.set(signature, { universes: [], live });
    groups.get(signature).universes.push(universe);
  });

  console.log(`[${windows}] ${captured.size} universes`);
  groups.forEach((group, signature) => {
    const list = group.universes.length > 8
      ? `${group.universes.slice(0, 6).join(',')}…+${group.universes.length - 6}`
      : group.universes.join(',');
    console.log(`   ${String(group.live).padStart(4)} live  ${signature}   [u ${list}]`);
  });
  console.log('');
}, INTERVAL_S * 1000);
