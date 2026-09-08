/* eslint-disable no-console */
/* eslint-disable no-bitwise */
// Bit twiddling is the subject matter here: a DAC packet is fields packed into
// bytes, and spelling that as arithmetic would obscure the one thing a reader
// needs to check it against, which is the protocol's own struct definitions.
import dgram from 'dgram';
import net from 'net';
import LaserDac, { POINT_STRIDE } from './laser_dac';

export { POINT_STRIDE };

/**
 * A virtual Ether Dream laser DAC (main process).
 *
 * The one laser protocol that is open and documented, and the one MadLaser,
 * Beyond, Modulaser and ofxLaser all speak. The LaserCube Ultra speaks it
 * natively too. Helios is USB and cannot be stood in for; the content its
 * owner would send it is the same stream aimed at a different output slot.
 *
 * The protocol is a TCP control connection plus a UDP beacon. A host finds a
 * DAC only through the beacon -- there is no way to type an address in -- so
 * this broadcasts once a second like the hardware does. Everything after the
 * parse is `LaserDac`'s and shared with the LaserCube.
 *
 * @see https://ether-dream.com/protocol.html
 */

/** The TCP port every host connects to. */
export const ETHERDREAM_TCP_PORT = 7765;
/** The UDP port every host listens on for DAC beacons. */
export const ETHERDREAM_UDP_PORT = 7654;

/**
 * Points the buffer holds, the figure a real Ether Dream reports.
 *
 * Hosts size their writes from what the beacon says, so the number is not
 * arbitrary: too small and a host at a high point rate cannot keep it fed,
 * too large and the lead between written and played grows. 1800 is what the
 * hardware has and what every host has been tuned against.
 */
export const BUFFER_CAPACITY = 1800;

/** Highest point rate accepted, per second. What the hardware reports. */
export const MAX_POINT_RATE = 100000;

/** Bytes per point on the wire: `struct dac_point`. */
const POINT_BYTES = 18;
/** Bytes in `struct dac_status`. */
const STATUS_BYTES = 20;
/** Bytes in a reply: response, command, status. */
const RESPONSE_BYTES = 2 + STATUS_BYTES;
/** Bytes in the beacon: mac, hw, sw, capacity, max rate, status. */
const BEACON_BYTES = 6 + 2 + 2 + 2 + 4 + STATUS_BYTES;

/** How often the beacon goes out, in ms. The protocol says once a second. */
const BEACON_INTERVAL = 1000;

/** The most unparsed bytes kept from a host before it is cut off. */
const MAX_PENDING_BYTES = 1 << 20;

/** `light_engine_state`. */
const LIGHT_ENGINE = {
  READY: 0, WARMUP: 1, COOLDOWN: 2, ESTOP: 3,
};
/** `playback_state`. */
export const PLAYBACK = { IDLE: 0, PREPARED: 1, PLAYING: 2 };
/** `light_engine_flags` bits. */
const LIGHT_FLAG = { ESTOP_PACKET: 1 << 0 };
/** `playback_flags` bits. */
const PLAY_FLAG = { SHUTTER: 1 << 0, UNDERFLOW: 1 << 1, ESTOP: 1 << 2 };
/** `source`: points arriving over the network, the only one emulated. */
const SOURCE_NETWORK = 0;

/** Command bytes. */
const CMD = {
  PREPARE: 0x70, // 'p'
  BEGIN: 0x62, // 'b'
  QUEUE: 0x71, // 'q'
  // The protocol page prints queue-rate-change as `'q' (0x74)`, which is two
  // different bytes: 0x74 is 't'. Every client seen writes the letter, but a
  // client written from the hex would be right by its own reading, so both
  // are taken.
  QUEUE_ALT: 0x74,
  DATA: 0x64, // 'd'
  STOP: 0x73, // 's'
  ESTOP: 0x00,
  ESTOP_ALT: 0xff,
  CLEAR: 0x63, // 'c'
  PING: 0x3f, // '?'
};

