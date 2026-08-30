/* eslint-disable no-console */
/* eslint-disable no-bitwise */
// Bit twiddling is the subject matter here: a packet header is fields packed
// into bytes, and spelling that as arithmetic would obscure the one thing a
// reader needs to check it against, which is the spec's own diagram.
import DmxReceiver, { DMX_LENGTH } from './dmx_receiver';

/**
 * sACN (E1.31) UDP engine (main process).
 *
 * The second thing on the wire that speaks DMX, and the one that says who it
 * is. A packet carries a CID, a 64-character source name and a priority, so
 * two applications sending the same universe can be named rather than merely
 * suspected -- which is exactly the confusion that cost a day when MadMapper
 * and LEDfx were both writing the same tile and each one's ceiling looked like
 * the other's failure.
 *
 * Everything after the parse is `DmxReceiver`'s and shared with Art-Net.
 *
 * **Universe numbering.** E1.31 counts universes from 1; Art-Net counts from 0,
 * and Beam's address space is an offset from 0, which is what the patch bay
 * shows and what a user types. So sACN universe 1 is Beam universe 0, and the
 * subtraction happens here, once, at the edge. It is not a setting: every other
 * application makes the same subtraction, and an offset nobody can see is a
 * thing to get wrong at two in the morning.
 *
 * **What is not done, deliberately.** No sync packets (E1.31 universe
 * synchronization), and no HTP merge: where two sources send one universe the
 * higher priority wins outright, and equal priorities mean the last frame in
 * wins. A visualizer's job is to show what a fixture would do *and* to say the
 * rig has a conflict; merging quietly is how an evening goes into blaming the
 * wrong tool.
 *
 * @see ANSI E1.31-2018
 */

/** The port every sACN source sends to. */
const SACN_PORT = 5568;

/** ACN packet identifier, 12 bytes, the same in every E1.31 packet. */
const ACN_ID = Buffer.from([
  0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37, 0x00, 0x00, 0x00,
]);

/** Root layer vector for a data packet. */
const VECTOR_ROOT_E131_DATA = 0x00000004;
/** Framing layer vector for a data packet. */
const VECTOR_E131_DATA_PACKET = 0x00000002;
/** DMP layer vector: set property. */
const VECTOR_DMP_SET_PROPERTY = 0x02;

/**
 * Offsets into an E1.31 data packet, which is fixed-layout up to the slots.
 *
 * Named rather than counted at the call site: the framing layer alone is 77
 * bytes of fields nobody remembers, and an off-by-one here reads a priority as
 * half a universe number.
 */
const AT = {
  // Four bytes in, not at the front: the root layer opens with a preamble size
  // and a post-amble size, and only then says what protocol this is. Caught by
  // a real MadMapper stream -- a test that builds its own packets agrees with
  // whatever the parser believes, and this is what it cannot tell you.
  ACN_ID: 4,
  ROOT_VECTOR: 18,
  CID: 22,
  FRAMING_VECTOR: 40,
  SOURCE_NAME: 44,
  PRIORITY: 108,
  SYNC_ADDRESS: 109,
  SEQUENCE: 111,
  OPTIONS: 112,
  UNIVERSE: 113,
  DMP_VECTOR: 117,
  PROPERTY_VALUE_COUNT: 123,
  START_CODE: 125,
  SLOTS: 126,
};

/** Shortest packet that can carry a start code and nothing else. */
const MIN_PACKET = AT.SLOTS;

/** Options flags in the framing layer. */
const OPTION_PREVIEW = 0x80;
const OPTION_TERMINATED = 0x40;

/**
 * How far ahead of the last one a sequence number may be to count as newer.
 *
 * E1.31's rule, and it exists because the number is a byte that wraps. A
 * packet whose number is within 20 *behind* the last one is a straggler and is
 * dropped; anything else is treated as current, which is what lets a source
 * that restarted its numbering be followed rather than ignored forever.
 */
const SEQUENCE_WINDOW = 20;

