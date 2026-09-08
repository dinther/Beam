/* eslint-disable no-console */
/* eslint-disable no-bitwise */
// Bit twiddling is the subject matter here: an IDN datagram is fields packed
// into bytes and a dictionary of 16-bit tags, and spelling that as arithmetic
// would obscure the one thing a reader needs to check it against, which is the
// standard's own tables.
/**
 * Being an IDN server.
 *
 * Two halves, and they fail in different ways. Discovery is what puts a name in
 * a producer's device list, so those tests read the reply the way a client
 * would -- struct sizes, offsets, and the strings at the end. The stream half
 * is where the real risk lives: IDN does not fix a sample layout, it sends a
 * dictionary describing one, so the tests drive the decoder with the tag sets
 * the standard itself prints (ISP-DB25 defaults, and the IDTF X/Y/R/G/B set)
 * and check the points that come out the other side.
 *
 * The packet layouts here are written from the standard's tables:
 * IDN-Hello draft 2022-03-27 and IDN-Stream revision 001. A self-built packet
 * agrees with whatever the parser believes, so the one thing this cannot prove
 * is an offset both sides got wrong the same way; a live MadMapper stream
 * settles that, as it did for sACN.
 *
 * Usage:
 *   npm test
 */
import dgram from 'dgram';
import IdnDac, {
  decodeTags, CMD, CFL_ROUTING, CFL_CLOSE,
  MODE_GRAPHIC_CONTINUOUS, MODE_GRAPHIC_DISCRETE,
} from '@/electron/idn';

let failures = 0;

function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

/** A fake clock, so a buffer is played out by hand rather than by waiting. */
function fakeClock() {
  const clock = { t: 0 };
  clock.now = () => clock.t;
  return clock;
}

/** Builds a tag dictionary buffer from 16-bit words. */
function tags(...words) {
  const buffer = Buffer.alloc(words.length * 2);
  words.forEach((word, i) => buffer.writeUInt16BE(word, i * 2));
  return buffer;
}

// -- the tag dictionary ------------------------------------------------------

console.log('\n-- a decoder is built from the tags, not assumed --');
{
  // The standard's own default set for IDTF X/Y/R/G/B projectors.
  const dictionary = tags(0x4200, 0x4010, 0x4210, 0x4010, 0x527e, 0x5214, 0x51cc);
  const { fields, size } = decodeTags(dictionary, 0, 7);
  check('seven tags describe five values', fields.length, 5);
  check('a sample is seven octets', size, 7);
  check('X takes two octets', `${fields[0].kind}:${fields[0].bytes}`, 'x:2');
  check('Y takes two octets', `${fields[1].kind}:${fields[1].bytes}`, 'y:2');
  check('638 nm is red', fields[2].kind, 'r');
  check('532 nm is green', fields[3].kind, 'g');
  check('460 nm is blue', fields[4].kind, 'b');
}

console.log('\n-- the ISP-DB25 default set, which carries more than we render --');
{
  // Shutter, intensity, six colour lines, then X and Y with precision.
  const isp = [
    0x4101, 0x5c10, 0x527e, 0x5214, 0x51cc, 0x51bd,
    0x5241, 0x51e8, 0x4200, 0x4010, 0x4210, 0x4010,
  ];
  const dictionary = tags(...isp);
  const { fields, size } = decodeTags(dictionary, 0, 12);
  // Twelve octets: shutter, intensity, six colour lines, and two coordinates
  // of two octets each.
  check('the sample is twelve octets', size, 12);
  check('the shutter octet is stepped over', fields[0].kind, null);
  check('intensity is stepped over', fields[1].kind, null);
  check('deep blue folds into blue', fields[5].kind, 'b');
  check('yellow folds to its nearest primary', fields[6].kind, 'g');
  check('and cyan to its own', fields[7].kind, 'b');
  check('X still lands with precision', `${fields[8].kind}:${fields[8].bytes}`, 'x:2');
}

console.log('\n-- tags that own no octet, and tags that carry their own data --');
{
  // A category 0 struct tag with two data words, then a coordinate pair.
  const dictionary = tags(0x0002, 0xdead, 0xbeef, 0x4200, 0x4210);
  const { fields, size } = decodeTags(dictionary, 0, 5);
  check('the struct data is skipped', fields.length, 2);
  check('leaving one octet each', size, 2);
  check('and the coordinates still decode', `${fields[0].kind}${fields[1].kind}`, 'xy');
}

// -- discovery, which is where the name comes from ---------------------------