/** Response bytes. */
export const RESPONSE = {
  ACK: 0x61, // 'a'
  FULL: 0x46, // 'F'  NAK: the write did not fit
  INVALID: 0x49, // 'I'  NAK: command not valid now
  STOP: 0x21, // '!'  NAK: an e-stop condition is in force
};

/** A locally administered MAC, so it can never collide with real hardware. */
const DEFAULT_MAC = [0x02, 0xbe, 0xa1, 0x00, 0x00, 0x01];

class EtherDreamDac extends LaserDac {
  /**
   * @param {Object} [options] plus everything `LaserDac` takes
   * @param {Array<Number>} [options.mac] six bytes, the DAC's identity to a host
   * @param {Number} [options.tcpPort] control port; 0 picks a free one
   * @param {Number} [options.udpPort] where the beacon is sent
   * @param {String} [options.beaconAddress] where the beacon is sent
   * @param {Number} [options.maxRate] highest point rate accepted
   */
  constructor({
    name = 'Beam laser (Ether Dream)',
    mac = DEFAULT_MAC,
    tcpPort = ETHERDREAM_TCP_PORT,
    udpPort = ETHERDREAM_UDP_PORT,
    beaconAddress = '255.255.255.255',
    capacity = BUFFER_CAPACITY,
    maxRate = MAX_POINT_RATE,
    ...rest
  } = {}) {
    super({ name, capacity, ...rest });
    this.mac = Buffer.from(mac);
    this.tcpPort = tcpPort;
    this.udpPort = udpPort;
    this.beaconAddress = beaconAddress;
    this.maxRate = maxRate;

    this.server = null;
    this.beacon = null;
    this.client = null;
    this.beaconTimer = null;
    this.beaconFailed = false;

    /** Bytes from the host not yet forming a whole command. */
    this.rx = Buffer.alloc(0);

    this.lightEngine = LIGHT_ENGINE.READY;
    this.lightFlags = 0;
    this.playback = PLAYBACK.IDLE;
    this.playFlags = 0;
    /** Points played since the last prepare, the protocol's `point_count`. */
    this.pointCount = 0;
  }

  /**
   * Opens the control port and starts the beacon.
   *
   * @param {Object} opts
   * @param {String} [opts.bind]
   * @returns {Promise<void>} resolves once the control port is bound
   */
  open(opts) {
    const bind = opts.bind || '0.0.0.0';
    const server = net.createServer((socket) => this.accept(socket));
    this.server = server;

    return new Promise((resolve, reject) => {
      server.once('error', (err) => {
        console.error(`[${this.name}] control port error:`, err.message);
        this.server = null;
        reject(err);
      });
      server.listen(this.tcpPort, bind, () => {
        this.tcpPort = server.address().port;
        console.log(`[${this.name}] control port ${bind}:${this.tcpPort}`);
        this.startBeacon(bind);
        resolve();
      });
    });
  }

  /**
   * Begins announcing the DAC once a second.
   *
   * Sent from an ephemeral port, since a host reads the sender's address and
   * nothing else from it.
   *
   * @param {String} bind
   */
  startBeacon(bind) {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('error', (err) => {
      if (!this.beaconFailed) console.error(`[${this.name}] beacon error:`, err.message);
      this.beaconFailed = true;
    });
    socket.bind(0, bind, () => {
      try {
        socket.setBroadcast(true);
      } catch (err) {
        console.error(`[${this.name}] beacon cannot broadcast:`, err.message);
      }
      this.sendBeacon();
      if (this.timers) {
        this.beaconTimer = setInterval(() => this.sendBeacon(), BEACON_INTERVAL);
      }
    });
    this.beacon = socket;
  }

