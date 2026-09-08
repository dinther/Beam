/* eslint-disable no-console */
/* eslint-disable no-bitwise */
// Bit twiddling is the subject matter here: a cube packet is fields packed
// into bytes, and spelling that as arithmetic would obscure the one thing a
// reader needs to check it against, which is the host library's own decoder.
/**
 * Being a LaserCube.
 *
 * The tests play LaserOS: ping the alive port, ask for full info, enable
 * buffer replies and output, set the rate, stream points, and read the free
 * count back -- over real UDP sockets to the real device code. The clock is a
 * fake so the buffer is played out by hand.
 *
 * The byte offsets are the ones `LaserDockNetworkDevice::handleFullInfoPkt`
 * reads in Wicked Lasers' own host library, taken from that file and not
 * from anyone's notes about it: the widely copied Python controller reads
 * the same packet one byte off (its "output enabled" is the firmware minor
 * version), which is exactly the kind of disagreement a self-built packet
 * cannot detect. The first live LaserOS is what settles anything both this
 * and the host library have wrong together.
 *
 * Usage:
 *   npm test
 */
import dgram from 'dgram';
import LaserCubeDac, { POINT_STRIDE } from '@/electron/lasercube';

let failures = 0;

function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

/** Waits for the event loop to turn, so a datagram has time to land. */
const settle = (ms = 30) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * One of the host's sockets: sends to the cube and hands replies out in
 * order. A reply that does not arrive within a short wait fails the test
 * rather than hanging it.
 */
class HostSocket {
  constructor() {
    this.socket = null;
    this.inbox = [];
    this.waiters = [];
  }

  open() {
    return new Promise((resolve) => {
      const socket = dgram.createSocket('udp4');
      socket.on('message', (msg) => {
        if (this.waiters.length) this.waiters.shift()(msg);
        else this.inbox.push(msg);
      });
      socket.bind(0, '127.0.0.1', () => resolve());
      this.socket = socket;
    });
  }

  /** Sends `packet` to `port` on loopback; resolves with the next reply. */
  request(packet, port, timeout = 300) {
    return new Promise((resolve) => {
      if (this.inbox.length) {
        resolve(this.inbox.shift());
        return;
      }
      let timer = null;
      const waiter = (msg) => {
        clearTimeout(timer);
        resolve(msg);
      };
      timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(null);
      }, timeout);
      this.waiters.push(waiter);
      this.socket.send(packet, port, '127.0.0.1');
    });
  }

  /** Sends without waiting. */
  send(packet, port) {
    this.socket.send(packet, port, '127.0.0.1');
  }

  close() {
    this.socket.close();
  }
}

/** A point on the wire: five little-endian uint16, twelve bits used. */
function point(x, y, r, g, b) {
  const buffer = Buffer.alloc(10);
  buffer.writeUInt16LE(x, 0);
  buffer.writeUInt16LE(y, 2);
  buffer.writeUInt16LE(r, 4);
  buffer.writeUInt16LE(g, 6);
  buffer.writeUInt16LE(b, 8);
  return buffer;
}

/** A data datagram. */
function data(message, frame, points) {
  return Buffer.concat([Buffer.from([0xa9, 0x00, message & 0xff, frame & 0xff]), ...points]);
}

/** A command carrying a little-endian uint32. */
function u32(cmd, value) {
  const buffer = Buffer.alloc(5);
  buffer[0] = cmd;
  buffer.writeUInt32LE(value, 1);
  return buffer;
}

/** Reads the info reply the way the host library does. */
function info(p) {
  let name = '';
  for (let at = 38; at < p.length && p[at] !== 0; at++) name += String.fromCharCode(p[at]);
  return {
    cmd: p[0],
    result: p[1],
    version: p[2],
    fwMajor: p[3],
    fwMinor: p[4],
    outputEnabled: (p[5] & 1) === 1,
    rate: p.readUInt32LE(10),
    maxRate: p.readUInt32LE(14),
    free: p.readUInt16LE(19),
    size: p.readUInt16LE(21),
    battery: p[23],
    temperature: p.readInt8(24),
    connectionType: p[25] + 1,
    serial: p.subarray(26, 32).toString('hex'),
    modelNumber: p[37],
    name,
  };
}

