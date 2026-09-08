/* eslint-disable no-bitwise */
// Tags, flags and left-aligned octets are the subject matter here: a protocol
// decoder that cannot shift and mask is not a protocol decoder.
import dgram from 'dgram';
import os from 'os';
import LaserDac from './laser_dac';

/**
 * @file Beam as an IDN (ILDA Digital Network) laser server.
 *
 * The third DAC Beam answers as, and the first one built from a published
 * standard rather than from captures: IDN-Hello (draft 2022-03-27) for
 * discovery and sessions, IDN-Stream (revision 001, July 2015) for the sample
 * data. Both are ILDA documents.
 *
 * **Why this one exists at all: it can say its own name.** The Ether Dream
 * beacon carries six numeric fields and nothing else -- there is nowhere in
 * that protocol for a string, so software calls it "Etherdream" and that is the
 * end of it. IDN answers discovery with a *host name* and answers a service map
 * with a *service name*, and consumers compose the two into what the user sees
 * (the ILDA trace notes show "IDN.93DBFB.Graphics1" -- unit ID fragment plus
 * service name). So a virtual laser can introduce itself as "Beam".
 *
 * **The sample layout is not fixed, and that is the interesting part.** Rather
 * than nailing down one X/Y/R/G/B format, IDN sends a dictionary of 16-bit tags
 * describing what each octet of a sample means, in order. A consumer builds its
 * decoder from that dictionary. So this reads the tags the producer sends
 * instead of assuming a layout -- which is the whole reason the standard can
 * carry 16-bit coordinates, six colour lines and stereoscopic pairs without a
 * version bump.
 *
 * Everything downstream is unchanged: points go into `LaserDac`'s ring, get
 * played out at the stream's own rate and reach the renderer in the same
 * six-value form the other two DACs produce.
 */

/**
 * Whether an address is the loopback interface.
 *
 * A real IDN unit has one address. Beam answers on every interface it is bound
 * to, so a producer scanning both its LAN address and loopback hears the same
 * unit twice and has to pick one -- and picking loopback for the second laser
 * is what left it listed as disconnected, pointed at an address its stream
 * never came back from. Answering only the real interface, when there is one,
 * gives each laser a single identity.
 *
 * @param {String} address
 * @returns {Boolean}
 */
function isLoopback(address) {
  return typeof address === 'string' && (address === '::1' || address.startsWith('127.'));
}

/**
 * Whether this machine has an interface a producer could reach us on.
 *
 * @returns {Boolean}
 */
function hasRealInterface() {
  return Object.values(os.networkInterfaces()).some((entries) => (entries || []).some(
    (entry) => entry && entry.family === 'IPv4' && !entry.internal,
  ));
}

/** The well-known IDN port. Servers answer on the port a request arrived on. */
const IDN_PORT = 7255;

/** IDN-Hello commands. @see IDN-Hello section 3 */
const CMD = {
  PING_REQUEST: 0x08,
  PING_RESPONSE: 0x09,
  SCAN_REQUEST: 0x10,
  SCAN_RESPONSE: 0x11,
  MAP_REQUEST: 0x12,
  MAP_RESPONSE: 0x13,
  MESSAGE: 0x40,
  MESSAGE_ACK: 0x41,
  CLOSE: 0x44,
  CLOSE_ACK: 0x45,
  ABORT: 0x46,
  ACK: 0x47,
};

/** Command, flags, and a 16 bit sequence number. */
const HELLO_HEADER_BYTES = 4;

/** Scan response: 4 header octets, a 16 octet unit ID, a 20 octet host name. */
const UNIT_ID_BYTES = 16;
const HOST_NAME_BYTES = 20;
const SCAN_RESPONSE_BYTES = 4 + UNIT_ID_BYTES + HOST_NAME_BYTES;

/** Service map: a four octet header, then fixed size entries. */
const MAP_HEADER_BYTES = 4;
const SERVICE_NAME_BYTES = 20;
const MAP_ENTRY_BYTES = 4 + SERVICE_NAME_BYTES;