class Sacn extends DmxReceiver {
  constructor() {
    super({ name: 'sacn', port: SACN_PORT });
    /** Last sequence number seen, keyed `cid/universe`. */
    this.sequences = new Map();
    /** Multicast groups currently joined, by universe. */
    this.joined = new Set();
    /** Who currently owns each universe: `{ key, name, priority, at }`. */
    this.holders = new Map();
    /** Pairings already reported as contending, so the log says it once. */
    this.contended = new Set();
    /** The interface multicast is joined on, or null for the default. */
    this.multicastInterface = null;
  }

  /**
   * The multicast address a universe arrives on.
   *
   * `239.255.<high byte>.<low byte>`, which is the whole of E1.31's addressing
   * scheme.
   *
   * @param {Number} universe sACN universe, counted from 1
   * @returns {String} dotted quad
   */
  static groupFor(universe) {
    return `239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`;
  }

  /**
   * @param {Object} socket the bound socket
   * @param {Object} opts the options `start` was given
   */
  onBound(socket, opts = {}) {
    this.multicastInterface = opts.multicastInterface || null;
    // Unicast needs nothing: a source aimed at this machine arrives on the
    // bound port whatever else is set. Multicast is joined per universe by
    // `listenTo`, because a group per universe is 386 IGMP memberships on a
    // 256 x 256 tile and switches start dropping groups well before that. The
    // show's own patch says which ones are worth joining.
    if (Array.isArray(opts.universes)) this.listenTo(opts.universes);
  }

  /**
   * Joins the multicast groups for a set of universes, and leaves the rest.
   *
   * Driven by what the show has patched rather than by a range: the set
   * changes as fixtures are added, and joining everything is both wasteful and
   * unreliable on real switches.
   *
   * @public
   * @param {Array} universes Beam universe numbers, counted from 0
   */
  listenTo(universes) {
    if (!this.socket) return;
    // Back to sACN's own numbering to build the group address.
    const wanted = new Set((universes || [])
      .map((universe) => Number(universe) + 1)
      .filter((universe) => universe >= 1 && universe <= 63999));

    wanted.forEach((universe) => {
      if (this.joined.has(universe)) return;
      try {
        this.socket.addMembership(Sacn.groupFor(universe), this.multicastInterface || undefined);
        this.joined.add(universe);
      } catch (err) {
        // A membership that will not take is worth one line, not a crash: the
        // same universe may still arrive by unicast, and on a machine with
        // several interfaces the wrong one is a configuration problem rather
        // than a fault here.
        console.warn(`[sacn] could not join ${Sacn.groupFor(universe)}: ${err.message}`);
      }
    });

    [...this.joined].forEach((universe) => {
      if (wanted.has(universe)) return;
      try {
        this.socket.dropMembership(Sacn.groupFor(universe), this.multicastInterface || undefined);
      } catch (err) {
        // Already gone, which is the outcome asked for.
      }
      this.joined.delete(universe);
    });

    console.log(`[sacn] listening to ${this.joined.size} multicast universe(s)`);
  }

  /**
   * Whether a packet's sequence number makes it newer than the last one.
   *
   * @param {String} key `cid/universe`
   * @param {Number} sequence
   * @returns {Boolean}
   */
  isCurrent(key, sequence) {
    const last = this.sequences.get(key);
    if (last === undefined) {
      this.sequences.set(key, sequence);
      return true;
    }
    // Signed difference on a byte that wraps: -1 is one behind, 255 is one
    // ahead, and both have to read that way.
    const diff = ((sequence - last + 128) & 0xff) - 128;
    if (diff <= 0 && diff > -SEQUENCE_WINDOW) return false;
    this.sequences.set(key, sequence);
    return true;
  }

