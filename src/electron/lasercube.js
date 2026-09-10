/* eslint-disable no-console */
/* eslint-disable no-bitwise */
// Bit twiddling is the subject matter here: a cube packet is fields packed
// into bytes, and spelling that as arithmetic would obscure the one thing a
// reader needs to check it against, which is the host library's own decoder.
import dgram from 'dgram';
import os from 'os';
import LaserDac, { POINT_STRIDE, claimPorts } from './laser_dac';

export { POINT_STRIDE };

/**
 * A virtual Wicked Lasers LaserCube (main process).
 *
 * LaserOS speaks to nothing but LaserCubes, so the only way for it to drive
 * Beam is for Beam to answer as one. The protocol is unpublished; what is
 * here is read off the host side of it -- `LaserDockNetworkDevice.cpp` in
 * Wicked Lasers' own open-source `libLaserdockCore`, which is what LaserOS is
 * built on -- so the byte layouts are the ones the real host decodes, not a
 * reading of anyone's notes. What the host *sends* first, and what it checks
 * in the answers, is exactly as that file does it. Whether the shipped
 * LaserOS adds checks the open source does not is settled by pointing it at
 * this, not by reasoning.
 *
 * Three UDP ports, all fixed, all on the device:
 *
 * - 45456 takes an "alive" ping and answers it; the host broadcasts one on
 *   every interface every few seconds and adds any address that answers.
 * - 45457 takes commands and answers each with `[cmd, result, payload...]`,
 *   result 0 meaning success.
 * - 45458 takes point data and, when asked to, answers each datagram with
 *   how much buffer is left.
 *
 * So unlike an Ether Dream this never broadcasts: the host asks and the cube
 * answers. Two things follow from the fixed ports and the host binding the
 * same three numbers itself: a machine can be one LaserCube per address, and
 * **LaserOS and a virtual cube cannot share a machine** -- whichever binds
 * first holds the ports and the other cannot listen at all. LaserOS on a
 * phone, a tablet or a second machine is the arrangement this works in.
 *
 * **Authentication.** After the full-info reply the host sends a security
 * request meant for a crypto chip on the cube, then fetches the response. In
 * the open-source manager any response passes -- the verifier is a hook, and
 * with none installed the device is "authenticated OK" unconditionally.
 * This answers with zeros. If the shipped LaserOS verifies, that is where a
 * virtual cube ends, and the answer is not to replay a key.
 *
 * Everything after the parse is `LaserDac`'s and shared with the Ether Dream.
 *
 * @see https://github.com/Wickedlasers/libLaserdockCore
 */

/** Port that takes alive pings. */
export const LASERCUBE_ALIVE_PORT = 45456;
/** Port that takes commands. */
export const LASERCUBE_CMD_PORT = 45457;
/** Port that takes point data. */
export const LASERCUBE_DATA_PORT = 45458;

/**
 * Points the buffer holds. What a real cube reports.
 *
 * The host predicts drain at 30 points a millisecond and keeps up to ~1000
 * points of lead in the buffer for a 1/30 s latency, so the size mostly
 * governs how far ahead it is allowed to get.
 */
export const BUFFER_CAPACITY = 6000;

/**
 * Highest point rate accepted and the rate before the host sets one. What a
 * Cube2 Ultra reports.
 */
export const MAX_POINT_RATE = 35000;

/** Galvo range of the DAC, twelve bits. The host scales its output by it. */
const MAX_DAC_VALUE = 0x0fff;

/** Bytes per point on the wire: x, y, r, g, b as little-endian uint16. */
const POINT_BYTES = 10;
/** Bytes before the points in a data datagram: id, zero, message, frame. */
const DATA_HEADER = 4;
/** Length of the full-info reply. The host takes exactly this and no other. */
const INFO_BYTES = 64;
/** Longest model name the info reply carries, including its terminator. */
const MODEL_NAME_BYTES = 25;

