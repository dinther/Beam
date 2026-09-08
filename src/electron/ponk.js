/* eslint-disable no-console */
/**
 * @file Ponk receiver: MadMapper's own way of handing a laser picture to
 * another program, one named stream per laser output.
 *
 * Ponk ("Pathes Over NetworK", madmappersoftware/Ponk) is what the DACs could
 * never be: a stream that says which laser it is. Every packet carries a
 * 32-bit sender identifier that survives a project reload and a display name
 * -- MadLaser sends "MadMapper-<output name>" -- so a rig of six lasers is six
 * streams a fixture can pick by name, with no port guessing and no arrival
 * order. "Publish to PONK" is a toggle beside an output's Destination, so the
 * real laser keeps its DAC stream and Beam gets a named copy.
 *
 * **What the stream is, measured 2026-09-09 rather than read.** It is
 * MadMapper's render thread publishing each output's vectorised content at the
 * app's own 60 Hz: one path per surface per frame, points at a fixed density
 * in canvas pixels (about 1.3 px apart, so 0.0025 in the -1..1 field at 1024),
 * a colour per point, and the output's masks, flip and bounds clipping already
 * applied. It is *upstream* of the ILDA rasteriser -- point rate and desired
 * frame rate change nothing here -- so there are no dwell repeats, no corner
 * dwell and no blanking travel in it. The renderer models those itself; see
 * `plugins/visualizer/laser_dwell.js`.
 *
 * Wire format from `Common/Cpp/PonkDefs.h`, everything little-endian and
 * packed:
 *
 *   header, 52 octets:
 *     char[8]  "PONK-UDP"
 *     u8       protocol version, 0
 *     u32      sender identifier
 *     char[32] sender name, UTF-8, null terminated
 *     u8       frame number, +1 per frame, wraps
 *     u8       chunk count
 *     u8       chunk number
 *     u32      CRC: the plain sum of every data octet in the frame, all chunks
 *   data, once the chunks are joined:
 *     u8       data format
 *     per path:
 *       u8     meta count
 *       per meta: char[8] key, f32 value
 *       u16    point count
 *       points: format 0 = x,y,r,g,b as u16; format 1 = x,y as f32, r,g,b as u8
 *
 * The CRC rule is stated loosely in the spec ("sum of all data") and was
 * pinned against the live stream: a byte sum modulo 2^32 matched twenty of
 * twenty frames, a 32-bit word sum and a 16-bit sum none. A frame whose sum
 * disagrees is dropped, which is what the field is for.
 *
 * Receive only, like the DACs. Multicast by default, which is what lets
 * MadMapper's own preview and Beam both hear the same stream.
 */
import dgram from 'dgram';
import os from 'os';

/** The group and port MadMapper publishes to, from `PonkDefs.h`. */
export const PONK_GROUP = '239.255.10.24';
export const PONK_PORT = 5583;

export const HEADER_BYTES = 52;
const MAGIC = 'PONK-UDP';
const PROTOCOL_VERSION = 0;

/** Data formats. Only these two exist; a receiver must at least read format 1. */
export const FORMAT_XYRGB_U16 = 0;
export const FORMAT_XY_F32_RGB_U8 = 1;
const POINT_BYTES = { [FORMAT_XYRGB_U16]: 10, [FORMAT_XY_F32_RGB_U8]: 11 };

/**
 * How long a sender may go quiet before it is dropped from the list, in ms.
 *
 * A stream stops when its output is switched off or MadMapper closes; the
 * name should not linger in a dropdown for an hour after. Long enough to ride
 * out a stalled frame.
 */
export const SENDER_TIMEOUT_MS = 2000;

/**
 * Splits a frame's joined data into paths.
 *
 * Coordinates come back as they were sent -- format 1 in the -1..1 field as
 * floats, format 0 as unsigned 16-bit with 32768 the centre -- normalised here
 * to floats so the renderer sees one kind of point. Colours are 0..255.
 *
 * @public
 * @param {Buffer} data every chunk of one frame, in order
 * @returns {{ format: Number, paths: Array }|null} each path
 *   `{ count, xy: Float32Array, rgb: Uint8Array, meta: Object }`; null for a
 *   format this reader does not know or a truncated frame
 */
