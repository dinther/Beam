/* A reference IDN producer: discover, ask for the service map, then stream to
   two named services on ONE unit at ONE address. This is what MadMapper would
   have to do; Beam's consumer half already handles it. */
import dgram from 'dgram';
import IdnDac, { CMD, CFL_ROUTING } from '../src/electron/idn.js';

const MODE_GRAPHIC_CONTINUOUS = 1;
/** The standard tag set MadMapper already sends: x, y, r, g, b in 7 octets. */
const DICTIONARY = [0x42, 0x00, 0x40, 0x10, 0x42, 0x10, 0x40, 0x10,
  0x52, 0x7e, 0x52, 0x14, 0x51, 0xcc, 0x00, 0x00];

function sample(x, y, r, g, b) {
  const s = Buffer.alloc(7);
  s.writeInt16BE(x, 0); s.writeInt16BE(y, 2); s[4] = r; s[5] = g; s[6] = b;
  return s;
}

/** One IDN-Stream channel message, addressed to a named service. */
function channelMessage({
  serviceId, samples, duration, channel = 0, dictionary = null,
}) {
  const config = dictionary
    ? Buffer.concat([Buffer.from([dictionary.length / 4, CFL_ROUTING, serviceId,
      MODE_GRAPHIC_CONTINUOUS]), Buffer.from(dictionary)])
    : Buffer.alloc(0);
  const chunk = Buffer.alloc(4);
  chunk.writeUIntBE(duration, 1, 3);
  const body = Buffer.concat([config, chunk, ...samples]);
  const head = Buffer.alloc(8);
  head.writeUInt16BE(8 + body.length, 0);
  head.writeUInt8(0x80 | (dictionary ? 0x40 : 0) | channel, 2);
  head.writeUInt8(0x01, 3); // frame samples
  const hello = Buffer.alloc(4);
  hello.writeUInt8(CMD.MESSAGE, 0);
  return Buffer.concat([hello, head, body]);
}

const PORT = 7355;
const got = new Map();

const dac = new IdnDac({ name: 'Beam', port: PORT, answerLoopback: true });
dac.setServices([{ id: 1, name: 'Front Left' }, { id: 2, name: 'Front Right' }]);
await dac.start((batch) => {
  const k = batch.service;
  got.set(k, (got.get(k) || 0) + Math.floor(batch.points.length / 6));
});
console.log(`consumer up on 127.0.0.1:${PORT}, offering 2 named services\n`);

const client = dgram.createSocket('udp4');
const replies = [];
client.on('message', (m) => replies.push(m));
const send = (p) => new Promise((r) => client.send(p, PORT, '127.0.0.1', () => setTimeout(r, 60)));
const hello = (cmd) => { const b = Buffer.alloc(4); b.writeUInt8(cmd, 0); b.writeUInt16BE(1, 2); return b; };

// 1. Discover.
await send(hello(CMD.SCAN_REQUEST));
const scan = replies.find((m) => m.readUInt8(0) === CMD.SCAN_RESPONSE);
console.log(`1. SCAN_RESPONSE: unit "${scan.toString('ascii', 24, 44).replace(/\0.*$/, '')}"`);

// 2. Ask for the service map -- the step MadMapper skips.
replies.length = 0;
await send(hello(CMD.MAP_REQUEST));
const map = replies.find((m) => m.readUInt8(0) === CMD.MAP_RESPONSE);
if (!map) {
  console.log('2. no MAP_RESPONSE');
} else {
  const entrySize = map.readUInt8(5);
  const count = map.readUInt8(7);
  console.log(`2. MAP_RESPONSE: ${count} service(s)`);
  for (let i = 0; i < count; i += 1) {
    const at = 8 + i * entrySize;
    console.log(`     id ${map.readUInt8(at)}  "${map.toString('ascii', at + 4, at + entrySize).replace(/\0.*$/, '')}"`);
  }
}

// 3. Stream a different figure to each service, from ONE socket, ONE address.
const left = [sample(-20000, 0, 255, 0, 0), sample(20000, 0, 255, 0, 0)];
const right = Array.from({ length: 6 }, (_, i) => sample(0, -20000 + i * 8000, 0, 0, 255));
for (let frame = 0; frame < 5; frame += 1) {
  await send(channelMessage({
    serviceId: 1, samples: left, duration: 4000, channel: 0, dictionary: DICTIONARY,
  }));
  await send(channelMessage({
    serviceId: 2, samples: right, duration: 4000, channel: 1, dictionary: DICTIONARY,
  }));
}
for (let i = 0; i < 12; i += 1) { dac.tick(); await new Promise((r) => setTimeout(r, 20)); }

console.log('\n3. points delivered, by service:');
for (const [id, n] of [...got.entries()].sort()) {
  const name = id === 1 ? 'Front Left' : id === 2 ? 'Front Right' : '?';
  console.log(`     service ${id} (${name}): ${n} points`);
}
console.log(`\nexpected: service 1 gets ${left.length * 5}, service 2 gets ${right.length * 5}`);
client.close();
dac.stop();
process.exit(0);