/** Command bytes, from the host library's `cmds` namespace. */
const CMD = {
  GET_ALIVE: 0x27,
  GET_FULL_INFO: 0x77,
  ENABLE_BUFFER_SIZE_RESPONSE_ON_DATA: 0x78,
  SET_OUTPUT: 0x80,
  SET_ILDA_RATE: 0x82,
  GET_RINGBUFFER_EMPTY_SAMPLE_COUNT: 0x8a,
  CLEAR_RINGBUFFER: 0x8d,
  SET_NV_MODEL_INFO: 0x97,
  SET_DAC_BUF_THOLD_LVL: 0xa0,
  SECURITY_REQUEST: 0xb0,
  SECURITY_RESPONSE: 0xb1,
};

/** First byte of a data datagram. */
const DATA_ID = 0xa9;
/** First byte of a compressed data datagram, which nothing here decodes. */
const DATA_COMPRESSED_ID = 0x9a;

/** Result byte in a reply. */
const RESULT = { OK: 0x00, FAILED: 0x01 };

/** How many times each reply is sent by default. What the hardware does. */
const REPLY_REPEAT = 2;

/**
 * Length of the security response body. The host strips three bytes -- the
 * command, the result and a second status byte -- and hands the rest to its
 * verifier. A real chip answers 35 bytes.
 */
const SECURITY_RESPONSE_BYTES = 35;

/**
 * Connection type in the info reply, one less than the host's enum: it adds
 * one on the way in. 2 reads as "ethernet, cube as a client", which is what a
 * device on the user's own network is.
 */
const CONNECTION_ETHERNET_CLIENT = 2;

/** How the flags byte is read by firmware 0.13 and later. */
const FLAG = { OUTPUT_ENABLED: 1 << 0, INTERLOCK_ENABLED: 1 << 1 };

/**
 * A locally administered serial, so it can never collide with real hardware.
 * A cube's serial is its ESP32 MAC; a real one carries Espressif's OUI
 * (e4:65:b8). The shipped LaserOS also checks this against the host NIC's own
 * MAC, which a virtual cube cannot satisfy -- see [[laser-dac-emulation]] --
 * so there is no point pretending to be real hardware here. MadMapper, the
 * one host this actually serves, does not care what the serial is.
 */
const DEFAULT_SERIAL = [0x02, 0xbe, 0xa1, 0x00, 0x00, 0x01];

class LaserCubeDac extends LaserDac {
  /**
   * @param {Object} [options] plus everything `LaserDac` takes
   * @param {Array<Number>} [options.serial] six bytes, the cube's identity
   * @param {String} [options.model] model name, at most 24 characters
   * @param {Number} [options.modelNumber]
   * @param {Number} [options.alivePort]
   * @param {Number} [options.cmdPort]
   * @param {Number} [options.dataPort] each 0 picks a free port
   * @param {Number} [options.maxRate] highest point rate accepted
   * @param {Number} [options.replyRepeat] how many times each reply is sent;
   *   defaults to what the hardware does, and set to 1 by a test that wants
   *   one datagram per request
   */
  constructor({
    name = 'Beam laser (LaserCube)',
    serial = DEFAULT_SERIAL,
    model = 'Beam',
    modelNumber = 5,
    alivePort = LASERCUBE_ALIVE_PORT,
    cmdPort = LASERCUBE_CMD_PORT,
    dataPort = LASERCUBE_DATA_PORT,
    capacity = BUFFER_CAPACITY,
    maxRate = MAX_POINT_RATE,
    replyRepeat = REPLY_REPEAT,
    ...rest
  } = {}) {
    super({ name, capacity, ...rest });
    this.serial = Buffer.from(serial);
    this.model = model;
    this.modelNumber = modelNumber;
    this.alivePort = alivePort;
    this.cmdPort = cmdPort;
    this.dataPort = dataPort;
    this.maxRate = maxRate;
    this.replyRepeat = replyRepeat;

    this.aliveSocket = null;
    this.cmdSocket = null;
    this.dataSocket = null;

    /** Whether the host asked for output. Points drain either way. */
    this.outputEnabled = false;
    /** Whether each data datagram is answered with the buffer free count. */
    this.bufferReplies = false;
    /**
     * How full the buffer must be before playback starts after running dry.
     * The host sets it; until then the cube plays whatever it has.
     */
    this.startLevel = 0;
    /** Waiting for the buffer to reach `startLevel`. */
    this.waiting = false;
    /** The last security request, kept only so the readout can say one came. */
    this.securityRequests = 0;
    /** Who sent points last, for the readout. */
    this.host = null;
    this.hostAt = 0;
    /** Sequence bookkeeping, for the readout: datagrams lost between two. */
    this.lastMessage = -1;
    this.lostDatagrams = 0;
    this.droppedPoints = 0;
    this.warnedCompressed = false;
    /** Addresses heard from, so each is logged once. */
    this.seen = new Set();

    // A cube plays from the moment it has points. There is no begin command.
    this.pointRate = maxRate;
  }