  /**
   * Sends one beacon datagram.
   *
   * @public so a test can ask for one rather than wait a second
   */
  sendBeacon() {
    if (!this.beacon) return;
    const packet = Buffer.alloc(BEACON_BYTES);
    this.mac.copy(packet, 0, 0, 6);
    packet.writeUInt16LE(0, 6); // hw_revision
    packet.writeUInt16LE(2, 8); // sw_revision
    packet.writeUInt16LE(this.capacity, 10);
    packet.writeUInt32LE(this.maxRate, 12);
    this.writeStatus(packet, 16);
    this.beacon.send(packet, this.udpPort, this.beaconAddress, (err) => {
      if (err && !this.beaconFailed) {
        console.error(`[${this.name}] beacon send failed:`, err.message);
      }
      if (err) this.beaconFailed = true;
    });
  }

  /**
   * Takes a host's connection, or refuses it if one is already talking.
   *
   * The protocol is explicit that a DAC talks to one host at a time and
   * rejects a second. Honouring that matters more here than on hardware:
   * two applications streaming to one virtual laser would interleave their
   * points into one picture and neither would be able to tell.
   *
   * @param {net.Socket} socket
   */
  accept(socket) {
    if (this.client) {
      console.log(`[${this.name}] refused ${socket.remoteAddress}: a host is connected`);
      socket.destroy();
      return;
    }
    this.client = socket;
    this.rx = Buffer.alloc(0);
    socket.setNoDelay(true);
    console.log(`[${this.name}] host ${socket.remoteAddress}:${socket.remotePort} connected`);

    socket.on('data', (data) => this.receive(data));
    socket.on('error', (err) => {
      console.error(`[${this.name}] host error:`, err.message);
    });
    socket.on('close', () => {
      if (this.client !== socket) return;
      this.client = null;
      this.rx = Buffer.alloc(0);
      // The host is gone, so nothing is going to keep the buffer fed. Stop
      // rather than play the tail out and then report an underflow to nobody.
      this.advance();
      this.setPlayback(PLAYBACK.IDLE);
      console.log(`[${this.name}] host disconnected`);
    });

    // On connect a DAC answers as if it had been pinged, which is how a host
    // learns the buffer size and state before it sends anything.
    this.reply(RESPONSE.ACK, CMD.PING);
  }

  /**
   * Takes bytes from the host and runs every whole command they complete.
   *
   * TCP is a stream: a data command of 1000 points is 18 KB and arrives in
   * however many pieces the stack chose, and two small commands may share one
   * piece. So this accumulates and cuts by the length each command declares.
   *
   * @param {Buffer} data
   */
  receive(data) {
    this.rx = this.rx.length ? Buffer.concat([this.rx, data]) : data;
    if (this.rx.length > MAX_PENDING_BYTES) {
      console.error(`[${this.name}] host sent ${this.rx.length} bytes without a whole command; dropping it`);
      this.client.destroy();
      return;
    }

    for (;;) {
      const { rx } = this;
      if (!rx.length) break;
      const cmd = rx[0];
      let need = 1;
      if (cmd === CMD.BEGIN) need = 7;
      else if (cmd === CMD.QUEUE || cmd === CMD.QUEUE_ALT) need = 5;
      else if (cmd === CMD.DATA) {
        if (rx.length < 3) break;
        need = 3 + rx.readUInt16LE(1) * POINT_BYTES;
      }
      if (rx.length < need) break;
      this.rx = rx.subarray(need);
      this.handle(cmd, rx.subarray(0, need));
    }
    // A subarray keeps its parent alive; once everything is consumed, let the
    // chunk go rather than hold 18 KB by a zero-length view.
    if (!this.rx.length) this.rx = Buffer.alloc(0);
  }

