/* eslint-disable no-console */
/* eslint-disable no-bitwise */
// Bit twiddling is the subject matter here: a galvo position is a 16-bit
// pattern in an unsigned array, and spelling that as arithmetic would hide the
// one thing a reader needs to check it against.

/**
 * What every laser DAC does that has nothing to do with its protocol.
 *
 * A show laser is driven by a DAC: the software streams galvo points to it and
 * the DAC plays them out to the scanners at a fixed rate. Beam wants that
 * stream, and the cleanest way to get it is the bargain NDI struck for video:
 * **be the device**. Each protocol module here advertises itself as a DAC the
 * sender already knows -- an Ether Dream, a LaserCube -- so the software needs
 * nothing installed and no adapter. It picks Beam as an output.
 *
 * Ether Dream and LaserCube differ in how points arrive -- TCP with a
 * prepare/begin handshake against UDP datagrams with a sequence number -- and
 * in nothing after that. Both have a buffer of a few thousand points that the
 * host keeps full by reading a fullness figure in every reply, and both play
 * it out at a rate the host sets. That shared half is this class; a protocol
 * supplies its sockets and its packet layouts and inherits the rest. Written
 * as two classes it was going to be written twice, and the second copy is
 * where the timing quietly goes wrong.
 *
 * **The buffer is real, and it is what makes the timing right.** A host does
 * not send points at the play rate; it fills the buffer and reads how much
 * room is left. So the buffer is emulated: writes queue points, a clock plays
 * them out at `pointRate`, and what the renderer receives is the points *as
 * played*, not as written. Written points run ahead of played ones by up to a
 * whole buffer -- 60 ms at 30 kpps on an Ether Dream, 200 ms on a LaserCube --
 * and a visualizer that drew them as they arrived would draw bursts. Playback
 * also has to actually drain the buffer, because a host that sees a full
 * buffer stops sending.
 *
 * **One DAC per IP address.** Both protocols address a device by the address
 * it answered from and fixed port numbers, so a machine can be one of each per
 * interface. A second laser on the same machine is a second address, not a
 * second port. That is a limit of the protocols, not of this file, and it is
 * why the ports are options rather than constants: the tests bind ephemeral
 * ones, and a second instance on a loopback alias is the route to two lasers
 * on one machine.
 *
 * Receive only. Beam is the visualizer, never a laser controller.
 */

/**
 * Values per point in a batch handed to the renderer: x, y, r, g, b, i.
 *
 * x and y are signed 16-bit galvo positions, full scale each way, stored as
 * their bit pattern in an unsigned array -- decode with `(v << 16) >> 16`.
 * Colours and intensity are unsigned 16-bit, 65535 full. Every protocol is
 * scaled to this on the way in, so the renderer never learns which DAC a
 * point came from.
 */
export const POINT_STRIDE = 6;

/**
 * How often played points are handed to the renderer, in ms.
 *
 * The display rate, the same coalescing `DmxReceiver` does: at 30 kpps a
 * point a message would be 30,000 wakeups a second for a picture that changes
 * 60 times.
 */
export const FLUSH_INTERVAL = 16;

/**
 * The most playback time one tick may account for, in ms.
 *
 * Real hardware never stalls; this process can -- a file dialog, a garbage
 * collection, a busy second on the main thread. Charging a 200 ms stall to the
 * buffer at 30 kpps would drain it three times over and report it empty
 * through no fault of the host's, after which an Ether Dream host has to stop
 * and re-prepare and the show blinks. A visualizer would rather let time slip:
 * play a bounded amount and carry on.
 */
export const MAX_TICK_MS = 30;

/** How often the playback log may repeat itself, in ms. */
const LOG_INTERVAL = 1000;

/**
 * `control` bit that says a queued rate change applies from this point.
 *
 * Ether Dream's; a LaserCube never sets it, and a point with no control word
 * simply never triggers it.
 */
export const CONTROL_RATE_CHANGE = 0x8000;