  /**
   * Binds the three ports.
   *
   * All three or none: a cube the host can ping but not command, or command
   * but not feed, is worse than one that is absent, because the host adds it
   * and then waits four seconds for an answer that never comes.
   *
   * @param {Object} opts
   * @param {String} [opts.bind]
   * @returns {Promise<void>}
   */
  async open(opts) {
    const bind = opts.bind || '0.0.0.0';
    // All three, before any of them is taken: `reuseAddr` would otherwise bind
    // a port another program owns and leave this cube listening to nothing.
    // MadMapper itself holds 45457 on the machine's LAN address for its own
    // discovery, which is exactly how a cube came up "connected" in MadMapper
    // and never received a point.
    const ports = [this.alivePort, this.cmdPort, this.dataPort];
    const hint = 'MadMapper and LaserOS both use these ports; try another address, or 127.0.0.1';
    await claimPorts(ports, bind, hint);
    try {
      this.aliveSocket = await this.listen(this.alivePort, bind, (m, r) => this.onAlive(m, r));
      this.alivePort = this.aliveSocket.address().port;
      this.cmdSocket = await this.listen(this.cmdPort, bind, (m, r) => this.onCommand(m, r));
      this.cmdPort = this.cmdSocket.address().port;
      this.dataSocket = await this.listen(this.dataPort, bind, (m, r) => this.onData(m, r));
      this.dataPort = this.dataSocket.address().port;
    } catch (err) {
      this.close();
      if (err.code === 'EADDRINUSE') {
        console.error(`[${this.name}] port in use -- is LaserOS running on this machine? A virtual cube and LaserOS cannot share one.`);
      }
      throw err;
    }
    console.log(`[${this.name}] listening on ${bind} ports ${this.alivePort}/${this.cmdPort}/${this.dataPort}`);
    this.play(this.pointRate);
  }