/**
 * The protocol version, major in the upper nibble and minor in the lower.
 *
 * 0x01 -- major 0, minor 1 -- because that is what real hardware sends. An
 * ILDA Wireshark trace of a Microchip-based unit dissects as
 * "Protocol Version: 1", and announcing a major version no producer has heard
 * of is a good way to be discovered and then quietly treated as a stranger.
 * Claiming 1.0 was my reading of the spec's nibble rule rather than anything
 * observed.
 */
const PROTOCOL_VERSION = 0x01;

/** Status bit 0: this server offers realtime streaming through IDN-RT. */
const STATUS_REALTIME = 0x01;

/** The default service, where a show has not published its own. */
const SERVICE_ID = 1;

/** As many services as the renderer has laser tiles for. */
const MAX_SERVICES = 16;
const SERVICE_TYPE_LASER = 1;
const FLAG_DEFAULT_SERVICE = 0x01;

/** Channel message header: total size, CNL, chunk type, timestamp. */
const CHANNEL_HEADER_BYTES = 8;

/** Set in the CNL octet when a channel configuration header follows. */
const CNL_CONFIG = 0x40;

/** Channel configuration header: word count, flags, service id, service mode. */
const CONFIG_HEADER_BYTES = 4;

/**
 * Channel configuration flags (CFL).
 *
 * **IDN-Stream numbers the bits of a diagram MSB first**, so the 'Close' bit
 * drawn at position 6 is worth 0x02 and 'Routing' at position 7 is worth 0x01 --
 * the opposite way round from how the bit positions read. Taking Routing for
 * Close closed every channel the instant it was opened, and the samples that
 * followed arrived at a channel with no decoder: a stream that discovered,
 * configured and then drew absolutely nothing.
 */
const CFL_ROUTING = 0x01;
const CFL_CLOSE = 0x02;

/**
 * Service modes. @see IDN-Stream section 2.3
 *
 * Continuous is an uninterrupted sequence of samples that cannot be repeated;
 * discrete delivers whole frames that a consumer may hold and redraw.
 */
const MODE_GRAPHIC_CONTINUOUS = 0x01;
const MODE_GRAPHIC_DISCRETE = 0x02;

/** Data chunk types this server understands. @see IDN-Stream section 2.1 */
const CHUNK = {
  VOID: 0xff,
  WAVE_SAMPLES: 0x00,
  FRAME_SAMPLES: 0x01,
  FRAME_FIRST_FRAGMENT: 0x02,
};

/**
 * Both sample chunks open with a flags octet and the chunk's duration.
 *
 * Four octets, not eight. The standard's table renders the duration on a second
 * row, which reads as a 32 bit field at offset 4, but a real stream settles it:
 * MadMapper's 872 octet message leaves 840 octets after a four octet header,
 * which is exactly 120 seven-octet samples, where an eight octet header leaves
 * 836 -- not a whole number of samples at all. The duration then reads 4000
 * microseconds, and 120 samples in 4 ms is the 30 kpps the producer is sending.
 * Three numbers agreeing is worth more than my reading of a mangled table.
 */
const CHUNK_HEADER_BYTES = 4;

/** Where a rate cannot be derived from a chunk's duration. */
const DEFAULT_POINT_RATE = 30000;

/** Sanity bounds on a rate taken from a producer's own timing. */
const MIN_POINT_RATE = 1000;
const MAX_POINT_RATE = 200000;

/**
 * A locally administered unit ID, so it can never collide with real hardware.
 *
 * The first octet is the length of what follows, the second the category of
 * identifier, then the identifier itself -- the field is zero padded so that
 * IDs of different lengths still compare as binary.
 */
const DEFAULT_UNIT_ID = [0x07, 0x01, 0x00, 0x04, 0xbe, 0xa1, 0x00, 0x01];

/**
 * Turns a wavelength in nanometres into one of the three lines we render.
 *
 * IDN names a colour by its wavelength rather than by a channel index, which is
 * the honest way round -- a projector's red is 638 nm, not "channel 0". Beam
 * renders an RGB beam, so anything else (deep blue, yellow, cyan) folds into
 * the nearest of the three rather than being dropped.
 *
 * @param {Number} nm
 * @returns {String} 'r', 'g' or 'b'
 */