  /**
   * Reads an E1.31 data packet.
   *
   * @param {Buffer} msg
   * @param {Object} rinfo sender address and port
   * @returns {Object|null} `{ universe, data, source }`
   */
  parse(msg) {
    if (msg.length < MIN_PACKET) return null;
    if (!msg.subarray(AT.ACN_ID, AT.ACN_ID + 12).equals(ACN_ID)) return null;
    if (msg.readUInt32BE(AT.ROOT_VECTOR) !== VECTOR_ROOT_E131_DATA) return null;
    // Anything else on this port is a sync or discovery packet, neither of
    // which carries slots.
    if (msg.readUInt32BE(AT.FRAMING_VECTOR) !== VECTOR_E131_DATA_PACKET) return null;
    if (msg.readUInt8(AT.DMP_VECTOR) !== VECTOR_DMP_SET_PROPERTY) return null;
    // Start code 0 is dimmer data. RDM and text packets share the wire and are
    // not ours.
    if (msg.readUInt8(AT.START_CODE) !== 0) return null;

    const options = msg.readUInt8(AT.OPTIONS);
    // A terminated stream is the source saying it has finished. The values are
    // held rather than blacked out -- a rig that goes dark looks like a fault
    // in Beam -- and the source falls stale on its own timer, which is what
    // the readout shows.
    if (options & OPTION_TERMINATED) return null;

    const universe = msg.readUInt16BE(AT.UNIVERSE);
    if (universe < 1) return null;
    const cid = msg.subarray(AT.CID, AT.CID + 16).toString('hex');
    const sequence = msg.readUInt8(AT.SEQUENCE);
    if (!this.isCurrent(`${cid}/${universe}`, sequence)) return null;

    // The count includes the start code, which is not a slot.
    const declared = msg.readUInt16BE(AT.PROPERTY_VALUE_COUNT) - 1;
    const available = msg.length - AT.SLOTS;
    const count = Math.max(0, Math.min(declared, available, DMX_LENGTH));

    const priority = msg.readUInt8(AT.PRIORITY);
    const source = {
      key: cid,
      // Null-padded to 64 bytes on the wire; the padding is not part of the name.
      name: msg.subarray(AT.SOURCE_NAME, AT.SOURCE_NAME + 64)
        .toString('utf8').replace(/\0.*$/, '').trim() || cid.slice(0, 8),
      priority,
      preview: !!(options & OPTION_PREVIEW),
    };

    if (!this.wins(universe, source)) return null;

    return {
      // E1.31 counts from 1, Beam's address space from 0.
      universe: universe - 1,
      data: msg.subarray(AT.SLOTS, AT.SLOTS + count),
      source,
    };
  }

  /**
   * Whether this source is the one to believe for this universe.
   *
   * Highest priority wins. Equal priority means the last frame in wins, which
   * is what a receiver does when it has no merge policy -- and the readout
   * names both sources so the conflict is visible rather than inferred from a
   * picture that will not sit still.
   *
   * @param {Number} universe sACN universe, counted from 1
   * @param {Object} source `{ key, name, priority }`
   * @returns {Boolean}
   */
  wins(universe, source) {
    let holder = this.holders.get(universe);
    const now = Date.now();
    // A holder that has stopped sending gives the universe up, or a source
    // that quits at priority 200 would own it until the app restarts.
    if (holder && (holder.key === source.key || now - holder.at > 2500
      || source.priority > holder.priority)) {
      holder = null;
    }
    if (holder && source.priority < holder.priority) return false;
    if (holder && holder.key !== source.key) {
      // Two live sources at one priority. Said once per pairing rather than
      // per packet, which at 40 fps would be the log and nothing else.
      const pair = `${universe}:${[holder.key, source.key].sort().join('/')}`;
      if (!this.contended.has(pair)) {
        this.contended.add(pair);
        console.warn(`[sacn] universe ${universe} has two sources at priority `
          + `${source.priority}: "${holder.name}" and "${source.name}"`);
      }
    }
    this.holders.set(universe, {
      key: source.key, name: source.name, priority: source.priority, at: now,
    });
    return true;
  }

  /**
   * Universes with more than one live source, and who they are.
   *
   * @public
   * @returns {Array} `{ universe, sources }`, universes counted from 0 as the
   *   rest of Beam counts them
   */
  conflicts() {
    const byUniverse = new Map();
    this.sources.forEach((record) => {
      record.universes.forEach((universe) => {
        if (!byUniverse.has(universe)) byUniverse.set(universe, []);
        byUniverse.get(universe).push({ name: record.name, priority: record.priority });
      });
    });
    return [...byUniverse.entries()]
      .filter(([, sources]) => sources.length > 1)
      .map(([universe, sources]) => ({ universe, sources }));
  }

  stop() {
    this.joined.clear();
    this.sequences.clear();
    this.holders.clear();
    this.contended.clear();
    super.stop();
  }
}

export default new Sacn();
export { SACN_PORT };