  /**
   * Binds one UDP socket.
   *
   * `reuseAddr` so that a second Beam on a second address of the same machine
   * can bind the same port; it does nothing against an exclusive bind, which
   * is what LaserOS itself takes.
   *
   * @param {Number} port
   * @param {String} bind
   * @param {(msg: Buffer, rinfo: Object) => void} onMessage
   * @returns {Promise<dgram.Socket>}
   */
  listen(port, bind, onMessage) {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      socket.on('message', onMessage);
      socket.once('error', (err) => {
        console.error(`[${this.name}] port ${port} error:`, err.message);
        reject(err);
      });
      socket.bind(port, bind, () => {
        socket.on('error', (err) => console.error(`[${this.name}] socket error:`, err.message));
        resolve(socket);
      });
    });
  }

  /**
   * Answers a ping. Two bytes: the command and a zero, which is the whole of
   * what the host checks before it adds the sender as a cube.
   *
   * @param {Buffer} msg
   * @param {Object} rinfo
   */
  onAlive(msg, rinfo) {
    if (!msg.length || msg[0] !== CMD.GET_ALIVE) return;
    this.noteHost(rinfo);
    this.send(this.aliveSocket, Buffer.from([CMD.GET_ALIVE, RESULT.OK]), rinfo);
  }

  /**
   * Logs a host the first time it is heard from.
   *
   * Discovery is the part that fails silently -- a host that dislikes an
   * answer just stops asking -- so knowing which addresses are talking to
   * the cube at all is worth one line each. Once per address, not per packet.
   *
   * @param {Object} rinfo
   */
  noteHost(rinfo) {
    if (this.seen.has(rinfo.address)) return;
    this.seen.add(rinfo.address);
    console.log(`[${this.name}] host ${rinfo.address} found the cube`);
  }

  /**
   * Runs one command and answers it.
   *
   * Every command is answered, because the host repeats the ones it cares
   * about and treats silence as a lost cube after four seconds. The buffer is
   * played up to now first, so a fullness figure in the answer is current.
   *
   * @param {Buffer} msg
   * @param {Object} rinfo
   */
  onCommand(msg, rinfo) {
    if (!msg.length) return;
    this.advance();
    const cmd = msg[0];
    const socket = this.cmdSocket;
    this.noteHost(rinfo);

    switch (cmd) {
      case CMD.GET_ALIVE:
        // Some hosts ping the command port too.
        this.send(socket, Buffer.from([CMD.GET_ALIVE, RESULT.OK]), rinfo);
        return;

      case CMD.GET_FULL_INFO:
        this.send(socket, this.infoPacket(LaserCubeDac.localAddressFor(rinfo)), rinfo);
        return;

      case CMD.ENABLE_BUFFER_SIZE_RESPONSE_ON_DATA:
        this.bufferReplies = msg.length > 1 && msg[1] !== 0;
        this.ack(socket, cmd, rinfo);
        return;

      case CMD.SET_OUTPUT:
        this.outputEnabled = msg.length > 1 && msg[1] !== 0;
        this.ack(socket, cmd, rinfo);
        return;

      case CMD.SET_ILDA_RATE: {
        if (msg.length < 5) {
          this.fail(socket, cmd, rinfo);
          return;
        }
        const rate = msg.readUInt32LE(1);
        if (rate < 1 || rate > this.maxRate) {
          this.fail(socket, cmd, rinfo);
          return;
        }
        this.pointRate = rate;
        this.ack(socket, cmd, rinfo);
        return;
      }

      case CMD.GET_RINGBUFFER_EMPTY_SAMPLE_COUNT:
        this.send(socket, this.freePacket(), rinfo);
        return;

      case CMD.CLEAR_RINGBUFFER:
        this.clear();
        this.ack(socket, cmd, rinfo);
        return;

      case CMD.SET_DAC_BUF_THOLD_LVL: {
        if (msg.length < 5) {
          this.fail(socket, cmd, rinfo);
          return;
        }
        const level = msg.readUInt32LE(1);
        if (level >= this.capacity) {
          this.fail(socket, cmd, rinfo);
          return;
        }
        this.startLevel = level;
        this.ack(socket, cmd, rinfo);
        return;
      }

      case CMD.SET_NV_MODEL_INFO:
        // A factory command. Acknowledged and ignored: what this device is
        // called is not the host's to change.
        this.ack(socket, cmd, rinfo);
        return;

      case CMD.SECURITY_REQUEST:
        this.securityRequests += 1;
        this.ack(socket, cmd, rinfo);
        return;

      case CMD.SECURITY_RESPONSE: {
        // Command, result, a second status byte the host also expects to be
        // zero, then the body a crypto chip would have signed. Zeros, since
        // there is no chip; see the note at the top.
        const packet = Buffer.alloc(3 + SECURITY_RESPONSE_BYTES);
        packet[0] = CMD.SECURITY_RESPONSE;
        this.send(socket, packet, rinfo);
        return;
      }

      default:
        console.log(`[${this.name}] unknown command 0x${cmd.toString(16)} from ${rinfo.address}`);
        this.fail(socket, cmd, rinfo);
    }
  }

  /**
   * Takes one datagram of points.
   *
   * Points beyond the buffer's room are dropped rather than the whole
   * datagram refused -- there is no refusal in this protocol; the host paces
   * itself on the free count and a burst past it is its own to lose.
   *
   * @param {Buffer} msg
   * @param {Object} rinfo
   */
  onData(msg, rinfo) {
    if (msg.length < DATA_HEADER) return;
    if (msg[0] === DATA_COMPRESSED_ID) {
      if (!this.warnedCompressed) {
        console.error(`[${this.name}] compressed sample data is not supported; points dropped`);
        this.warnedCompressed = true;
      }
      return;
    }
    if (msg[0] !== DATA_ID) return;

    this.advance();

    const message = msg[2];
    if (this.lastMessage >= 0) {
      const expected = (this.lastMessage + 1) & 0xff;
      if (message !== expected) this.lostDatagrams += (message - expected) & 0xff;
    }
    this.lastMessage = message;
    this.host = `${rinfo.address}:${rinfo.port}`;
    this.hostAt = Date.now();

    const n = Math.floor((msg.length - DATA_HEADER) / POINT_BYTES);
    let at = DATA_HEADER;
    for (let i = 0; i < n; i++) {
      // Twelve-bit values, scaled to the renderer's sixteen: positions are
      // centred first so 2048 lands on zero, colours are simply widened.
      const x = ((msg.readUInt16LE(at) & 0xfff) - 2048) * 16;
      const y = ((msg.readUInt16LE(at + 2) & 0xfff) - 2048) * 16;
      const r = (msg.readUInt16LE(at + 4) & 0xfff) * 16;
      const g = (msg.readUInt16LE(at + 6) & 0xfff) * 16;
      const b = (msg.readUInt16LE(at + 8) & 0xfff) * 16;
      if (!this.push(x & 0xffff, y & 0xffff, r, g, b, 0xffff)) {
        this.droppedPoints += n - i;
        break;
      }
      at += POINT_BYTES;
    }

    if (this.bufferReplies) this.send(this.dataSocket, this.freePacket(), rinfo);
  }

  /**
   * @override A cube plays whatever it has, unless the host set a level to
   * fill to first, in which case it waits for that after running dry.
   */
  canPlay() {
    if (this.dry) {
      this.dry = false;
      this.waiting = this.startLevel > 0;
    }
    if (this.waiting && this.count < this.startLevel) return false;
    this.waiting = false;
    return true;
  }

  /**
   * @override Points played while output is disabled are drained but not
   * shown -- what the host asked for is a dark laser, not a stopped one.
   */
  flush() {
    if (!this.outputEnabled) {
      this.outCount = 0;
      return;
    }
    super.flush();
  }

  /**
   * The full-info reply, laid out as `handleFullInfoPkt` reads it -- and, in
   * the bytes that function skips, as a real cube fills them.
   *
   * As a Cube2 Ultra 7.5W (firmware 0.23) sends it:
   *
   *     77 00 00 00 17 02 00 00 ff 0f b8 88 00 00 b8 88 00 00 03 70 17 70 17
   *     5f 13 02 e4 65 b8 15 60 e8 c0 a8 01 c1 02 05 "Cube2 Ultra 7.5W"
   *
   * The public host code reads none of bytes 6-9, 18 or 36, but the shipped
   * LaserOS may, and a host that scales its galvo output by a max DAC value
   * of zero has a laser with no range. So the unread bytes are what the
   * hardware puts there, not zeros.
   *
   * @param {String} [localAddress] the address this reply leaves from
   * @returns {Buffer} exactly 64 bytes
   */
  infoPacket(localAddress = null) {
    const p = Buffer.alloc(INFO_BYTES);
    p[0] = CMD.GET_FULL_INFO;
    p[1] = RESULT.OK;
    p[2] = 0; // payload version; the host decodes version 0 and no other
    p[3] = 0; // firmware major
    p[4] = 23; // firmware minor
    p[5] = (this.outputEnabled ? FLAG.OUTPUT_ENABLED : 0) | FLAG.INTERLOCK_ENABLED;
    p.writeUInt16LE(0, 6); // min DAC value
    p.writeUInt16LE(MAX_DAC_VALUE, 8);
    p.writeUInt32LE(this.pointRate, 10);
    p.writeUInt32LE(this.maxRate, 14);
    p[18] = 3; // unread by the public code; what the cube sends
    p.writeUInt16LE(this.free, 19);
    p.writeUInt16LE(this.capacity, 21);
    p[23] = 95; // battery percent
    p[24] = 19; // temperature, degrees C
    p[25] = CONNECTION_ETHERNET_CLIENT;
    this.serial.copy(p, 26, 0, 6);
    if (localAddress) {
      localAddress.split('.').forEach((octet, i) => { p[32 + i] = Number(octet) & 0xff; });
    }
    p[36] = 2; // unread by the public code; what the cube sends
    p[37] = this.modelNumber;
    p.write(this.model.slice(0, MODEL_NAME_BYTES - 1), 38, 'ascii');
    return p;
  }

  /**
   * The address a reply to `rinfo` leaves from: the local interface on the
   * sender's subnet, or the first non-loopback one.
   *
   * A real cube reports its own address in the info packet. The socket is
   * bound to every interface, so it cannot say which one will carry the
   * reply; this picks the one that shares the sender's network, which is
   * the one the OS routes to.
   *
   * @param {Object} rinfo
   * @returns {String|null}
   */
  static localAddressFor(rinfo) {
    if (rinfo.address.startsWith('127.')) return '127.0.0.1';
    const sender = rinfo.address.split('.').map(Number);
    let fallback = null;
    const interfaces = os.networkInterfaces();
    const found = Object.values(interfaces).flat().find((entry) => {
      if (entry.family !== 'IPv4' || entry.internal) return false;
      fallback = fallback || entry.address;
      const mask = entry.netmask.split('.').map(Number);
      const local = entry.address.split('.').map(Number);
      return mask.every((m, i) => (local[i] & m) === (sender[i] & m));
    });
    return found ? found.address : fallback;
  }

  /**
   * The buffer-free reply, sent both to the command that asks for it and,
   * when enabled, after every data datagram.
   *
   * @returns {Buffer}
   */
  freePacket() {
    const p = Buffer.alloc(4);
    p[0] = CMD.GET_RINGBUFFER_EMPTY_SAMPLE_COUNT;
    p[1] = RESULT.OK;
    p.writeUInt16LE(this.free, 2);
    return p;
  }

  ack(socket, cmd, rinfo) {
    this.send(socket, Buffer.from([cmd, RESULT.OK]), rinfo);
  }

  fail(socket, cmd, rinfo) {
    this.send(socket, Buffer.from([cmd, RESULT.FAILED]), rinfo);
  }

  /**
   * Sends one datagram back to whoever asked.
   *
   * @param {dgram.Socket} socket
   * @param {Buffer} packet
   * @param {Object} rinfo the sender
   */
  send(socket, packet, rinfo) {
    if (!socket) return;
    // A real cube answers every question twice -- a Cube2 Ultra does, alive
    // and info alike -- for the same reason the
    // host sends every command twice: UDP on Wi-Fi loses packets and every
    // exchange here is idempotent. Mirrored, so a host tuned to hardware
    // sees the same thing.
    for (let n = 0; n < this.replyRepeat; n++) {
      socket.send(packet, rinfo.port, rinfo.address, (err) => {
        if (err) console.error(`[${this.name}] send to ${rinfo.address} failed:`, err.message);
      });
    }
  }

  /** @override */
  report() {
    return {
      ...super.report(),
      protocol: 'lasercube',
      serial: [...this.serial].map((b) => b.toString(16).padStart(2, '0')).join(':'),
      ports: [this.alivePort, this.cmdPort, this.dataPort],
      host: this.host,
      outputEnabled: this.outputEnabled,
      startLevel: this.startLevel,
      securityRequests: this.securityRequests,
      lostDatagrams: this.lostDatagrams,
      droppedPoints: this.droppedPoints,
    };
  }

  /** @override */
  close() {
    [this.aliveSocket, this.cmdSocket, this.dataSocket].forEach((socket) => {
      if (!socket) return;
      try {
        socket.close();
      } catch (err) {
        // Already closed; nothing to do.
      }
    });
    this.aliveSocket = null;
    this.cmdSocket = null;
    this.dataSocket = null;
    this.outputEnabled = false;
    this.bufferReplies = false;
    this.host = null;
    this.lastMessage = -1;
    this.seen.clear();
  }
}

export default LaserCubeDac;
