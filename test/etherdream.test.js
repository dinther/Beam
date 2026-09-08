/* eslint-disable no-console */
/* eslint-disable no-bitwise */
// Bit twiddling is the subject matter here: a DAC packet is fields packed into
// bytes, and spelling that as arithmetic would obscure the one thing a reader
// needs to check it against, which is the protocol's own struct definitions.
/**
 * Being an Ether Dream.
 *
 * A real host is driven by the replies: it reads `buffer_fullness` to decide
 * how much to send, stops on NAK-full, re-prepares on underflow. So the tests
 * play the host -- connect, prepare, write, begin -- over a real TCP socket to
 * the real server, and check both what comes back and what the renderer is
 * handed. The clock is a fake so the buffer is played out by hand: a test
 * that waited real milliseconds for 300 points would be flaky by design.
 *
 * The packet layouts here are written from the protocol's own struct
 * definitions. A self-built packet agrees with whatever the parser believes,
 * so the one thing this cannot prove is a byte offset both sides got wrong
 * the same way; the first live MadLaser stream settles that, as MadMapper's
 * did for sACN.
 *
 * Usage:
 *   npm test
 */
import dgram from 'dgram';
import net from 'net';
import EtherDreamDac, { POINT_STRIDE, PLAYBACK } from '@/electron/etherdream';

let failures = 0;

function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

/** Reads `struct dac_status` at `offset` into plain fields. */
function status(buffer, offset) {
  return {
    protocol: buffer.readUInt8(offset),
    lightEngine: buffer.readUInt8(offset + 1),
    playback: buffer.readUInt8(offset + 2),
    source: buffer.readUInt8(offset + 3),
    lightFlags: buffer.readUInt16LE(offset + 4),
    playFlags: buffer.readUInt16LE(offset + 6),
    sourceFlags: buffer.readUInt16LE(offset + 8),
    fullness: buffer.readUInt16LE(offset + 10),
    rate: buffer.readUInt32LE(offset + 12),
    pointCount: buffer.readUInt32LE(offset + 16),
  };
}

/** A reply: response byte, command byte, status. */
function reply(buffer) {
  return {
    response: String.fromCharCode(buffer[0]),
    command: buffer[1],
    ...status(buffer, 2),
  };
}

/** A `struct dac_point`, 18 bytes. */
function point({
  x = 0, y = 0, r = 0, g = 0, b = 0, i = 0, control = 0,
} = {}) {
  const buffer = Buffer.alloc(18);
  buffer.writeUInt16LE(control, 0);
  buffer.writeInt16LE(x, 2);
  buffer.writeInt16LE(y, 4);
  buffer.writeUInt16LE(r, 6);
  buffer.writeUInt16LE(g, 8);
  buffer.writeUInt16LE(b, 10);
  buffer.writeUInt16LE(i, 12);
  return buffer;
}

/** A data command carrying `points`. */
function data(points) {
  const header = Buffer.alloc(3);
  header.writeUInt8(0x64, 0);
  header.writeUInt16LE(points.length, 1);
  return Buffer.concat([header, ...points]);
}

/** A begin command. */
function begin(rate, lowWater = 0) {
  const buffer = Buffer.alloc(7);
  buffer.writeUInt8(0x62, 0);
  buffer.writeUInt16LE(lowWater, 1);
  buffer.writeUInt32LE(rate, 3);
  return buffer;
}

/** A queue-rate-change command. */
function queue(rate, byte = 0x71) {
  const buffer = Buffer.alloc(5);
  buffer.writeUInt8(byte, 0);
  buffer.writeUInt32LE(rate, 1);
  return buffer;
}

/**
 * A host: one socket, replies handed out in order as 22-byte packets
 * however the stream cut them.
 */
class Host {
  constructor() {
    this.socket = null;
    this.rx = Buffer.alloc(0);
    this.waiters = [];
  }