const decodeXY = (v) => (v << 16) >> 16;

async function run() {
  let clock = 0;
  const batches = [];

  const dac = new LaserCubeDac({
    name: 'test cube',
    serial: [0xbe, 0xa1, 0x12, 0x34, 0x56, 0x78],
    model: 'Beam test',
    modelNumber: 10,
    alivePort: 0,
    cmdPort: 0,
    dataPort: 0,
    // One datagram per reply, so the request/reply bookkeeping is one-to-one.
    // That every reply is doubled on the wire is checked once, separately.
    replyRepeat: 1,
    now: () => clock,
    timers: false,
  });
  await dac.start((batch) => batches.push(batch), { bind: '127.0.0.1' });
  check('three ports bound', dac.alivePort > 0 && dac.cmdPort > 0 && dac.dataPort > 0, true);
  check('ports are distinct', new Set([dac.alivePort, dac.cmdPort, dac.dataPort]).size, 3);

  // -- Replies are doubled by default, as the hardware does -----------------
  // Its own DAC, on its own ports, so the one-datagram-per-reply assumption
  // the rest of the suite relies on is not disturbed.
  const twin = new LaserCubeDac({
    name: 'doubling cube', alivePort: 0, cmdPort: 0, dataPort: 0, timers: false,
  });
  await twin.start(() => {}, { bind: '127.0.0.1' });
  let twinReplies = 0;
  const counter = dgram.createSocket('udp4');
  counter.on('message', () => { twinReplies += 1; });
  await new Promise((resolve) => { counter.bind(0, '127.0.0.1', resolve); });
  counter.send(Buffer.from([0x27]), twin.alivePort, '127.0.0.1');
  await settle(80);
  check('a real cube answers one ping with two datagrams', twinReplies, 2);
  counter.close();
  twin.stop();

  const ping = new HostSocket();
  const cmd = new HostSocket();
  const dataSock = new HostSocket();
  await Promise.all([ping.open(), cmd.open(), dataSock.open()]);

  // -- Discovery -----------------------------------------------------------
  let r = await ping.request(Buffer.from([0x27]), dac.alivePort);
  check('alive ping answered', r && r.toString('hex'), '2700');
  r = await ping.request(Buffer.from([0x99]), dac.alivePort);
  check('alive port ignores anything but a ping', r, null);

  r = await cmd.request(Buffer.from([0x77]), dac.cmdPort);
  check('full info is 64 bytes', r && r.length, 64);
  let i = info(r);
  check('info echoes the command', i.cmd, 0x77);
  check('info result ok', i.result, 0);
  check('info payload version 0', i.version, 0);
  check('info firmware 0.23, as the cube reports', `${i.fwMajor}.${i.fwMinor}`, '0.23');
  check('info output disabled at start', i.outputEnabled, false);
  check('info interlock enabled, as the cube reports', (r[5] >> 1) & 1, 1);
  check('info min DAC value', r.readUInt16LE(6), 0);
  check('info max DAC value 4095', r.readUInt16LE(8), 4095);
  check('info rate defaults to the maximum', i.rate, 35000);
  check('info max rate', i.maxRate, 35000);
  check('info byte 18 as the cube sends it', r[18], 3);
  check('info buffer free', i.free, 6000);
  check('info buffer size', i.size, 6000);
  check('info battery', i.battery, 95);
  check('info connection type ethernet client', i.connectionType, 3);
  check('info serial', i.serial, 'bea112345678');
  check('info own address is the loopback it answered from', [...r.subarray(32, 36)].join('.'), '127.0.0.1');
  check('info byte 36 as the cube sends it', r[36], 2);
  check('info model number', i.modelNumber, 10);
  check('info model name', i.name, 'Beam test');

  // -- The host's init sequence --------------------------------------------
  r = await cmd.request(Buffer.from([0x80, 0x00]), dac.cmdPort);
  check('disable output acked', r && r.toString('hex'), '8000');
  r = await cmd.request(Buffer.from([0x78, 0x01]), dac.cmdPort);
  check('enable buffer replies acked', r && r.toString('hex'), '7800');
  r = await cmd.request(u32(0x82, 25000), dac.cmdPort);
  check('set rate acked', r && r.toString('hex'), '8200');
  r = await cmd.request(u32(0x82, 40000), dac.cmdPort);
  check('rate above maximum fails', r && r.toString('hex'), '8201');
  r = await cmd.request(Buffer.from([0x80, 0x01]), dac.cmdPort);
  check('enable output acked', r && r.toString('hex'), '8000');
  i = info(await cmd.request(Buffer.from([0x77]), dac.cmdPort));
  check('info now shows output enabled', i.outputEnabled, true);
  check('info now shows the set rate', i.rate, 25000);

  // -- Points --------------------------------------------------------------
  const frame = [];
  for (let n = 0; n < 140; n++) {
    frame.push(point(n * 29, 4095 - n * 29, n * 29, 4095 - n * 29, n & 1 ? 4095 : 0));
  }
  frame[0] = point(0, 2048, 0, 0, 0);
  frame[1] = point(2048, 4095, 4095, 4095, 4095);
  r = await dataSock.request(data(0, 0, frame), dac.dataPort);
  check('data answered with the free-count reply', r && r.subarray(0, 2).toString('hex'), '8a00');
  check('free after 140 points', r && r.readUInt16LE(2), 5860);
  r = await cmd.request(Buffer.from([0x8a]), dac.cmdPort);
  check('free count on request', r && r.readUInt16LE(2), 5860);

  clock += 10; // 250 due at 25 kpps, 140 there
  dac.tick();
  check('one batch', batches.length, 1);
  const batch = batches[0];
  check('batch carries the rate', batch.rate, 25000);
  check('the 140 points played', batch.points.length / POINT_STRIDE, 140);
  check('x 0 -> full left', decodeXY(batch.points[0]), -32768);
  check('y 2048 -> centre', decodeXY(batch.points[1]), 0);
  check('x 2048 -> centre', decodeXY(batch.points[POINT_STRIDE]), 0);
  check('y 4095 -> full up', decodeXY(batch.points[POINT_STRIDE + 1]), 32752);
  check('r 4095 -> 65520', batch.points[POINT_STRIDE + 2], 65520);
  check('intensity is full', batch.points[POINT_STRIDE + 5], 65535);
  check('r 0 -> 0', batch.points[2], 0);
  r = await cmd.request(Buffer.from([0x8a]), dac.cmdPort);
  check('buffer drained', r && r.readUInt16LE(2), 6000);

  // -- Running dry is a pause, not an error --------------------------------
  clock += 10;
  dac.tick();
  check('nothing played from an empty buffer', batches.length, 1);
  await dataSock.request(data(1, 1, frame.slice(0, 50)), dac.dataPort);
  clock += 1; // 25 due
  dac.tick();
  check('plays again as soon as points arrive', batches.length, 2);
  check('and only what the clock asked for', batches[1].points.length / POINT_STRIDE, 25);

  // -- Output off drains but shows nothing ---------------------------------
  await cmd.request(Buffer.from([0x80, 0x00]), dac.cmdPort);
  clock += 10;
  dac.tick();
  check('no batch while output is disabled', batches.length, 2);
  r = await cmd.request(Buffer.from([0x8a]), dac.cmdPort);
  check('but the buffer still drained', r && r.readUInt16LE(2), 6000);
  await cmd.request(Buffer.from([0x80, 0x01]), dac.cmdPort);

  // -- Fill level ----------------------------------------------------------
  r = await cmd.request(u32(0xa0, 6000), dac.cmdPort);
  check('a level at the buffer size fails', r && r.toString('hex'), 'a001');
  r = await cmd.request(u32(0xa0, 500), dac.cmdPort);
  check('a level below it is acked', r && r.toString('hex'), 'a000');
  clock += 10;
  dac.tick(); // runs dry against the level
  await dataSock.request(data(2, 2, frame), dac.dataPort);
  clock += 10;
  dac.tick();
  check('below the level nothing plays', batches.length, 2);
  await dataSock.request(data(3, 2, frame), dac.dataPort);
  await dataSock.request(data(4, 2, frame), dac.dataPort);
  await dataSock.request(data(5, 2, frame), dac.dataPort);
  clock += 10;
  dac.tick();
  check('at the level it plays', batches.length, 3);
  check('250 played of 560', batches[2].points.length / POINT_STRIDE, 250);

  // -- Clear ----------------------------------------------------------------
  r = await cmd.request(Buffer.from([0x8d]), dac.cmdPort);
  check('clear acked', r && r.toString('hex'), '8d00');
  r = await cmd.request(Buffer.from([0x8a]), dac.cmdPort);
  check('clear empties the buffer', r && r.readUInt16LE(2), 6000);

  // -- Sequence numbers ----------------------------------------------------
  await dataSock.request(data(6, 3, frame.slice(0, 10)), dac.dataPort);
  await dataSock.request(data(9, 3, frame.slice(0, 10)), dac.dataPort);
  check('two datagrams noticed missing', dac.report().lostDatagrams, 2);
  await dataSock.request(data(255, 3, frame.slice(0, 10)), dac.dataPort);
  await dataSock.request(data(0, 4, frame.slice(0, 10)), dac.dataPort);
  check('wrap from 255 to 0 is not a loss', dac.report().lostDatagrams, 2 + ((255 - 10) & 0xff));

  // -- Overfilling drops the excess ----------------------------------------
  await cmd.request(Buffer.from([0x8d]), dac.cmdPort);
  await cmd.request(u32(0xa0, 0), dac.cmdPort);
  const big = [];
  for (let n = 0; n < 140; n++) big.push(point(1, 1, 1, 1, 1));
  for (let n = 0; n < 43; n++) dataSock.send(data(n, 5, big), dac.dataPort); // 6020
  await settle(100);
  r = await cmd.request(Buffer.from([0x8a]), dac.cmdPort);
  check('buffer full', r && r.readUInt16LE(2), 0);
  check('the overflow was dropped, counted', dac.report().droppedPoints, 20);
  // The burst above was fire-and-forget, so its buffer-free replies piled up
  // unwaited; drop them before a check that expects no reply at all.
  await settle(50);
  dataSock.inbox.length = 0;

  // -- Compressed data is refused quietly ----------------------------------
  const compressed = Buffer.concat([Buffer.from([0x9a, 0, 0, 0]), point(1, 1, 1, 1, 1)]);
  r = await dataSock.request(compressed, dac.dataPort, 60);
  check('compressed data gets no reply', r, null);

  // -- Security ------------------------------------------------------------
  const challenge = Buffer.alloc(51);
  challenge[0] = 0xb0;
  r = await cmd.request(challenge, dac.cmdPort);
  check('security request acked', r && r.toString('hex'), 'b000');
  r = await cmd.request(Buffer.from([0xb1]), dac.cmdPort);
  check('security response is command + 2 + 35 bytes', r && r.length, 38);
  check('security response ok bytes', r && r.subarray(0, 3).toString('hex'), 'b10000');
  check('one security request seen', dac.report().securityRequests, 1);

  // -- Odds and ends --------------------------------------------------------
  r = await cmd.request(Buffer.from([0x27]), dac.cmdPort);
  check('ping on the command port answered too', r && r.toString('hex'), '2700');
  r = await cmd.request(Buffer.from([0x97, 0xa2, 0x2a, 1, 2, 0x41, 0]), dac.cmdPort);
  check('factory model command acked and ignored', r && r.toString('hex'), '9700');
  check('model name unchanged', info(await cmd.request(Buffer.from([0x77]), dac.cmdPort)).name, 'Beam test');
  r = await cmd.request(Buffer.from([0x55]), dac.cmdPort);
  check('unknown command fails', r && r.toString('hex'), '5501');

  const report = dac.report();
  check('report protocol', report.protocol, 'lasercube');
  check('report serial', report.serial, 'be:a1:12:34:56:78');
  check('report host', typeof report.host, 'string');

  dac.stop();
  ping.close();
  cmd.close();
  dataSock.close();
  check('stopped', dac.listening, false);
}

run().then(() => {
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