async function discovery() {
  const clock = fakeClock();
  const dac = new IdnDac({
    now: clock.now, timers: false, port: 0, answerLoopback: true,
  });
  await dac.start(() => {});
  const { port } = dac.socket.address();
  const client = dgram.createSocket('udp4');

  const ask = (command) => new Promise((resolve) => {
    client.once('message', (msg) => resolve(msg));
    const packet = Buffer.alloc(4);
    packet.writeUInt8(command, 0);
    packet.writeUInt16BE(0x1234, 2);
    client.send(packet, port, '127.0.0.1');
  });

  console.log('\n-- a scan tells a producer who we are --');
  const scan = await ask(CMD.SCAN_REQUEST);
  check('answered with a scan response', scan.readUInt8(0), CMD.SCAN_RESPONSE);
  check('the sequence is echoed', scan.readUInt16BE(2), 0x1234);
  check('the struct says its own size', scan.readUInt8(4), 40);
  // 0x01: what real hardware sends, per the ILDA Wireshark trace.
  check('the protocol version real units send', scan.readUInt8(5), 0x01);
  check('and offers realtime', scan.readUInt8(6) & 0x01, 1);
  // Unit ID at 4+4, host name 16 octets after that.
  check('the unit ID leads with its length', scan.readUInt8(8), 0x07);
  const hostName = scan.toString('ascii', 24, 44).replace(/\0.*$/, '');
  check('and it is called Beam', hostName, 'Beam');

  console.log('\n-- and a service map names the service --');
  const map = await ask(CMD.MAP_REQUEST);
  check('answered with a map response', map.readUInt8(0), CMD.MAP_RESPONSE);
  check('header is four octets', map.readUInt8(4), 4);
  check('an entry is twenty four', map.readUInt8(5), 24);
  check('no relays', map.readUInt8(6), 0);
  check('one service', map.readUInt8(7), 1);
  check('service ID 1', map.readUInt8(8), 1);
  check('typed as a laser projector', map.readUInt8(9), 1);
  check('marked as the default', map.readUInt8(10) & 0x01, 1);
  check('a root service, behind no relay', map.readUInt8(11), 0);
  const serviceName = map.toString('ascii', 12, 32).replace(/\0.*$/, '');
  check('named Beam as well', serviceName, 'Beam');

  console.log('\n-- the service map lists the lasers in the show, by name --');
  dac.setServices([{ id: 1, name: 'Beam high' }, { id: 2, name: 'Beam low' }]);
  const named = await ask(CMD.MAP_REQUEST);
  check('two services offered', named.readUInt8(7), 2);
  check('the first is service 1', named.readUInt8(8), 1);
  check('and is the default', named.readUInt8(10) & 0x01, 1);
  check('named for the fixture', named.toString('ascii', 12, 32).split(String.fromCharCode(0))[0], 'Beam high');
  check('the second is service 2', named.readUInt8(32), 2);
  check('not also the default', named.readUInt8(34) & 0x01, 0);
  check('and carries its own name', named.toString('ascii', 36, 56).split(String.fromCharCode(0))[0], 'Beam low');
  check('each service has its own buffer', dac.serviceDac(1) === dac.serviceDac(2), false);
  // A rename keeps the buffer and clock rather than dropping the stream.
  const before = dac.serviceDac(2);
  dac.setServices([{ id: 1, name: 'Beam high' }, { id: 2, name: 'Beam mid' }]);
  check('a rename keeps the stream', dac.serviceDac(2) === before, true);

  console.log('\n-- a ping is answered --');
  const ping = await ask(CMD.PING_REQUEST);
  check('with a ping response', ping.readUInt8(0), CMD.PING_RESPONSE);

  client.close();
  dac.stop();
}

// -- the stream ---------------------------------------------------------------

/**
 * Builds a channel message: hello header, channel header, optional config and
 * tag dictionary, a chunk header, then samples.
 */
function channelMessage({
  chunkType = 0x01, dictionary = null, samples = [], duration = 0, channel = 0,
  cfl = CFL_ROUTING, mode = MODE_GRAPHIC_CONTINUOUS,
}) {
  if (dictionary && dictionary.length % 4) throw new Error('dictionary must be 32-bit aligned');
  const config = dictionary
    ? Buffer.concat([Buffer.from([dictionary.length / 4, cfl, 1, mode]), dictionary])
    : Buffer.alloc(0);
  // Flags, then the duration in the low three octets. Four octets, not eight.
  const chunk = Buffer.alloc(4);
  chunk.writeUIntBE(duration, 1, 3);
  const data = Buffer.concat(samples.map((s) => Buffer.from(s)));
  const body = Buffer.concat([config, chunk, data]);

  const channelHeader = Buffer.alloc(8);
  channelHeader.writeUInt16BE(8 + body.length, 0);
  channelHeader.writeUInt8(0x80 | (dictionary ? 0x40 : 0) | channel, 2);
  channelHeader.writeUInt8(chunkType, 3);

  const hello = Buffer.alloc(4);
  hello.writeUInt8(CMD.MESSAGE, 0);
  return Buffer.concat([hello, channelHeader, body]);
}