export function decodeFrame(data) {
  if (!data || data.length < 1) return null;
  const format = data.readUInt8(0);
  const stride = POINT_BYTES[format];
  if (!stride) return null;
  const paths = [];
  let at = 1;
  while (at < data.length) {
    if (at + 1 > data.length) return null;
    const metaCount = data.readUInt8(at);
    at += 1;
    const meta = {};
    for (let i = 0; i < metaCount; i += 1) {
      if (at + 12 > data.length) return null;
      const key = data.toString('ascii', at, at + 8).replace(/\0+$/, '');
      meta[key] = data.readFloatLE(at + 8);
      at += 12;
    }
    if (at + 2 > data.length) return null;
    const count = data.readUInt16LE(at);
    at += 2;
    if (at + count * stride > data.length) return null;
    const xy = new Float32Array(count * 2);
    const rgb = new Uint8Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      if (format === FORMAT_XY_F32_RGB_U8) {
        xy[i * 2] = data.readFloatLE(at);
        xy[i * 2 + 1] = data.readFloatLE(at + 4);
        rgb[i * 3] = data[at + 8];
        rgb[i * 3 + 1] = data[at + 9];
        rgb[i * 3 + 2] = data[at + 10];
      } else {
        xy[i * 2] = (data.readUInt16LE(at) - 32768) / 32768;
        xy[i * 2 + 1] = (data.readUInt16LE(at + 2) - 32768) / 32768;
        // 16-bit colour down to 8: the high byte, which is what a laser diode
        // can actually resolve.
        rgb[i * 3] = data.readUInt16LE(at + 4) >> 8; // eslint-disable-line no-bitwise
        rgb[i * 3 + 1] = data.readUInt16LE(at + 6) >> 8; // eslint-disable-line no-bitwise
        rgb[i * 3 + 2] = data.readUInt16LE(at + 8) >> 8; // eslint-disable-line no-bitwise
      }
      at += stride;
    }
    paths.push({
      count, xy, rgb, meta,
    });
  }
  return { format, paths };
}

/**
 * The frame checksum as MadMapper computes it: every data octet summed.
 *
 * @public
 * @param {Buffer} data the joined chunks
 * @returns {Number} unsigned 32-bit
 */
export function frameCrc(data) {
  let sum = 0;
  // eslint-disable-next-line no-bitwise
  for (let i = 0; i < data.length; i += 1) sum = (sum + data[i]) >>> 0;
  return sum;
}

/**
 * Reads one packet's header.
 *
 * @public
 * @param {Buffer} msg
 * @returns {Object|null} `{ version, sender, name, frame, chunkCount,
 *   chunkNumber, crc, data }` or null if this is not a Ponk packet
 */
export function readHeader(msg) {
  if (!msg || msg.length < HEADER_BYTES || msg.toString('ascii', 0, 8) !== MAGIC) return null;
  return {
    version: msg.readUInt8(8),
    sender: msg.readUInt32LE(9),
    name: msg.toString('utf8', 13, 45).replace(/\0[\s\S]*$/, ''),
    frame: msg.readUInt8(45),
    chunkCount: msg.readUInt8(46),
    chunkNumber: msg.readUInt8(47),
    crc: msg.readUInt32LE(48),
    data: msg.subarray(HEADER_BYTES),
  };
}

/**
 * Builds the packets for one frame, the way a sender would.
 *
 * Here so a test can feed the receiver real bytes, and so the layout the
 * decoder reads is pinned by the layout something else writes.
 *
 * @public
 * @param {Object} frame `{ sender, name, frame, format, paths }`, paths as
 *   `{ xy: number[], rgb: number[], meta?: Object }`
 * @param {Number} [chunkBytes] data octets per packet
 * @returns {Buffer[]}
 */