function lineFor(nm) {
  // The midpoints between the three standard lines (638, 532, 460 nm), so each
  // wavelength lands on whichever primary it is actually closest to.
  //
  // A six-colour projector's yellow (577) and cyan (488) collapse onto a single
  // primary rather than being mixed across two, which is a simplification: a
  // yellow line renders green here rather than red-plus-green. Worth revisiting
  // if a real six-line stream ever turns up; every ordinary RGB producer sends
  // exactly the three, where this is exact.
  if (nm >= 585) return 'r';
  if (nm >= 496) return 'g';
  return 'b';
}

/**
 * Builds a sample decoder from a channel's tag dictionary.
 *
 * Each descriptor tag owns exactly one octet of a sample, in order, and a
 * precision tag adds a further octet to the value the tag before it described.
 * Everything else -- modifiers, hints, intensity, the Z axis -- still consumes
 * its octet but contributes nothing here.
 *
 * @param {Buffer} buffer the datagram
 * @param {Number} offset where the tag words start
 * @param {Number} words how many 16 bit words the configuration holds
 * @returns {{fields: Array, size: Number}} the fields in sample order, and how
 *   many octets one sample takes
 */
function decodeTags(buffer, offset, words) {
  const fields = [];
  let previous = null;
  for (let w = 0; w < words; w += 1) {
    const at = offset + w * 2;
    if (at + 2 > buffer.length) break;
    const tag = buffer.readUInt16BE(at);
    const category = (tag >> 12) & 0xf;
    const subcategory = (tag >> 8) & 0xf;
    const id = (tag >> 4) & 0xf;
    const parameter = tag & 0xf;

    if (tag === 0) continue; // eslint-disable-line no-continue

    // Category 0 carries data words of its own; step over them.
    if (category === 0) {
      w += parameter;
      continue; // eslint-disable-line no-continue
    }
    // Category 1 configures the decoder and owns no octet.
    if (category === 1) continue; // eslint-disable-line no-continue

    if (category === 4) {
      // Precision extends the value described by the previous tag.
      if (subcategory === 0 && id === 1) {
        if (previous) previous.bytes += 1;
        continue; // eslint-disable-line no-continue
      }
      // Draw coordinates. Only the standard scanner (parameter 0) is drawn.
      if (subcategory === 2 && parameter === 0 && id < 2) {
        previous = { kind: id === 0 ? 'x' : 'y', bytes: 1, signed: true };
      } else {
        // NOP, hint, Z, or a second scan head: an octet we step over.
        previous = { kind: null, bytes: 1, signed: false };
      }
      fields.push(previous);
      continue; // eslint-disable-line no-continue
    }

    if (category === 5) {
      // Subcategories 0..3 span a 10 bit wavelength across the low bits.
      if ((tag & 0x0c00) === 0) {
        previous = { kind: lineFor(tag & 0x03ff), bytes: 1, signed: false };
      } else {
        // Intensity and the rest: an octet Beam does not render.
        previous = { kind: null, bytes: 1, signed: false };
      }
      fields.push(previous);
      continue; // eslint-disable-line no-continue
    }

    // An unknown descriptor still owns an octet; stepping over it keeps the
    // rest of the sample aligned, which is better than abandoning the frame.
    previous = { kind: null, bytes: 1, signed: false };
    fields.push(previous);
  }

  const size = fields.reduce((total, field) => total + field.bytes, 0);
  return { fields, size };
}

/**
 * Beam answering as an IDN server.
 */
