/**
 * @file Renderer-side laser point streams.
 *
 * The main process runs the virtual DACs (see `src/electron/etherdream.js` and
 * `lasercube.js`) and hands the renderer the points they have *played*, batched
 * once per display frame as `{ protocol, rate, points }` over `window.laser`.
 * This is the receiver: it accumulates each protocol's points into a rolling
 * buffer and, each frame, hands the renderer the slice worth drawing.
 *
 * **A laser has no persistence of its own; the eye supplies it.** A galvo draws
 * one lit point at a time and the picture exists only because the eye integrates
 * roughly the last fiftieth of a second of them. A frame drawn from just the
 * ~500 points that played in one 60 fps tick would be a fragment of a figure,
 * flickering. So the buffer keeps a window of recent points and the renderer
 * draws all of them at once, which is what the eye would have been holding.
 *
 * One buffer per protocol, not per fixture: a DAC is one stream, and a laser
 * fixture selects which stream it shows -- the same relation a display has to a
 * video connector. Two fixtures on one DAC draw the same figure, which is what
 * a real splitter would do.
 *
 * Off Electron (`window.laser` absent) every method is a safe no-op and the
 * renderer simply has nothing to draw.
 */

/** Values per point, matching the DAC batch: x, y, r, g, b, i. */
export const POINT_STRIDE = 6;

/**
 * Points kept per protocol.
 *
 * The window the renderer ever asks for is bounded by the point rate times the
 * persistence window -- at the LaserCube's 30 kpps and a 50 ms window that is
 * 1500 -- so a few times that is ample headroom, and a laser cannot stream
 * faster than its DAC allows. A ring rather than a growing array, so a stream
 * left running for an hour costs the same as one just opened.
 */
const RING_POINTS = 8192;

/**
 * One stream per protocol, and per *service* where a protocol has them.
 *
 * IDN offers a named service per laser in the show and says which one each
 * message feeds, so two lasers on one unit are two separate streams rather than
 * two fixtures drawing the same figure. Protocols without services (Ether
 * Dream, LaserCube) keep a single stream under their own name.
 *
 * @param {String} protocol
 * @param {Number|null} service
 * @returns {String}
 */
function streamKey(protocol, service) {
  return service === null || service === undefined ? protocol : `${protocol}#${service}`;
}

/** Handed back for a dead stream, so blanking allocates nothing. */
const EMPTY_POINTS = new Uint16Array(0);

/**
 * The longest persistence window a caller may ask for, in ms.
 *
 * The eye integrates ~50 ms; more than this and a moving figure smears into
 * a solid. A ceiling so a caller cannot ask for more than the ring can hold.
 */
export const MAX_WINDOW_MS = 120;

/**
 * How long a stream may go quiet before its output is treated as dead, in ms.
 *
 * **A real projector blanks when the data stops.** A galvo scanner has no
 * picture of its own to fall back on: the figure exists only while points keep
 * arriving, and every safety interlock in the business kills the beam the
 * moment they stop. Without this the ring would happily go on handing out the
 * last points it ever received, leaving a frozen figure hanging in the room
 * after the software that drew it had closed -- which is both wrong and, of all
 * the ways to be wrong about a laser, the least acceptable one to model.
 *
 * Long enough to ride out a dropped batch or a stalled frame -- twelve frames
 * at 60 fps, four times the persistence window -- and short enough that letting
 * go of the mouse in MadMapper puts the room dark straight away. The DAC's own
 * buffer drains first (1800 points is 60 ms at 30 kpps), so the real delay from
 * a host stopping is this plus that.
 */
const LIVE_TIMEOUT_MS = 200;

/** Monotonic milliseconds, wherever this is running. */
function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * One protocol's rolling point buffer.
 *
 * The ring stores the most recent `RING_POINTS` points; `count` never exceeds
 * that; `rate` is the play rate of the last batch, which is how many points a
 * window of a given length contains. `frame(windowMs)` returns the last
 * `rate * windowMs / 1000` of them as a fresh contiguous array, oldest first,
 * so the renderer draws a segment between each consecutive pair.
 */
class ProtocolBuffer {
  constructor(protocol = null, service = null) {
    this.protocol = protocol;
    this.service = service;
    this.ring = new Uint16Array(RING_POINTS * POINT_STRIDE);
    this.head = 0; // where the next point is written
    this.count = 0; // points currently held, up to RING_POINTS
    this.rate = 0; // play rate of the most recent batch
    this.received = 0; // total points ever received, for a readout
    this.lastPush = 0; // when points last actually arrived
  }

  /**
   * Appends a played batch.
   *
   * @param {Number} rate points per second the batch was played at
   * @param {Uint16Array} points `POINT_STRIDE` values each
   */
  push(rate, points) {
    if (rate > 0) this.rate = rate;
    const n = Math.floor(points.length / POINT_STRIDE);
    if (n < 1) return;
    // Coming back after a gap starts a new picture rather than continuing the
    // old one, so the first frame after a silence cannot splice fresh points
    // onto the tail of whatever was on screen when the stream died.
    if (this.stale()) this.clear();
    this.lastPush = now();
    this.received += n;
    // A single batch larger than the ring can only leave its tail visible, so
    // copy only the last RING_POINTS of it and let the older ones fall off --
    // the same thing the ring would do one point at a time, without the loop.
    const first = n > RING_POINTS ? n - RING_POINTS : 0;
    for (let i = first; i < n; i += 1) {
      const src = i * POINT_STRIDE;
      const dst = this.head * POINT_STRIDE;
      this.ring[dst] = points[src];
      this.ring[dst + 1] = points[src + 1];
      this.ring[dst + 2] = points[src + 2];
      this.ring[dst + 3] = points[src + 3];
      this.ring[dst + 4] = points[src + 4];
      this.ring[dst + 5] = points[src + 5];
      this.head = (this.head + 1) % RING_POINTS;
      if (this.count < RING_POINTS) this.count += 1;
    }
  }

