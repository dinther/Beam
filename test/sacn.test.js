/* eslint-disable no-console */
/* eslint-disable no-bitwise */
// Bit twiddling is the subject matter here: a packet header is fields packed
// into bytes, and spelling that as arithmetic would obscure the one thing a
// reader needs to check it against, which is the spec's own diagram.
/**
 * Reading an E1.31 packet.
 *
 * A DMX-over-IP parser is the kind of code that looks right and is one byte
 * out: the framing layer alone is 77 bytes of fields, and reading the priority
 * where the sync address lives gives a plausible number rather than an error.
 * So the packets here are built to the spec's own layout and fed to the real
 * parser, offsets included.
 *
 * The universe numbering is the part worth pinning hardest. E1.31 counts from
 * 1 and Beam's address space counts from 0 -- get that wrong and every fixture
 * in the show is one universe out, which looks like an addressing bug
 * anywhere but here.
 *
 * Usage:
 *   npm test
 */
import sacn from '@/electron/sacn';

let failures = 0;

function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(50)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

/**
 * An E1.31 data packet, laid out as ANSI E1.31-2018 says.
 *
 * @param {Object} options
 * @returns {Buffer}
 */
function packet({
  universe = 1,
  slots = [255, 128, 0],
  priority = 100,
  sequence = 1,
  options = 0,
  cid = 1,
  name = 'MadMapper',
  startCode = 0,
} = {}) {
  const buffer = Buffer.alloc(126 + slots.length);
  // Root layer. Preamble size, post-amble size, and only then the identifier:
  // these four bytes are what a self-built packet gets wrong in the same way
  // the parser does, so the offsets here are taken from a real MadMapper
  // packet captured on 2026-08-31 rather than from a reading of the spec.
  buffer.writeUInt16BE(0x0010, 0);
  buffer.writeUInt16BE(0x0000, 2);
  Buffer.from([0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37, 0, 0, 0]).copy(buffer, 4);
  buffer.writeUInt16BE(0x7000 | (buffer.length - 16), 16); // flags and length
  buffer.writeUInt32BE(0x00000004, 18); // VECTOR_ROOT_E131_DATA
  buffer.fill(cid, 22, 38); // CID, a distinct byte per source is enough here
  // Framing layer
  buffer.writeUInt16BE(0x7000 | (buffer.length - 38), 38);
  buffer.writeUInt32BE(0x00000002, 40); // VECTOR_E131_DATA_PACKET
  buffer.write(name, 44, 64, 'utf8');
  buffer.writeUInt8(priority, 108);
  buffer.writeUInt16BE(0, 109); // synchronization address
  buffer.writeUInt8(sequence, 111);
  buffer.writeUInt8(options, 112);
  buffer.writeUInt16BE(universe, 113);
  // DMP layer
  buffer.writeUInt16BE(0x7000 | (buffer.length - 115), 115);
  buffer.writeUInt8(0x02, 117); // VECTOR_DMP_SET_PROPERTY
  buffer.writeUInt8(0xa1, 118); // address type and data type
  buffer.writeUInt16BE(0, 119); // first property address
  buffer.writeUInt16BE(1, 121); // address increment
  buffer.writeUInt16BE(slots.length + 1, 123); // property value count, start code included
  buffer.writeUInt8(startCode, 125);
  Buffer.from(slots).copy(buffer, 126);
  return buffer;
}

/** A fresh parse, with the sequence and holder state left behind. */
const read = (options) => {
  sacn.sequences.clear();
  sacn.holders.clear();
  sacn.contended.clear();
  return sacn.parse(packet(options));
};

console.log('\nuniverse 1 on the wire is universe 0 in the show');
check('sACN 1', read({ universe: 1 }).universe, 0);
check('sACN 2', read({ universe: 2 }).universe, 1);
check('sACN 512', read({ universe: 512 }).universe, 511);
check('universe 0 is not a universe', read({ universe: 0 }), null);

console.log('\nthe slots arrive, and only the slots');
{
  const frame = read({ slots: [255, 128, 7] });
  check('three of them', frame.data.length, 3);
  check('first', frame.data[0], 255);
  check('last', frame.data[2], 7);
  // The count in the packet includes the start code; counting it as a slot
  // shifts every channel in the universe by one.
  check('the start code is not slot one', frame.data[0] === 0, false);
}

console.log('\nthe source names itself');
{
  const frame = read({ name: 'MadMapper', priority: 120 });
  check('name', frame.source.name, 'MadMapper');
  check('priority', frame.source.priority, 120);
  check('and is keyed by its CID', frame.source.key.length, 32);
}

console.log('\nwhat is not dimmer data is not ours');
check('an RDM start code', read({ startCode: 0xcc }), null);
check('a terminated stream', read({ options: 0x40 }), null);
check('a runt packet', sacn.parse(Buffer.alloc(60)), null);
check('somebody else on the port', sacn.parse(Buffer.alloc(200)), null);

console.log('\nstale packets are dropped, restarts are not');
{
  sacn.sequences.clear();
  sacn.holders.clear();
  const send = (sequence) => !!sacn.parse(packet({ sequence }));
  check('first packet', send(10), true);
  check('the next one', send(11), true);
  check('one that arrives late', send(10), false);
  check('one from well before', send(1), false);
  // A source that restarted its numbering has to be followed, or the show
  // freezes until the byte happens to wrap round to where it left off.
  check('a source that restarted', send(200), true);
  check('and the wrap at 255', send(0), true);
}

console.log('\ntwo sources on one universe');
{
  sacn.sequences.clear();
  sacn.holders.clear();
  sacn.contended.clear();
  const from = (cid, priority, sequence) => !!sacn.parse(
    packet({
      cid, priority, sequence, name: `Source ${cid}`,
    }),
  );
  check('the first source is believed', from(1, 100, 1), true);
  check('a louder one takes over', from(2, 150, 1), true);
  check('and the quiet one is refused', from(1, 100, 2), false);
  check('until it shouts louder', from(1, 200, 3), true);
}

console.log('\nthe multicast group for a universe');
check('universe 1', sacn.constructor.groupFor(1), '239.255.0.1');
check('universe 255', sacn.constructor.groupFor(255), '239.255.0.255');
check('universe 256', sacn.constructor.groupFor(256), '239.255.1.0');
check('universe 386', sacn.constructor.groupFor(386), '239.255.1.130');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