  /**
   * Runs one whole command and replies to it.
   *
   * The buffer is played up to now first, so the fullness in the reply is
   * current: that number is the host's only view of how much to send next.
   *
   * @param {Number} cmd
   * @param {Buffer} packet the command and its arguments
   */
  handle(cmd, packet) {
    this.playOut();

    if (cmd === CMD.ESTOP || cmd === CMD.ESTOP_ALT) {
      this.lightEngine = LIGHT_ENGINE.ESTOP;
      this.lightFlags |= LIGHT_FLAG.ESTOP_PACKET;
      this.playFlags |= PLAY_FLAG.ESTOP;
      this.setPlayback(PLAYBACK.IDLE);
      this.reply(RESPONSE.ACK, cmd);
      return;
    }

    if (cmd === CMD.PING) {
      this.reply(RESPONSE.ACK, cmd);
      return;
    }

    if (cmd === CMD.CLEAR) {
      this.lightEngine = LIGHT_ENGINE.READY;
      this.lightFlags = 0;
      this.reply(RESPONSE.ACK, cmd);
      return;
    }

    if (this.lightEngine === LIGHT_ENGINE.ESTOP) {
      this.reply(RESPONSE.STOP, cmd);
      return;
    }

    switch (cmd) {
      case CMD.PREPARE:
        if (this.playback !== PLAYBACK.IDLE) {
          this.reply(RESPONSE.INVALID, cmd);
          return;
        }
        this.clear();
        this.pointCount = 0;
        this.queuedRate = null;
        this.playFlags &= ~(PLAY_FLAG.UNDERFLOW | PLAY_FLAG.ESTOP);
        this.setPlayback(PLAYBACK.PREPARED);
        this.reply(RESPONSE.ACK, cmd);
        return;

      case CMD.BEGIN: {
        const rate = packet.readUInt32LE(3);
        if (this.playback !== PLAYBACK.PREPARED || rate < 1 || rate > this.maxRate) {
          this.reply(RESPONSE.INVALID, cmd);
          return;
        }
        this.setPlayback(PLAYBACK.PLAYING, rate);
        this.reply(RESPONSE.ACK, cmd);
        return;
      }

      case CMD.QUEUE:
      case CMD.QUEUE_ALT: {
        const rate = packet.readUInt32LE(1);
        if (this.playback === PLAYBACK.IDLE || rate < 1 || rate > this.maxRate) {
          this.reply(RESPONSE.INVALID, cmd);
          return;
        }
        this.queuedRate = rate;
        this.reply(RESPONSE.ACK, cmd);
        return;
      }

      case CMD.DATA: {
        if (this.playback === PLAYBACK.IDLE) {
          this.reply(RESPONSE.INVALID, cmd);
          return;
        }
        const n = packet.readUInt16LE(1);
        if (n > this.free) {
          // The whole write is refused, not the part that fits; the host
          // resends it once fullness has dropped.
          this.reply(RESPONSE.FULL, cmd);
          return;
        }
        this.enqueue(packet, 3, n);
        this.reply(RESPONSE.ACK, cmd);
        return;
      }

      case CMD.STOP:
        if (this.playback === PLAYBACK.IDLE) {
          this.reply(RESPONSE.INVALID, cmd);
          return;
        }
        this.setPlayback(PLAYBACK.IDLE);
        this.reply(RESPONSE.ACK, cmd);
        return;

      default:
        // The protocol says an unknown command is an e-stop, as a safety
        // matter for a device that can blind someone. Nothing here can, and
        // a stray byte from a host turning into a stop it then has to clear
        // would only make a visualizer harder to use than the hardware.
        console.log(`[${this.name}] unknown command 0x${cmd.toString(16)}`);
        this.reply(RESPONSE.INVALID, cmd);
    }
  }

  /**
   * Copies `n` points from a data command into the ring.
   *
   * @param {Buffer} packet
   * @param {Number} offset of the first point
   * @param {Number} n
   */
  enqueue(packet, offset, n) {
    let at = offset;
    for (let i = 0; i < n; i++) {
      this.push(
        packet.readUInt16LE(at + 2), // x, as its bit pattern
        packet.readUInt16LE(at + 4), // y
        packet.readUInt16LE(at + 6), // r
        packet.readUInt16LE(at + 8), // g
        packet.readUInt16LE(at + 10), // b
        packet.readUInt16LE(at + 12), // i
        packet.readUInt16LE(at), // control
      );
      at += POINT_BYTES;
    }
  }