  connect(port) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ port, host: '127.0.0.1' }, () => resolve());
      socket.on('error', reject);
      socket.on('data', (chunk) => {
        this.rx = Buffer.concat([this.rx, chunk]);
        while (this.rx.length >= 22 && this.waiters.length) {
          const packet = this.rx.subarray(0, 22);
          this.rx = this.rx.subarray(22);
          this.waiters.shift()(reply(packet));
        }
      });
      this.socket = socket;
    });
  }

  /** The next reply, whether it has arrived already or not. */
  next() {
    if (this.rx.length >= 22) {
      const packet = this.rx.subarray(0, 22);
      this.rx = this.rx.subarray(22);
      return Promise.resolve(reply(packet));
    }
    return new Promise((resolve) => { this.waiters.push(resolve); });
  }

  /** Sends a command and returns its reply. */
  send(buffer) {
    this.socket.write(buffer);
    return this.next();
  }

  close() {
    return new Promise((resolve) => {
      this.socket.once('close', resolve);
      this.socket.destroy();
    });
  }
}

/** Waits for the event loop to turn, so a socket close reaches the server. */
const settle = (ms = 20) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function run() {
  let clock = 0;
  const batches = [];

  // Somewhere for the beacon to land that is not the LAN.
  const listener = dgram.createSocket('udp4');
  const beacons = [];
  listener.on('message', (msg) => beacons.push(msg));
  await new Promise((resolve) => { listener.bind(0, '127.0.0.1', resolve); });

  const dac = new EtherDreamDac({
    name: 'test DAC',
    mac: [0x02, 0xbe, 0xa1, 0x12, 0x34, 0x56],
    tcpPort: 0,
    udpPort: listener.address().port,
    beaconAddress: '127.0.0.1',
    capacity: 1800,
    now: () => clock,
    timers: false,
  });
  await dac.start((batch) => batches.push(batch), { bind: '127.0.0.1' });
  check('control port bound', dac.tcpPort > 0, true);

  // -- The beacon ---------------------------------------------------------
  await settle(50);
  dac.sendBeacon();
  await settle(50);
  check('beacon arrived', beacons.length >= 1, true);
  const beacon = beacons[beacons.length - 1];
  check('beacon is 36 bytes', beacon.length, 36);
  check('beacon mac', beacon.subarray(0, 6).toString('hex'), '02bea1123456');
  check('beacon buffer capacity', beacon.readUInt16LE(10), 1800);
  check('beacon max point rate', beacon.readUInt32LE(12), 100000);
  const beaconStatus = status(beacon, 16);
  check('beacon playback idle', beaconStatus.playback, PLAYBACK.IDLE);
  check('beacon source network', beaconStatus.source, 0);

  // -- Connecting ----------------------------------------------------------
  const host = new Host();
  await host.connect(dac.tcpPort);
  const hello = await host.next();
  check('hello is an ack to ping', `${hello.response}${String.fromCharCode(hello.command)}`, 'a?');
  check('hello reports idle', hello.playback, PLAYBACK.IDLE);
  check('hello reports empty buffer', hello.fullness, 0);
  check('hello shutter closed', hello.playFlags & 1, 0);

  const second = new Host();
  let refused = false;
  try {
    await second.connect(dac.tcpPort);
    await settle(50);
    refused = second.socket.destroyed;
  } catch (err) {
    refused = true;
  }
  check('second host refused', refused, true);
  check('first host still connected', host.socket.destroyed, false);

  // -- Prepare and write ---------------------------------------------------
  let r = await host.send(data([point()]));
  check('data while idle is invalid', r.response, 'I');

  r = await host.send(Buffer.from([0x70]));
  check('prepare acked', r.response, 'a');
  check('prepare -> prepared', r.playback, PLAYBACK.PREPARED);
  r = await host.send(Buffer.from([0x70]));
  check('prepare while prepared is invalid', r.response, 'I');

  const frame = [];
  for (let n = 0; n < 1000; n++) {
    frame.push(point({
      x: n - 500, y: 500 - n, r: n * 60, g: 65535 - n * 60, b: n & 1 ? 65535 : 0, i: 65535,
    }));
  }
  r = await host.send(data(frame));
  check('1000 points acked', r.response, 'a');
  check('fullness 1000', r.fullness, 1000);

  r = await host.send(data(frame));
  check('1000 more would overflow: NAK full', r.response, 'F');
  check('fullness unchanged by refused write', r.fullness, 1000);

  r = await host.send(data(frame.slice(0, 800)));
  check('800 more fills it exactly', r.response, 'a');
  check('fullness 1800', r.fullness, 1800);

  r = await host.send(data([]));
  check('zero-point write is valid', r.response, 'a');

  // -- Playing -------------------------------------------------------------
  r = await host.send(begin(0));
  check('begin at rate 0 is invalid', r.response, 'I');
  r = await host.send(begin(30000));
  check('begin acked', r.response, 'a');
  check('begin -> playing', r.playback, PLAYBACK.PLAYING);
  check('begin reports rate', r.rate, 30000);
  check('shutter open while playing', r.playFlags & 1, 1);
  check('nothing played yet', batches.length, 0);

  clock += 10; // 10 ms at 30 kpps is 300 points
  dac.tick();
  check('one batch after a tick', batches.length, 1);
  let batch = batches[0];
  check('batch carries the rate', batch.rate, 30000);
  check('300 points played in 10 ms', batch.points.length / POINT_STRIDE, 300);
  const decodeXY = (v) => (v << 16) >> 16;
  check('first point x', decodeXY(batch.points[0]), -500);
  check('first point y', decodeXY(batch.points[1]), 500);
  check('first point r', batch.points[2], 0);
  check('first point g', batch.points[3], 65535);
  check('first point b', batch.points[4], 0);
  check('first point i', batch.points[5], 65535);
  const last = 299 * POINT_STRIDE;
  check('300th point x', decodeXY(batch.points[last]), 299 - 500);
  check('300th point b', batch.points[last + 4], 65535);

  r = await host.send(Buffer.from([0x3f]));
  check('ping acked', r.response, 'a');
  check('fullness fell by 300', r.fullness, 1500);
  check('point_count counts played points', r.pointCount, 300);

  // The buffer drains at the rate between commands too, not only on ticks.
  clock += 10;
  r = await host.send(data(frame.slice(0, 600)));
  check('write after 300 more played', r.response, 'a');
  check('fullness 1500 - 300 + 600', r.fullness, 1800);

  // -- A data command in pieces -------------------------------------------
  clock += 20; // 600 played, room for 600
  const whole = data(frame.slice(0, 600));
  host.socket.write(whole.subarray(0, 2)); // half a header
  await settle(20);
  host.socket.write(whole.subarray(2, 1000));
  await settle(20);
  check('no reply to a partial command', host.rx.length, 0);
  r = await host.send(whole.subarray(1000));
  check('split command acked once complete', r.response, 'a');
  check('split command counted in full', r.fullness, 1800);

  // -- Rate change ---------------------------------------------------------
  r = await host.send(queue(20000));
  check('queue rate change acked', r.response, 'a');
  check('queued rate not applied yet', r.rate, 30000);
  clock += 60; // would drain 1800 at 30k; capped per tick at 30 ms = 900
  dac.tick();
  r = await host.send(Buffer.from([0x3f]));
  check('a stalled tick charges at most 30 ms', r.fullness, 900);
  const tail = [point({ control: 0x8000, x: 7 }), point({ x: 8 })];
  for (let n = 0; n < 98; n++) tail.push(point({ x: 9 }));
  r = await host.send(data(tail));
  check('flagged point accepted', r.response, 'a');
  check('fullness 1000', r.fullness, 1000);
  clock += 30; // plays the 900 points ahead of the flagged one at 30k...
  dac.tick();
  clock += 1; // ...then the flagged one switches the rate
  dac.tick();
  r = await host.send(Buffer.from([0x3f]));
  check('rate changed at the flagged point', r.rate, 20000);
  batch = batches[batches.length - 1];
  check('flagged point reached the renderer first', decodeXY(batch.points[0]), 7);
  check('and the one after it', decodeXY(batch.points[POINT_STRIDE]), 8);
  check('fullness 1000 - 900 - 30', r.fullness, 70);

  r = await host.send(queue(20000, 0x74));
  check("the page's 0x74 spelling of queue is taken too", r.response, 'a');

  // -- Underflow -----------------------------------------------------------
  check('still playing before underflow test', r.playback, PLAYBACK.PLAYING);
  clock += 10; // 200 points due at 20k, 70 there
  dac.tick();
  batch = batches[batches.length - 1];
  check('the last 70 were played before the underflow', batch.points.length / POINT_STRIDE, 70);
  r = await host.send(Buffer.from([0x3f]));
  check('underflow -> idle', r.playback, PLAYBACK.IDLE);
  check('underflow flag set', (r.playFlags >> 1) & 1, 1);
  check('underflow closes the shutter', r.playFlags & 1, 0);
  r = await host.send(data([point()]));
  check('data after underflow is invalid', r.response, 'I');
  r = await host.send(Buffer.from([0x70]));
  check('prepare clears underflow', (r.playFlags >> 1) & 1, 0);
  check('prepare resets point_count', r.pointCount, 0);

  // -- Stop ----------------------------------------------------------------
  await host.send(data(frame.slice(0, 100)));
  r = await host.send(begin(30000));
  check('playing again', r.playback, PLAYBACK.PLAYING);
  r = await host.send(Buffer.from([0x73]));
  check('stop acked', r.response, 'a');
  check('stop -> idle', r.playback, PLAYBACK.IDLE);
  check('stop keeps the buffer', r.fullness, 100);
  r = await host.send(Buffer.from([0x73]));
  check('stop while idle is invalid', r.response, 'I');

  // -- Emergency stop ------------------------------------------------------
  r = await host.send(Buffer.from([0x00]));
  check('e-stop acked', r.response, 'a');
  check('e-stop -> light engine 3', r.lightEngine, 3);
  check('e-stop light flag', r.lightFlags & 1, 1);
  r = await host.send(Buffer.from([0x70]));
  check('prepare under e-stop: stop condition', r.response, '!');
  r = await host.send(Buffer.from([0x3f]));
  check('ping under e-stop still acked', r.response, 'a');
  r = await host.send(Buffer.from([0x63]));
  check('clear e-stop acked', r.response, 'a');
  check('light engine ready again', r.lightEngine, 0);
  r = await host.send(Buffer.from([0xff]));
  check('0xff is an e-stop too', r.lightEngine, 3);
  await host.send(Buffer.from([0x63]));

  // -- Unknown command -----------------------------------------------------
  r = await host.send(Buffer.from([0x7a]));
  check('unknown command is invalid, not an e-stop', r.response, 'I');
  check('unknown command leaves the light engine alone', r.lightEngine, 0);

  // -- The host leaving ----------------------------------------------------
  await host.send(Buffer.from([0x70]));
  await host.send(data(frame.slice(0, 100)));
  await host.send(begin(30000));
  await host.close();
  await settle(50);
  check('disconnect -> idle', dac.report().playback, PLAYBACK.IDLE);
  check('disconnect forgets the host', dac.report().host, null);

  const again = new Host();
  await again.connect(dac.tcpPort);
  const hello2 = await again.next();
  check('a new host is welcome after the old one left', hello2.response, 'a');
  await again.close();

  // -- Report --------------------------------------------------------------
  const report = dac.report();
  check('report mac', report.mac, '02:be:a1:12:34:56');
  check('report capacity', report.capacity, 1800);

  dac.stop();
  listener.close();
  check('stopped', dac.listening, false);
}

run().then(() => {
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
