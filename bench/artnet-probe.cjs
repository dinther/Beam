/* eslint-disable no-console */
/**
 * Art-Net receive probe.
 *
 * Standalone: no Electron, no Vue, no model layer. Binds the Art-Net port and
 * reports only what the network actually delivers, so that network behaviour
 * can be judged separately from the app's own processing cost.
 *
 * Reports, per rolling window:
 *   - total packet rate
 *   - how many distinct universes are arriving
 *   - per-universe refresh rate (min / median / max across universes)
 *   - sequence gaps, which indicate genuinely dropped packets
 *
 * Run this while MadMapper is transmitting. Compare broadcast vs unicast by
 * toggling "Use Unicast" and watching the universe count and gap counters.
 *
 * Usage:
 *   node bench/artnet-probe.cjs [--bind=0.0.0.0] [--interval=2]
 */
const dgram = require('dgram');
const os = require('os');

const arg = (key, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${key}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

const BIND = arg('bind', '0.0.0.0');
const INTERVAL_S = Number(arg('interval', 2));
/** Optional run length in seconds; without it the probe runs until Ctrl-C. */
const DURATION_S = Number(arg('duration', 0));

const ARTNET_PORT = 6454;
const ARTNET_ID = Buffer.from('Art-Net\0', 'latin1');
const OP_DMX = 0x5000;
const OP_POLL = 0x2000;
const OP_POLL_REPLY = 0x2100;
const HEADER_LEN = 18;
const DMX_LEN = 512;

/** Per-universe accumulators, keyed by 15-bit port address. */
const universes = new Map();

let totalPackets = 0;
let pollsSeen = 0;
let pollRepliesSeen = 0;
let nonDmxSeen = 0;
const senders = new Map();

const startedAt = Date.now();

function universeState(id) {
  let state = universes.get(id);
  if (!state) {
    state = {
      packets: 0,
      windowPackets: 0,
      lastSeq: null,
      gaps: 0,
      windowGaps: 0,
      // Change tracking: how much of each frame is actually new information.
      prev: new Uint8Array(DMX_LEN),
      seenFirst: false,
      changedChannels: 0,
      comparedChannels: 0,
      windowChanged: 0,
      windowCompared: 0,
      redundantFrames: 0,
      windowRedundant: 0,
    };
    universes.set(id, state);
  }
  return state;
}

/**
 * Counts channels that differ from this universe's previous frame, and folds
 * the result into the universe's running totals.
 *
 * This is the number that decides whether discarding unchanged values is worth
 * anything: it is the fraction of inbound data that carries new information.
 */
function trackChange(state, msg) {
  const length = Math.min(msg.readUInt16BE(16), DMX_LEN, msg.length - HEADER_LEN);
  const { prev } = state;
  let changed = 0;

  for (let i = 0; i < length; i += 1) {
    const value = msg[HEADER_LEN + i];
    if (value !== prev[i]) {
      changed += 1;
      prev[i] = value;
    }
  }

  // The first frame per universe has no baseline to compare against.
  if (!state.seenFirst) {
    state.seenFirst = true;
    return;
  }

  state.changedChannels += changed;
  state.comparedChannels += length;
  state.windowChanged += changed;
  state.windowCompared += length;
  if (changed === 0) {
    state.redundantFrames += 1;
    state.windowRedundant += 1;
  }
}

function handleDmx(msg, rinfo) {
  const subUni = msg.readUInt8(14);
  const net = msg.readUInt8(15);
  const id = ((net << 8) | subUni) & 0x7fff;
  const seq = msg.readUInt8(12);

  const state = universeState(id);
  state.packets += 1;
  state.windowPackets += 1;
  trackChange(state, msg);

  // Sequence 0 means the sender has disabled sequencing; skip gap detection.
  if (seq !== 0) {
    if (state.lastSeq !== null) {
      let expected = (state.lastSeq + 1) & 0xff;
      if (expected === 0) expected = 1; // sequence wraps 1..255
      if (seq !== expected) {
        let missed = (seq - expected) & 0xff;
        if (missed > 128) missed = 1; // reordering rather than a large loss
        state.gaps += missed;
        state.windowGaps += missed;
      }
    }
    state.lastSeq = seq;
  }

  senders.set(rinfo.address, (senders.get(rinfo.address) || 0) + 1);
}

function onMessage(msg, rinfo) {
  if (msg.length < 12) return;
  if (!msg.subarray(0, 8).equals(ARTNET_ID)) return;

  totalPackets += 1;
  const opcode = msg.readUInt16LE(8);

  if (opcode === OP_DMX) {
    if (msg.length >= HEADER_LEN) handleDmx(msg, rinfo);
  } else if (opcode === OP_POLL) {
    pollsSeen += 1;
    senders.set(rinfo.address, (senders.get(rinfo.address) || 0) + 1);
  } else if (opcode === OP_POLL_REPLY) {
    pollRepliesSeen += 1;
  } else {
    nonDmxSeen += 1;
  }
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function report() {
  const rates = [];
  const changeRates = [];
  let windowPackets = 0;
  let windowGaps = 0;
  let windowChanged = 0;
  let windowCompared = 0;
  let windowRedundant = 0;

  universes.forEach((state) => {
    rates.push(state.windowPackets / INTERVAL_S);
    windowPackets += state.windowPackets;
    windowGaps += state.windowGaps;
    windowChanged += state.windowChanged;
    windowCompared += state.windowCompared;
    windowRedundant += state.windowRedundant;
    if (state.windowCompared > 0) {
      changeRates.push((state.windowChanged / state.windowCompared) * 100);
    }
    state.windowPackets = 0;
    state.windowGaps = 0;
    state.windowChanged = 0;
    state.windowCompared = 0;
    state.windowRedundant = 0;
  });

  const ids = [...universes.keys()].sort((a, b) => a - b);
  const active = rates.filter((r) => r > 0).length;

  console.log('');
  console.log(`[${new Date().toLocaleTimeString()}] ${(windowPackets / INTERVAL_S).toFixed(0)} pkt/s`
    + `  |  ${active}/${universes.size} universes active`);

  if (rates.length) {
    const live = rates.filter((r) => r > 0);
    console.log(`  per-universe Hz   min ${Math.min(...live).toFixed(1)}`
      + `  median ${median(live).toFixed(1)}`
      + `  max ${Math.max(...live).toFixed(1)}`);
  }

  if (ids.length) {
    const contiguous = ids.length === (ids[ids.length - 1] - ids[0] + 1);
    console.log(`  universe range    ${ids[0]}..${ids[ids.length - 1]}`
      + `${contiguous ? ' (contiguous)' : ' (WITH HOLES)'}`);
    if (!contiguous) {
      const missing = [];
      for (let i = ids[0]; i <= ids[ids.length - 1]; i += 1) {
        if (!universes.has(i)) missing.push(i);
      }
      console.log(`  missing           ${missing.slice(0, 24).join(', ')}`
        + `${missing.length > 24 ? ` ... (+${missing.length - 24})` : ''}`);
    }
  }

  if (windowCompared > 0) {
    const overall = (windowChanged / windowCompared) * 100;
    console.log(`  channels changed  ${overall.toFixed(1)}% of inbound data is new`
      + `  (per-universe min ${Math.min(...changeRates).toFixed(1)}%`
      + `  median ${median(changeRates).toFixed(1)}%`
      + `  max ${Math.max(...changeRates).toFixed(1)}%)`);
    console.log(`  identical frames  ${windowRedundant} of ${windowPackets}`
      + `  (${((windowRedundant / Math.max(windowPackets, 1)) * 100).toFixed(1)}% carry nothing new)`);
  }

  console.log(`  dropped (seq)     ${windowGaps} this window`);
  if (pollsSeen || pollRepliesSeen) {
    console.log(`  discovery         ${pollsSeen} ArtPoll, ${pollRepliesSeen} ArtPollReply seen`);
  }
  if (nonDmxSeen) {
    console.log(`  other opcodes     ${nonDmxSeen}`);
  }
  console.log(`  senders           ${[...senders.keys()].join(', ') || 'none'}`);
}

function summary() {
  const elapsed = (Date.now() - startedAt) / 1000;
  let packets = 0;
  let gaps = 0;
  let changed = 0;
  let compared = 0;
  let redundant = 0;
  universes.forEach((s) => {
    packets += s.packets;
    gaps += s.gaps;
    changed += s.changedChannels;
    compared += s.comparedChannels;
    redundant += s.redundantFrames;
  });

  console.log('');
  console.log('Summary');
  console.log('='.repeat(58));
  console.log(`  duration          ${elapsed.toFixed(1)}s`);
  console.log(`  universes seen    ${universes.size}`);
  console.log(`  ArtDMX packets    ${packets}  (${(packets / elapsed).toFixed(0)}/s)`);
  if (universes.size) {
    console.log(`  per-universe Hz   ${(packets / elapsed / universes.size).toFixed(1)} average`);
  }
  console.log(`  dropped (seq)     ${gaps}`
    + `${packets ? `  (${((gaps / (packets + gaps)) * 100).toFixed(2)}%)` : ''}`);
  console.log(`  total Art-Net     ${totalPackets} packets`);

  if (compared > 0) {
    const changePct = (changed / compared) * 100;
    console.log('');
    console.log('Change rate (decides whether discarding unchanged values pays)');
    console.log(`  channels changed  ${changed} of ${compared}  (${changePct.toFixed(1)}%)`);
    console.log(`  identical frames  ${redundant} of ${packets}`
      + `  (${((redundant / Math.max(packets, 1)) * 100).toFixed(1)}%)`);
    console.log(`  theoretical gain  ${(100 / Math.max(changePct, 0.01)).toFixed(1)}x`
      + ' fewer channel writes if unchanged values are skipped');
  }
  console.log('');
}

function listInterfaces() {
  console.log('Local IPv4 interfaces:');
  Object.entries(os.networkInterfaces()).forEach(([name, addrs]) => {
    (addrs || [])
      .filter((a) => a.family === 'IPv4' && !a.internal)
      .forEach((a) => console.log(`  ${name.padEnd(28)} ${a.address}`));
  });
}

const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

socket.on('error', (err) => {
  console.error(`socket error: ${err.message}`);
  if (err.code === 'EADDRINUSE') {
    console.error('Port 6454 is already bound. Close the visualizer (or any other '
      + 'Art-Net app) and retry.');
  }
  process.exit(1);
});

socket.on('message', onMessage);

socket.bind(ARTNET_PORT, BIND, () => {
  try {
    socket.setBroadcast(true);
  } catch (err) {
    console.warn(`could not enable broadcast: ${err.message}`);
  }
  listInterfaces();
  console.log('');
  console.log(`Listening on ${BIND}:${ARTNET_PORT}, reporting every ${INTERVAL_S}s.`);
  console.log(DURATION_S
    ? `Running for ${DURATION_S}s, then printing a summary.`
    : 'Start MadMapper output now. Ctrl-C to stop and print a summary.');

  const ticker = setInterval(report, INTERVAL_S * 1000);

  if (DURATION_S) {
    setTimeout(() => {
      clearInterval(ticker);
      summary();
      socket.close();
      process.exit(0);
    }, DURATION_S * 1000);
  }
});

process.on('SIGINT', () => {
  summary();
  socket.close();
  process.exit(0);
});