async function stream() {
  const clock = fakeClock();
  const played = [];
  const dac = new IdnDac({
    now: clock.now, timers: false, port: 0, answerLoopback: true,
  });
  await dac.start((batch) => played.push(batch));
  const { port } = dac.socket.address();
  const client = dgram.createSocket('udp4');
  const send = (packet) => new Promise((resolve) => {
    client.send(packet, port, '127.0.0.1', () => setTimeout(resolve, 20));
  });

  console.log('\n-- a frame is decoded through its own dictionary --');
  // Eight tags, not seven: the array is padded to a 32 bit boundary with the
  // Void tag, which is exactly what that tag is for. Seven would leave the
  // service configuration a half word long and shift everything after it.
  const dictionary = tags(0x4200, 0x4010, 0x4210, 0x4010, 0x527e, 0x5214, 0x51cc, 0x0000);
  // Three samples: the first is the invisible start point the standard requires.
  const samples = [
    [0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff],
    [0x40, 0x00, 0x20, 0x00, 0xff, 0x00, 0x00],
    [0xc0, 0x00, 0xe0, 0x00, 0x00, 0x80, 0x00],
  ];
  // 3 samples over 100 microseconds of scan: 2 segments, so 20 kpps.
  await send(channelMessage({ dictionary, samples, duration: 100 }));
  const svc = dac.serviceDac(1);
  check('the rate came from the frame duration', svc.pointRate, 20000);
  check('and three points are buffered', svc.count, 3);

  // Play them out by hand and look at what the renderer is handed.
  clock.t += 1;
  dac.tick();
  const batch = played[played.length - 1];
  check('three points reached the renderer', batch.points.length / 6, 3);
  // Continuous mode: each message is the next slice of an unbroken stream, so
  // nothing is forced dark. Blanking the leading sample here is what punched a
  // gap every 120 points and made the figure flicker.
  check('continuous leaves the first sample alone', batch.points[2], 0xffff);
  check('X is a signed 16 bit pattern', batch.points[6], 0x4000);
  check('Y too', batch.points[7], 0x2000);
  check('red is full', batch.points[8], 0xffff);
  check('green is not', batch.points[9], 0);
  check('a negative X stays negative', (batch.points[12] << 16) >> 16, -0x4000);
  // 0x80 widened by replication is 128/255 of full, not 128/256.
  check('and green is half', batch.points[15], 0x8080);

  console.log('\n-- a discrete frame does blank its cursor move --');
  {
    // The other half of the rule: a discrete frame stands on its own, and its
    // first sample is where the cursor is moved before the shape starts.
    await send(channelMessage({
      dictionary, samples, duration: 100, channel: 2, mode: MODE_GRAPHIC_DISCRETE,
    }));
    clock.t += 1;
    dac.tick();
    const discrete = played[played.length - 1];
    check('discrete blanks the start point', discrete.points[2], 0);
    check('but not the samples after it', discrete.points[8], 0xffff);
  }

  console.log('\n-- routing opens a channel; only close closes it --');
  {
    // The bug this guards: IDN-Stream draws CFL bits MSB first, so Routing is
    // 0x01 and Close is 0x02. Reading 0x01 as Close shut every channel the
    // instant it opened, and a stream that discovered and configured perfectly
    // drew absolutely nothing.
    check('routing is the low bit', CFL_ROUTING, 0x01);
    check('and close the one above', CFL_CLOSE, 0x02);
    const held = svc.playedTotal;
    await send(channelMessage({
      dictionary, samples, duration: 100, channel: 1, cfl: CFL_ROUTING,
    }));
    clock.t += 1;
    dac.tick();
    check('a routed channel draws', svc.playedTotal > held, true);

    const after = svc.playedTotal;
    await send(channelMessage({
      dictionary, samples, duration: 100, channel: 1, cfl: CFL_ROUTING | CFL_CLOSE,
    }));
    await send(channelMessage({ samples, duration: 100, channel: 1 }));
    clock.t += 1;
    dac.tick();
    // The closing message's own samples still draw; the one after finds no
    // channel and is ignored.
    check('a closed channel stops drawing', svc.playedTotal, after + samples.length);
  }

  console.log('\n-- which laser a message feeds --');
  // A producer that names its service is believed. One that does not --
  // MadMapper sends service 0 on channel 0 for every output -- gets the
  // channel's laser, then the first. Telling MadMapper's outputs apart is
  // not IDN's job any more; they reach Beam over Ponk, by name.
  dac.setServices([{ id: 1, name: 'Laser Left' }, { id: 2, name: 'Laser Right' }]);
  check('a named service is that laser', dac.serviceDac(2, 0).name.endsWith('Laser Right'), true);
  check('unnamed on channel 0: the first', dac.serviceDac(0, 0).name.endsWith('Laser Left'), true);
  check('unnamed on channel 1: the second', dac.serviceDac(0, 1).name.endsWith('Laser Right'), true);
  check('a channel past the last: the first', dac.serviceDac(0, 7).name.endsWith('Laser Left'), true);
  check('no endpoint pairing left', typeof dac.rotateStreams, 'undefined');

  console.log('\n-- data without a dictionary is ignored, not guessed at --');
  const before = svc.playedTotal;
  await send(channelMessage({ samples, duration: 100, channel: 3 }));
  check('an unconfigured channel draws nothing', svc.playedTotal, before);

  client.close();
  dac.stop();
}

(async () => {
  await discovery();
  await stream();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