class IdnDac extends LaserDac {
  /**
   * @param {Object} [options]
   * @param {String} [options.hostName] what discovery calls this unit
   * @param {String} [options.serviceName] what the service map calls the service
   * @param {Array<Number>} [options.unitID] the unit's unique identifier octets
   */
  constructor({
    name = 'Beam laser (IDN)',
    hostName = 'Beam',
    serviceName = 'Beam',
    unitID = DEFAULT_UNIT_ID,
    capacity = 1800,
    port = IDN_PORT,
    answerLoopback = undefined,
    ...rest
  } = {}) {
    super({ name, capacity, ...rest });
    this.hostName = hostName;
    this.serviceName = serviceName;
    this.unitID = Buffer.from(unitID);
    this.port = port;
    this.socket = null;
    /** Per channel decoders, since each channel carries its own dictionary. */
    this.channels = new Map();
    this.host = null;
    /**
     * One service per laser in the show, by service ID.
     *
     * IDN units offer *named services* and channel messages name the one they
     * feed, which is exactly the shape a rig wants: a producer sees "Beam high"
     * and "Beam low" in its list and routes content to each. Each service keeps
     * its own buffer and play-out clock, because two lasers can be scanned at
     * different rates and neither should be able to starve the other.
     */
    this.services = new Map();
    /**
     * Which producer endpoint feeds which laser.
     *
     * A workaround, and worth naming as one. A producer is supposed to say
     * which service it is feeding, and MadMapper always says 0 -- it never asks
     * for the service map, sends every output on channel 0, and ignores the port
     * a unit answers from. The one thing that differs between its outputs is the
     * UDP source port, so that is what a laser has to be told apart by. First
     * stream seen takes the first laser, and so on; `rotateStreams` swaps them
     * when they land the wrong way round. Ports change when the producer
     * restarts, so the pairing is per session.
     */
    this.endpoints = new Map();
    /**
     * Whether loopback scans are answered.
     *
     * Decided by what the machine has, not by which scan happens to arrive
     * first: a producer on this same machine scans both loopback and the LAN
     * address, and whichever we answer becomes an identity it remembers. Answer
     * both and one laser gets filed under 127.0.0.1, where its stream never
     * comes back from -- which is exactly how the second laser ended up listed
     * as disconnected. With a real interface present, that is the one address
     * a unit has; with none, loopback is all there is.
     */
    this.answerLoopback = answerLoopback === undefined
      ? !hasRealInterface()
      : !!answerLoopback;
    this.setServices([{ id: SERVICE_ID, name: serviceName }]);
  }

  /**
   * Publishes the services this unit offers, one per laser fixture.
   *
   * Called from the renderer whenever the patch changes, so the names a
   * producer sees are the names in the show. Existing services keep their
   * buffer and clock across a rename; ones that have gone are dropped.
   *
   * @public
   * @param {Array} list each `{ id, name }`, IDs in 1..255
   */
  setServices(list) {
    const wanted = Array.isArray(list) && list.length
      ? list
      : [{ id: SERVICE_ID, name: this.serviceName }];
    const next = new Map();
    wanted.slice(0, MAX_SERVICES).forEach(({ id, name }) => {
      const serviceId = Math.min(Math.max(Number(id) || SERVICE_ID, 1), 255);
      const label = String(name || 'Beam').slice(0, SERVICE_NAME_BYTES - 1);
      const held = this.services.get(serviceId);
      const dac = held ? held.dac : this.makeService(serviceId, label);
      dac.name = `${this.name} / ${label}`;
      next.set(serviceId, { name: label, dac });
    });
    this.services = next;
  }

  /**
   * A service's own buffer and clock.
   *
   * A plain `LaserDac` with its timers off: this server owns the flush tick and
   * drives every service from it, so they stay in step with one another and
   * with the socket.
   *
   * @param {Number} id
   * @param {String} label
   * @returns {Object} LaserDac
   */
  makeService(id, label) {
    const dac = new LaserDac({
      name: `${this.name} / ${label}`,
      capacity: this.capacity,
      now: this.now,
      timers: false,
    });
    dac.onFrames = (batch) => {
      if (this.onFrames) this.onFrames({ ...batch, service: id });
    };
    return dac;
  }