  /**
   * The points to draw for a persistence window, oldest first.
   *
   * @param {Number} windowMs how much recent playback to return
   * @returns {{ rate: Number, points: Uint16Array, count: Number }} `points`
   *   is a fresh array of `count * POINT_STRIDE` values
   */
  frame(windowMs) {
    // Nothing arriving means nothing lit: the beam goes out with the data.
    if (this.stale()) return { rate: this.rate, points: EMPTY_POINTS, count: 0 };
    const ms = Math.min(Math.max(0, windowMs), MAX_WINDOW_MS);
    const wanted = Math.min(this.count, Math.ceil((this.rate * ms) / 1000));
    const out = new Uint16Array(wanted * POINT_STRIDE);
    // The oldest of the wanted points sits `wanted` behind the write head.
    const start = (((this.head - wanted) % RING_POINTS) + RING_POINTS) % RING_POINTS;
    for (let i = 0; i < wanted; i += 1) {
      const src = ((start + i) % RING_POINTS) * POINT_STRIDE;
      out.set(this.ring.subarray(src, src + POINT_STRIDE), i * POINT_STRIDE);
    }
    return { rate: this.rate, points: out, count: wanted };
  }

  /**
   * Whether the stream has gone quiet.
   *
   * @public
   * @returns {Boolean}
   */
  stale() {
    return !this.lastPush || now() - this.lastPush > LIVE_TIMEOUT_MS;
  }

  /** Drops every point but keeps the last known rate. */
  clear() {
    this.head = 0;
    this.count = 0;
  }
}

class LaserStream {
  constructor() {
    this.buffers = new Map();
    this.unsubscribe = null;
    this.enabled = false;
  }

  /**
   * Tells the DACs which lasers the show holds, so a protocol that names its
   * services offers them under the show's own names.
   *
   * @public
   * @param {Array} services each `{ id, name }`
   */
  publishServices(services) {
    if (!this.available || !window.laser.services) return;
    window.laser.services(services);
  }

  /**
   * Moves every producer stream on to the next laser.
   *
   * @public
   */
  rotateStreams() {
    if (!this.available || !window.laser.rotateStreams) return;
    window.laser.rotateStreams();
  }

  /** Whether a native laser bridge is present (i.e. running under Electron). */
  // eslint-disable-next-line class-methods-use-this
  get available() {
    return typeof window !== 'undefined' && !!window.laser;
  }

  /**
   * Begins accumulating played points from every DAC.
   *
   * The DACs are already listening -- the main process starts them with the
   * app -- so this only subscribes to what they play. Idempotent.
   */
  enable() {
    if (this.enabled) return;
    this.enabled = true;
    if (!this.available) return;
    this.unsubscribe = window.laser.onFrames((batch) => this.push(batch));
  }

  /** Stops accumulating and forgets every buffer. */
  disable() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.buffers.clear();
    this.enabled = false;
  }

  /**
   * Takes one played batch into its protocol's buffer.
   *
   * Public so a test can drive it without `window.laser`.
   *
   * @param {{ protocol: String, rate: Number, points: Uint16Array }} batch
   */
  push(batch) {
    if (!batch || !batch.protocol || !batch.points) return;
    const service = batch.service === undefined ? null : batch.service;
    const key = streamKey(batch.protocol, service);
    let buffer = this.buffers.get(key);
    if (!buffer) {
      buffer = new ProtocolBuffer(batch.protocol, service);
      this.buffers.set(key, buffer);
    }
    buffer.push(batch.rate || 0, batch.points);
  }

  /**
   * The points to draw this frame for one protocol.
   *
   * @param {String} protocol 'etherdream' or 'lasercube'
   * @param {Number} [windowMs] persistence window; defaults to the eye's ~50 ms
   * @returns {{ rate: Number, points: Uint16Array, count: Number }} an empty
   *   frame if that protocol has sent nothing
   */
  frame(protocol, windowMs = 50, service = null) {
    const buffer = this.buffers.get(streamKey(protocol, service));
    if (!buffer) return { rate: 0, points: new Uint16Array(0), count: 0 };
    return buffer.frame(windowMs);
  }

  /**
   * Which protocols have delivered points, and how many.
   *
   * @returns {Array} one `{ protocol, rate, held, live, received }` per buffer
   */
  report() {
    return [...this.buffers].map(([, buffer]) => ({
      protocol: buffer.protocol,
      service: buffer.service,
      rate: buffer.rate,
      // A dead stream holds nothing worth drawing, whatever is still in
      // its ring -- so a fixture picking a source by itself does not settle on
      // one that stopped sending an hour ago.
      held: buffer.stale() ? 0 : buffer.count,
      live: !buffer.stale(),
      received: buffer.received,
    }));
  }
}

export default new LaserStream();