export function encodeFrame(frame, chunkBytes = 1472) {
  const {
    sender, name, frame: frameNumber, format = FORMAT_XY_F32_RGB_U8, paths,
  } = frame;
  const parts = [Buffer.from([format])];
  paths.forEach((path) => {
    const meta = Object.entries(path.meta || {});
    const count = Math.floor(path.xy.length / 2);
    const head = Buffer.alloc(1 + meta.length * 12 + 2);
    head.writeUInt8(meta.length, 0);
    meta.forEach(([key, value], i) => {
      head.write(key.padEnd(8, '\0').slice(0, 8), 1 + i * 12, 'ascii');
      head.writeFloatLE(value, 1 + i * 12 + 8);
    });
    head.writeUInt16LE(count, 1 + meta.length * 12);
    const stride = POINT_BYTES[format];
    const body = Buffer.alloc(count * stride);
    for (let i = 0; i < count; i += 1) {
      const at = i * stride;
      if (format === FORMAT_XY_F32_RGB_U8) {
        body.writeFloatLE(path.xy[i * 2], at);
        body.writeFloatLE(path.xy[i * 2 + 1], at + 4);
        body[at + 8] = path.rgb[i * 3];
        body[at + 9] = path.rgb[i * 3 + 1];
        body[at + 10] = path.rgb[i * 3 + 2];
      } else {
        const u16 = (v) => Math.max(0, Math.min(65535, Math.round(v * 32767 + 32768)));
        body.writeUInt16LE(u16(path.xy[i * 2]), at);
        body.writeUInt16LE(u16(path.xy[i * 2 + 1]), at + 2);
        body.writeUInt16LE(path.rgb[i * 3] * 257, at + 4);
        body.writeUInt16LE(path.rgb[i * 3 + 1] * 257, at + 6);
        body.writeUInt16LE(path.rgb[i * 3 + 2] * 257, at + 8);
      }
    }
    parts.push(head, body);
  });
  const data = Buffer.concat(parts);
  const crc = frameCrc(data);
  const chunkCount = Math.max(1, Math.ceil(data.length / chunkBytes));
  const packets = [];
  for (let c = 0; c < chunkCount; c += 1) {
    const header = Buffer.alloc(HEADER_BYTES);
    header.write(MAGIC, 0, 'ascii');
    header.writeUInt8(PROTOCOL_VERSION, 8);
    header.writeUInt32LE(sender >>> 0, 9); // eslint-disable-line no-bitwise
    header.write(String(name).slice(0, 31), 13, 'utf8');
    header.writeUInt8(frameNumber & 0xff, 45); // eslint-disable-line no-bitwise
    header.writeUInt8(chunkCount, 46);
    header.writeUInt8(c, 47);
    header.writeUInt32LE(crc, 48);
    packets.push(Buffer.concat([header, data.subarray(c * chunkBytes, (c + 1) * chunkBytes)]));
  }
  return packets;
}

/**
 * Joins chunks into frames and decodes them, one sender at a time.
 *
 * Kept apart from the socket so it can be driven with buffers. A frame is
 * complete when every chunk has arrived; a newer frame from the same sender
 * abandons an older incomplete one, since a late chunk is worth nothing once
 * the next picture is in.
 */
export class PonkAssembler {
  /**
   * @param {(frame: Object) => void} onFrame called with
   *   `{ sender, name, frame, format, paths }`
   */
  constructor(onFrame) {
    this.onFrame = onFrame;
    /** sender id -> { frame, count, parts: Map(chunkNumber -> Buffer) } */
    this.pending = new Map();
    this.badCrc = 0;
    this.badFormat = 0;
  }

  /**
   * Takes one packet.
   *
   * @public
   * @param {Buffer} msg
   * @returns {Boolean} whether it was a Ponk packet at all
   */
  push(msg) {
    const h = readHeader(msg);
    if (!h) return false;
    if (h.version !== PROTOCOL_VERSION) return true;
    let p = this.pending.get(h.sender);
    if (!p || p.frame !== h.frame) {
      p = { frame: h.frame, count: h.chunkCount, parts: new Map() };
      this.pending.set(h.sender, p);
    }
    p.parts.set(h.chunkNumber, h.data);
    if (p.parts.size < p.count) return true;
    this.pending.delete(h.sender);
    const ordered = [...p.parts.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
    const data = Buffer.concat(ordered);
    if (frameCrc(data) !== h.crc) {
      this.badCrc += 1;
      return true;
    }
    const decoded = decodeFrame(data);
    if (!decoded) {
      this.badFormat += 1;
      return true;
    }
    this.onFrame({
      sender: h.sender, name: h.name, frame: h.frame, format: decoded.format, paths: decoded.paths,
    });
    return true;
  }
}

/**
 * The receiver the main process runs beside the DACs.
 *
 * Same shape as a `LaserDac` from the outside -- `start(onFrames)`, `stop()`,
 * `listening`, `report()` -- so `setupLaser` treats it as one more protocol.
 * What it hands the renderer is not points but frames of paths, under
 * `protocol: 'ponk'`, and `LaserStream` knows the difference.
 */
class PonkReceiver {
  /**
   * @param {Object} [options]
   * @param {Number} [options.port] the tests bind an ephemeral one
   * @param {String} [options.group] multicast group to join
   * @param {() => Number} [options.now]
   */
  constructor({ port = PONK_PORT, group = PONK_GROUP, now = () => Date.now() } = {}) {
    this.name = 'Ponk';
    this.port = port;
    this.group = group;
    this.now = now;
    this.socket = null;
    this.onFrames = null;
    this.listening = false;
    /** sender id -> { name, frames, lastSeen, from } */
    this.senders = new Map();
    this.lastLog = 0;
    this.assembler = new PonkAssembler((frame) => this.deliver(frame));
  }