class LaserDac {
  /**
   * @param {Object} options
   * @param {String} options.name shown in logs and the readout
   * @param {Number} options.capacity buffer size in points
   * @param {() => Number} [options.now] monotonic clock in ms, replaceable so
   *   a test can play the buffer out by hand
   * @param {Boolean} [options.timers] false runs no interval timers; the
   *   owner then calls `tick()` itself
   */
  constructor({
    name, capacity, now = () => performance.now(), timers = true,
  }) {
    this.name = name;
    this.capacity = capacity;
    this.now = now;
    this.timers = timers;
    this.onFrames = null;
    this.flushTimer = null;
    this.opened = false;

    /**
     * The point buffer, a ring: `head` is where the next write lands, `tail`
     * the next point to play, `count` how many are queued.
     */
    this.ring = new Uint16Array(capacity * POINT_STRIDE);
    this.ringControl = new Uint16Array(capacity);
    this.head = 0;
    this.tail = 0;
    this.count = 0;

    /** Played points waiting for the next flush. */
    this.out = new Uint16Array(capacity * POINT_STRIDE);
    this.outCount = 0;

    /** Whether the clock is draining the buffer. */
    this.playing = false;
    this.pointRate = 0;
    this.queuedRate = null;
    /** Set by `advance` when the clock asked for more than was there. */
    this.dry = false;
    /** Fractional point owed to the clock between ticks. */
    this.pending = 0;
    this.lastTick = 0;

    this.playedTotal = 0;
    this.lastLog = 0;
  }

  get listening() {
    return this.opened;
  }

  /** Room left in the buffer, in points. */
  get free() {
    return this.capacity - this.count;
  }

  /**
   * Opens the sockets and starts the clock.
   *
   * @param {(batch: {rate: Number, points: Uint16Array}) => void} onFrames
   *   called once per flush with the points played since the last one, as
   *   `POINT_STRIDE` values each
   * @param {Object} [opts]
   * @param {String} [opts.bind] local interface to listen on (default all)
   * @returns {Promise<void>} resolves once the protocol is listening
   */
  async start(onFrames, opts = {}) {
    this.onFrames = onFrames || this.onFrames;
    if (this.opened) return;
    await this.open(opts);
    this.opened = true;
    if (this.timers) {
      this.flushTimer = setInterval(() => this.tick(), FLUSH_INTERVAL);
    }
  }

  /**
   * Opens whatever the protocol listens on. Rejects if it cannot.
   *
   * @param {Object} opts the options `start` was given
   * @returns {Promise<void>}
   */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  open(opts) {
    return Promise.resolve();
  }

  /** Closes whatever `open` opened. */
  // eslint-disable-next-line class-methods-use-this
  close() {}

  /**
   * Whether the clock may play right now. A protocol that wants the buffer
   * to fill to a level before it starts overrides this.
   *
   * @returns {Boolean}
   */
  // eslint-disable-next-line class-methods-use-this
  canPlay() {
    return true;
  }

  /**
   * Queues one point, already scaled to the renderer's ranges.
   *
   * A method call per point is 30,000 calls a second, which is nothing; the
   * alternative is every protocol reaching into the ring with its own
   * offsets, and that is where the second copy of a bug lives.
   *
   * @param {Number} x signed 16-bit bit pattern
   * @param {Number} y signed 16-bit bit pattern
   * @param {Number} r 0..65535
   * @param {Number} g 0..65535
   * @param {Number} b 0..65535
   * @param {Number} i 0..65535
   * @param {Number} [control] the protocol's control word, if it has one
   * @returns {Boolean} false if the buffer was full and the point dropped
   */
  push(x, y, r, g, b, i, control = 0) {
    if (this.count >= this.capacity) return false;
    const { ring, head } = this;
    const base = head * POINT_STRIDE;
    ring[base] = x;
    ring[base + 1] = y;
    ring[base + 2] = r;
    ring[base + 3] = g;
    ring[base + 4] = b;
    ring[base + 5] = i;
    this.ringControl[head] = control;
    this.head = (head + 1) % this.capacity;
    this.count += 1;
    return true;
  }