  /**
   * Plays the buffer out, and turns running dry into what the protocol says
   * it is: an underflow, which stops the stream until the host prepares
   * again.
   */
  playOut() {
    const played = this.advance();
    this.pointCount += played;
    if (this.dry && this.playback === PLAYBACK.PLAYING) {
      this.dry = false;
      this.playFlags |= PLAY_FLAG.UNDERFLOW;
      this.setPlayback(PLAYBACK.IDLE);
      console.log(`[${this.name}] buffer underflow at ${this.pointRate} pps`);
    }
  }

  /** @override so the interval sees underflows too, not only commands. */
  tick() {
    this.playOut();
    this.flush();
  }

  /**
   * Moves the playback state, keeping the clock and the shutter flag honest:
   * the clock runs and the shutter is open only while playing.
   *
   * @param {Number} state a `PLAYBACK` value
   * @param {Number} [rate] point rate, when the state is `PLAYING`
   */
  setPlayback(state, rate = this.pointRate) {
    this.playback = state;
    if (state === PLAYBACK.PLAYING) {
      this.playFlags |= PLAY_FLAG.SHUTTER;
      this.play(rate);
    } else {
      this.playFlags &= ~PLAY_FLAG.SHUTTER;
      this.pause();
    }
  }

  /**
   * Writes `struct dac_status` at `offset`.
   *
   * @param {Buffer} buffer
   * @param {Number} offset
   */
  writeStatus(buffer, offset) {
    buffer.writeUInt8(0, offset); // protocol
    buffer.writeUInt8(this.lightEngine, offset + 1);
    buffer.writeUInt8(this.playback, offset + 2);
    buffer.writeUInt8(SOURCE_NETWORK, offset + 3);
    buffer.writeUInt16LE(this.lightFlags, offset + 4);
    buffer.writeUInt16LE(this.playFlags, offset + 6);
    buffer.writeUInt16LE(0, offset + 8); // source_flags
    buffer.writeUInt16LE(this.count, offset + 10);
    buffer.writeUInt32LE(this.pointRate, offset + 12);
    buffer.writeUInt32LE(this.pointCount >>> 0, offset + 16);
  }

  /**
   * Sends one reply to the host.
   *
   * @param {Number} response a `RESPONSE` value
   * @param {Number} cmd the command being answered
   */
  reply(response, cmd) {
    if (!this.client || this.client.destroyed) return;
    const packet = Buffer.alloc(RESPONSE_BYTES);
    packet.writeUInt8(response, 0);
    packet.writeUInt8(cmd, 1);
    this.writeStatus(packet, 2);
    this.client.write(packet);
  }

  /** @override */
  report() {
    return {
      ...super.report(),
      protocol: 'etherdream',
      mac: [...this.mac].map((b) => b.toString(16).padStart(2, '0')).join(':'),
      port: this.tcpPort,
      host: this.client ? `${this.client.remoteAddress}:${this.client.remotePort}` : null,
      playback: this.playback,
      lightEngine: this.lightEngine,
      underflow: !!(this.playFlags & PLAY_FLAG.UNDERFLOW),
    };
  }

  /** @override */
  close() {
    if (this.beaconTimer) {
      clearInterval(this.beaconTimer);
      this.beaconTimer = null;
    }
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    if (this.beacon) {
      try {
        this.beacon.close();
      } catch (err) {
        // Already closed; nothing to do.
      }
      this.beacon = null;
    }
    if (this.server) {
      try {
        this.server.close();
      } catch (err) {
        // Already closed; nothing to do.
      }
      this.server = null;
    }
    this.rx = Buffer.alloc(0);
    this.setPlayback(PLAYBACK.IDLE);
  }
}

export default EtherDreamDac;