  /**
   * Binds the port and joins the group on every interface.
   *
   * MadMapper on this same machine sends through whichever interface routes
   * the group; joining on all of them, loopback included, hears it wherever
   * it goes. A join that fails on one interface is not an error -- a virtual
   * adapter with no multicast is normal -- so it is noted and skipped.
   *
   * @public
   * @param {(frame: Object) => void} onFrames
   * @returns {Promise<void>}
   */
  start(onFrames) {
    this.onFrames = onFrames;
    if (this.socket) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      socket.on('error', (err) => {
        console.error(`[${this.name}] socket error:`, err.message);
        if (!this.listening) reject(err);
      });
      socket.on('message', (msg, rinfo) => this.receive(msg, rinfo));
      socket.bind(this.port, () => {
        const joined = [];
        Object.values(os.networkInterfaces()).flat()
          .filter((i) => i && i.family === 'IPv4')
          .forEach((i) => {
            try {
              socket.addMembership(this.group, i.address);
              joined.push(i.address);
            } catch (err) { /* an interface that cannot multicast */ }
          });
        this.socket = socket;
        this.listening = true;
        console.log(`[${this.name}] listening on :${this.port}, group ${this.group} via ${joined.join(', ') || 'no interface'}`);
        resolve();
      });
    });
  }

  /** @public */
  stop() {
    if (this.socket) {
      try { this.socket.close(); } catch (err) { /* already closed */ }
      this.socket = null;
    }
    this.listening = false;
    this.senders.clear();
  }

  /**
   * One datagram in.
   *
   * @param {Buffer} msg
   * @param {Object} [rinfo]
   */
  receive(msg, rinfo = null) {
    const h = readHeader(msg);
    if (!h) return;
    let s = this.senders.get(h.sender);
    if (!s) {
      s = {
        name: h.name, frames: 0, lastSeen: 0, from: rinfo ? rinfo.address : null,
      };
      this.senders.set(h.sender, s);
      console.log(`[${this.name}] new stream 0x${h.sender.toString(16)} "${h.name}"`
        + ` from ${s.from || '?'}`);
    } else if (s.name !== h.name) {
      // The identifier is the stream; the name is only what it is called.
      console.log(`[${this.name}] stream 0x${h.sender.toString(16)} renamed "${s.name}" -> "${h.name}"`);
      s.name = h.name;
    }
    s.lastSeen = this.now();
    this.assembler.push(msg);
  }

  /**
   * A complete frame out to the renderer.
   *
   * @param {Object} frame
   */
  deliver(frame) {
    const s = this.senders.get(frame.sender);
    if (s) s.frames += 1;
    if (this.onFrames) {
      this.onFrames({
        protocol: 'ponk',
        service: frame.sender,
        name: frame.name,
        format: frame.format,
        paths: frame.paths,
      });
    }
  }

  /**
   * Streams heard recently, for a dropdown.
   *
   * @public
   * @returns {Array} each `{ id, name, live }`
   */
  streams() {
    const t = this.now();
    return [...this.senders.entries()].map(([id, s]) => ({
      id, name: s.name, live: t - s.lastSeen <= SENDER_TIMEOUT_MS, frames: s.frames,
    }));
  }

  /**
   * What the readout shows.
   *
   * @public
   * @returns {Object}
   */
  report() {
    return {
      name: this.name,
      protocol: 'ponk',
      listening: this.listening,
      port: this.port,
      group: this.group,
      streams: this.streams(),
      badCrc: this.assembler.badCrc,
      badFormat: this.assembler.badFormat,
    };
  }
}

export default PonkReceiver;