  /** Empties the buffer and forgets any fraction the clock was owed. */
  clear() {
    this.head = 0;
    this.tail = 0;
    this.count = 0;
    this.pending = 0;
    this.dry = false;
  }

  /**
   * Starts the clock at `rate` points a second.
   *
   * @param {Number} rate
   */
  play(rate) {
    this.pointRate = rate;
    this.pending = 0;
    this.lastTick = this.now();
    this.playing = true;
  }

  /** Stops the clock. The buffer keeps what it holds. */
  pause() {
    this.playing = false;
  }

  /**
   * Plays the buffer out up to the present moment.
   *
   * Points the clock says have been played move from the ring to the outgoing
   * batch. Asking for more than is there sets `dry`; what that means -- an
   * error the host must clear, or merely a pause -- is the protocol's to say.
   *
   * @returns {Number} points played by this call
   */
  advance() {
    const now = this.now();
    if (!this.playing || !this.canPlay()) {
      this.lastTick = now;
      return 0;
    }
    const elapsed = Math.min(MAX_TICK_MS, Math.max(0, now - this.lastTick));
    this.lastTick = now;
    this.pending += (elapsed * this.pointRate) / 1000;
    let due = Math.floor(this.pending);
    this.pending -= due;
    if (!due) return 0;

    this.dry = due > this.count;
    if (this.dry) {
      due = this.count;
      // The clock is not owed the rest: points that never arrived were never
      // played, and carrying the debt forward would drain the next write in
      // one go.
      this.pending = 0;
    }

    // The batch could fill if commands keep arriving between flushes: each
    // call plays at most a buffer's worth, but writes refill it in between.
    if (this.outCount + due > this.capacity) this.flush();

    const {
      ring, ringControl, out, capacity,
    } = this;
    let { tail, outCount } = this;
    for (let n = 0; n < due; n++) {
      if (this.queuedRate !== null && (ringControl[tail] & CONTROL_RATE_CHANGE)) {
        // Applied from this point on. The points already counted as due were
        // owed at the old rate; close enough, since a host changes rate
        // between frames rather than mid-line.
        this.pointRate = this.queuedRate;
        this.queuedRate = null;
      }
      const src = tail * POINT_STRIDE;
      const dst = outCount * POINT_STRIDE;
      out[dst] = ring[src];
      out[dst + 1] = ring[src + 1];
      out[dst + 2] = ring[src + 2];
      out[dst + 3] = ring[src + 3];
      out[dst + 4] = ring[src + 4];
      out[dst + 5] = ring[src + 5];
      tail = (tail + 1) % capacity;
      outCount += 1;
    }
    this.tail = tail;
    this.outCount = outCount;
    this.count -= due;
    this.playedTotal += due;
    return due;
  }

  /**
   * Plays the buffer out and hands what was played to the renderer.
   *
   * @public the interval calls this; so does a test, by hand
   */
  tick() {
    this.advance();
    this.flush();
  }

  /**
   * Hands the points played since the last call to the renderer, as one
   * message.
   */
  flush() {
    if (!this.outCount) return;
    const points = this.out.slice(0, this.outCount * POINT_STRIDE);
    this.outCount = 0;
    if (!this.onFrames) return;
    this.onFrames({ rate: this.pointRate, points });

    const now = Date.now();
    if (!this.lastLog || now - this.lastLog >= LOG_INTERVAL) {
      this.lastLog = now;
      console.log(`[${this.name}] played ${this.playedTotal} points, ${this.pointRate} pps, buffer ${this.count}/${this.capacity}`);
    }
  }

  /**
   * What the DAC is doing, for a readout. Protocols add their own fields.
   *
   * @public
   * @returns {Object} plain values only
   */
  report() {
    return {
      name: this.name,
      listening: this.opened,
      playing: this.playing,
      rate: this.pointRate,
      fullness: this.count,
      capacity: this.capacity,
      played: this.playedTotal,
    };
  }

  /**
   * Closes everything and forgets the host.
   */
  stop() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.opened) this.close();
    this.opened = false;
    this.outCount = 0;
    this.clear();
    this.pause();
  }
}

export default LaserDac;