  /**
   * The service a channel message is feeding.
   *
   * A service ID of 0 means "the default service for this mode", which for a
   * unit offering one laser is simply the only one there is.
   *
   * @param {Number} serviceId
   * @returns {Object|null} LaserDac
   */
  serviceDac(serviceId, channelId = 0, endpoint = null) {
    // A producer that names its service is believed without question.
    const named = this.services.get(serviceId);
    if (named) return named.dac;

    const ids = [...this.services.keys()];
    if (!ids.length) return null;

    // Otherwise the source endpoint stands in for the name. See `endpoints`.
    if (endpoint) {
      let assigned = this.endpoints.get(endpoint);
      if (assigned === undefined) {
        const taken = new Set(this.endpoints.values());
        assigned = ids.find((id) => !taken.has(id));
        if (assigned === undefined) [assigned] = ids;
        this.endpoints.set(endpoint, assigned);
        const held = this.services.get(assigned);
        console.log(`[${this.name}] ${endpoint} feeds ${held ? held.name : assigned}`);
      }
      const held = this.services.get(assigned);
      if (held) return held.dac;
    }

    // Nothing to go on: the channel, then the first laser.
    const list = [...this.services.values()];
    return (list[channelId] || list[0]).dac;
  }

  /**
   * Moves every stream on to the next laser.
   *
   * The pairing of producer output to laser is first-come, which is arbitrary:
   * whichever output happens to send first takes the first laser. When they
   * land the wrong way round this rotates them, which for the usual two lasers
   * is simply a swap.
   *
   * @public
   */
  rotateStreams() {
    const ids = [...this.services.keys()];
    if (ids.length < 2 || !this.endpoints.size) return;
    this.endpoints.forEach((id, endpoint) => {
      const at = ids.indexOf(id);
      const next = ids[(at + 1) % ids.length];
      this.endpoints.set(endpoint, next);
    });
    // Whatever each laser was mid-figure is no longer its own.
    this.services.forEach(({ dac }) => dac.clear());
    const summary = [...this.endpoints.entries()]
      .map(([endpoint, id]) => `${endpoint}->${(this.services.get(id) || {}).name}`)
      .join(', ');
    console.log(`[${this.name}] streams rotated: ${summary}`);
  }

  /** Drives every service's clock from the one flush tick. */
  tick() {
    this.services.forEach(({ dac }) => dac.tick());
  }

  /**
   * Binds the IDN port.
   *
   * `reuseAddr` so a restart during development does not have to wait out the
   * socket, and so a second Beam on another address of the same machine can
   * listen too.
   *
   * @param {Object} [opts]
   * @returns {Promise<void>}
   */
  open({ bind } = {}) {
    this.bindAddress = bind;
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.socket = socket;
      let settled = false;

      socket.on('error', (err) => {
        if (!settled) {
          settled = true;
          this.socket = null;
          reject(err);
          return;
        }
        console.error(`[${this.name}] socket error:`, err.message);
      });

      socket.on('message', (msg, rinfo) => this.receive(msg, rinfo));

      socket.bind(this.port, bind, () => {
        settled = true;
        console.log(`[${this.name}] listening on ${bind || '0.0.0.0'}:${this.port} as "${this.hostName}"`);
        resolve();
      });
    });
  }

  /** Closes the socket. */
  close() {
    this.channels.clear();
    this.services.forEach((held) => {
      held.dac.clear();
      held.dac.pause();
    });
    if (this.socket) {
      try {
        this.socket.close();
      } catch (err) {
        // Already closed; nothing to do.
      }
    }
    this.socket = null;
    this.host = null;
  }

  /**
   * Handles one datagram.
   *
   * @param {Buffer} msg
   * @param {Object} rinfo
   */
  receive(msg, rinfo) {
    if (msg.length < HELLO_HEADER_BYTES) return;
    const command = msg.readUInt8(0);
    const sequence = msg.readUInt16BE(2);
    switch (command) {
      case CMD.PING_REQUEST:
        this.reply(CMD.PING_RESPONSE, sequence, null, rinfo);
        break;
      case CMD.SCAN_REQUEST:
        // One identity per laser: see `isLoopback`. Loopback is only ignored
        // once a producer has actually found us on a real interface -- on a
        // machine with no network, or before anything has scanned, loopback is
        // all there is and answering it beats being invisible.
        if (isLoopback(rinfo.address) && !this.answerLoopback) break;
        this.noteHost(rinfo);
        // One answer per laser, each its own unit.
        //
        // A producer that reads service maps would see a single unit offering
        // named services, which is the tidier model and what the standard is
        // built around. MadMapper never asks for the map -- measured: not one
        // request against seventy-three scans -- so to it a unit *is* a
        // destination, and a rig of two lasers has to look like two units or
        // only the first can ever be driven.
        // Each laser answers from its own port, so the producer learns a
        // separate endpoint for each and its streams arrive already sorted.
        this.services.forEach((service, id) => {
          this.reply(CMD.SCAN_RESPONSE, sequence, this.scanResponse(id, service.name), rinfo);
        });
        break;
      case CMD.MAP_REQUEST:
        if (!this.mapAsked) {
          this.mapAsked = true;
          console.log(`[${this.name}] ${rinfo.address} asked for the service map`);
        }
        this.reply(CMD.MAP_RESPONSE, sequence, this.serviceMap(), rinfo);
        break;
      case CMD.MESSAGE:
      case CMD.MESSAGE_ACK:
        this.channelMessage(msg, rinfo);
        if (command === CMD.MESSAGE_ACK) this.reply(CMD.ACK, sequence, null, rinfo);
        break;
      case CMD.CLOSE:
      case CMD.CLOSE_ACK:
      case CMD.ABORT:
        this.channels.clear();
        this.pause();
        if (command === CMD.CLOSE_ACK) this.reply(CMD.ACK, sequence, null, rinfo);
        break;
      default:
        break;
    }
  }

  /** Logs the first host to find us, the way the other DACs do. */
  noteHost(rinfo) {
    if (this.host === rinfo.address) return;
    this.host = rinfo.address;
    console.log(`[${this.name}] ${rinfo.address} scanned for units`);
  }

  /**
   * Sends a reply with an IDN-Hello header.
   *
   * @param {Number} command
   * @param {Number} sequence echoed from the request
   * @param {Buffer|null} payload
   * @param {Object} rinfo where the request came from
   */
  reply(command, sequence, payload, rinfo) {
    if (!this.socket) return;
    const header = Buffer.alloc(HELLO_HEADER_BYTES);
    header.writeUInt8(command, 0);
    header.writeUInt8(0, 1);
    header.writeUInt16BE(sequence, 2);
    const packet = payload ? Buffer.concat([header, payload]) : header;
    this.socket.send(packet, rinfo.port, rinfo.address, (err) => {
      if (err) console.error(`[${this.name}] reply to ${rinfo.address} failed:`, err.message);
    });
  }

  /**
   * The scan response body: who this unit is, and what it is called.
   *
   * @returns {Buffer}
   */
  scanResponse(serviceId, name) {
    const body = Buffer.alloc(SCAN_RESPONSE_BYTES);
    body.writeUInt8(SCAN_RESPONSE_BYTES, 0);
    body.writeUInt8(PROTOCOL_VERSION, 1);
    body.writeUInt8(STATUS_REALTIME, 2);
    body.writeUInt8(0, 3);
    this.unitID.copy(body, 4, 0, Math.min(this.unitID.length, UNIT_ID_BYTES));
    // The last identifier octet distinguishes one laser from the next, so each
    // answers as a unit with an identity of its own rather than all of them
    // claiming to be the same device.
    body.writeUInt8(serviceId, 4 + this.unitID.length - 1);
    body.write(String(name).slice(0, HOST_NAME_BYTES - 1), 4 + UNIT_ID_BYTES, 'ascii');
    return body;
  }

  /**
   * The service map: one laser projector service, named.
   *
   * No relays -- Beam is the unit, not a bridge to others -- so the relay table
   * is empty and the service table holds a single root entry.
   *
   * @returns {Buffer}
   */
  serviceMap() {
    const entries = [...this.services.entries()];
    const body = Buffer.alloc(MAP_HEADER_BYTES + entries.length * MAP_ENTRY_BYTES);
    body.writeUInt8(MAP_HEADER_BYTES, 0);
    body.writeUInt8(MAP_ENTRY_BYTES, 1);
    body.writeUInt8(0, 2); // relay count: this unit bridges to nothing
    body.writeUInt8(entries.length, 3);

    entries.forEach(([id, service], i) => {
      const at = MAP_HEADER_BYTES + i * MAP_ENTRY_BYTES;
      body.writeUInt8(id, at);
      body.writeUInt8(SERVICE_TYPE_LASER, at + 1);
      // Only the first is marked default: one default per service type.
      body.writeUInt8(i === 0 ? FLAG_DEFAULT_SERVICE : 0, at + 2);
      body.writeUInt8(0, at + 3); // a root service, behind no relay
      body.write(service.name, at + 4, 'ascii');
    });
    return body;
  }

  /**
   * Handles a realtime channel message: configuration, data, or both.
   *
   * @param {Buffer} msg
   */
  channelMessage(msg, rinfo) {
    let at = HELLO_HEADER_BYTES;
    if (msg.length < at + CHANNEL_HEADER_BYTES) return;

    let closing = false;
    const totalSize = msg.readUInt16BE(at);
    const cnl = msg.readUInt8(at + 2);
    const chunkType = msg.readUInt8(at + 3);
    const channelId = cnl & 0x3f;
    const end = Math.min(msg.length, at + totalSize);
    at += CHANNEL_HEADER_BYTES;

    // A channel carries its own dictionary, and it is resent periodically for
    // recovery rather than only when the channel opens.
    if (cnl & CNL_CONFIG) {
      if (at + CONFIG_HEADER_BYTES > end) return;
      const words = msg.readUInt8(at) * 2; // 32 bit words hold two tags each
      const flags = msg.readUInt8(at + 1);
      at += CONFIG_HEADER_BYTES;
      const serviceId = msg.readUInt8(at - CONFIG_HEADER_BYTES + 2);
      const serviceMode = msg.readUInt8(at - CONFIG_HEADER_BYTES + 3);
      if (words > 0) {
        const decoder = decodeTags(msg, at, words);
        if (decoder.size > 0) {
          this.channels.set(channelId, { ...decoder, serviceMode, serviceId });
        }
        at += words * 2;
      }
      // Close means this channel is done *once the message has been
      // processed* -- its own samples still draw. Routing (the other way round
      // from how the diagram's bits read) means open it, which is the usual
      // case and needs nothing done here. It is entirely valid to open, draw
      // and close in a single message.
      closing = (flags & CFL_CLOSE) !== 0;
    }

    const decoder = this.channels.get(channelId);
    if (decoder
      && (chunkType === CHUNK.WAVE_SAMPLES
        || chunkType === CHUNK.FRAME_SAMPLES
        || chunkType === CHUNK.FRAME_FIRST_FRAGMENT)) {
      const from = rinfo ? `${rinfo.address}:${rinfo.port}` : null;
      const dac = this.serviceDac(decoder.serviceId, channelId, from);
      if (dac) this.samples(msg, at, end, decoder, chunkType, dac);
    }
    if (closing) this.channels.delete(channelId);
  }

  /**
   * Decodes a sample array into the ring, and takes the rate from its duration.
   *
   * @param {Buffer} msg
   * @param {Number} at where the chunk header starts
   * @param {Number} end one past the last octet of the message
   * @param {Object} decoder the channel's sample decoder
   * @param {Number} chunkType
   */
  // eslint-disable-next-line class-methods-use-this
  samples(msg, at, end, decoder, chunkType, dac) {
    if (at + CHUNK_HEADER_BYTES > end) return;
    // The low three octets of the header. Every stream seen so far leaves the
    // octet after the flags at zero, so a 16 bit duration at offset 2 would
    // read the same; taking 24 bits is the superset and copes with a frame
    // slower than 65 ms, which a 16 bit field could not express.
    const duration = msg.readUIntBE(at + 1, 3);
    let offset = at + CHUNK_HEADER_BYTES;
    const { fields, size } = decoder;
    const count = Math.floor((end - offset) / size);
    if (count < 1) return;

    // The producer's own timing, rather than a number we invent: a frame that
    // says it lasts 20 ms and carries 600 samples was scanned at 30 kpps.
    if (duration > 0 && count > 1) {
      const rate = Math.round(((count - 1) * 1e6) / duration);
      // Out of band means the duration was not what we think it is. Keeping the
      // rate we had beats pegging the clock to the end of its range, which is
      // how a misread field turns into a buffer that overflows for ever.
      if (rate >= MIN_POINT_RATE && rate <= MAX_POINT_RATE) {
        if (rate !== dac.pointRate) dac.play(rate);
      } else if (!dac.playing) {
        dac.play(dac.pointRate || DEFAULT_POINT_RATE);
      }
    } else if (!dac.playing) {
      dac.play(DEFAULT_POINT_RATE);
    }
    if (!dac.playing) dac.play(dac.pointRate || DEFAULT_POINT_RATE);

    // Blank the leading sample only for a genuinely discrete frame.
    //
    // The standard's "the first sample ... SHALL be invisible" is about a frame
    // that stands on its own: it is where the draw cursor is moved before the
    // shape starts. MadMapper declares continuous mode but still sends frame
    // chunks, and in continuous mode each message is simply the next slice of
    // an unbroken stream -- blanking its first sample punched a dark point
    // every 120, which reads as a figure flickering with gaps. A compliant
    // producer sends that start point dark anyway, so nothing is lost by
    // trusting it here.
    const frame = chunkType !== CHUNK.WAVE_SAMPLES
      && decoder.serviceMode === MODE_GRAPHIC_DISCRETE;
    for (let s = 0; s < count; s += 1) {
      let x = 0;
      let y = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      let cursor = offset;
      for (let f = 0; f < fields.length; f += 1) {
        const field = fields[f];
        // Octets are left aligned: the first is the most significant, so a
        // single octet is the top half of a 16 bit value.
        let value = 0;
        for (let k = 0; k < field.bytes; k += 1) {
          value = (value << 8) | msg.readUInt8(cursor + k);
        }
        if (field.bytes < 2) {
          // Widening one octet to sixteen bits. A coordinate is left aligned
          // and keeps its sign, but a colour of 255 means *full* output, and
          // left aligning alone would make it 0xFF00 -- a hair under full,
          // forever. Replicating the octet maps 0 to 0 and 255 to 0xFFFF.
          value = field.signed ? (value << 8) : ((value << 8) | value);
        }
        value &= 0xffff;
        switch (field.kind) {
          case 'x': x = value; break;
          case 'y': y = value; break;
          case 'r': r = value; break;
          case 'g': g = value; break;
          case 'b': b = value; break;
          default: break;
        }
        cursor += field.bytes;
      }
      // "The first sample is interpreted as the start point of the shape and
      // SHALL be invisible" -- it moves the draw cursor. Honouring that keeps a
      // stray lit segment from the previous figure's end to this one's start.
      if (frame && s === 0) {
        dac.push(x, y, 0, 0, 0, 0);
      } else {
        dac.push(x, y, r, g, b, Math.max(r, g, b));
      }
      offset += size;
    }
  }

  /**
   * @public
   * @returns {Object} what the renderer shows about this DAC
   */
  report() {
    return {
      ...super.report(),
      protocol: 'idn',
      hostName: this.hostName,
      host: this.host,
      services: [...this.services.entries()].map(([id, service]) => ({
        id,
        name: service.name,
        rate: service.dac.pointRate,
        held: service.dac.count,
      })),
    };
  }
}

export {
  decodeTags, CMD, IDN_PORT, CFL_ROUTING, CFL_CLOSE,
  MODE_GRAPHIC_CONTINUOUS, MODE_GRAPHIC_DISCRETE,
};
export default IdnDac;
