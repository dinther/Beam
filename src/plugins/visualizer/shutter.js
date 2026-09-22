/**
 * @file What a lamp is doing between two drawn frames.
 *
 * A strobe flashes for a millisecond and the visualizer draws a frame every
 * sixteen. Sampling the lamp at the instant of the frame misses most flashes
 * and beats against the ones it catches: a 25 Hz strobe sampled at 60 fps
 * comes out as an irregular flicker that has nothing to do with the rate set.
 *
 * So the frame is treated as an interval, not an instant. Every flash that
 * fell inside the interval lights the frame, and a pulse longer than a frame
 * lights each frame by the fraction of it the pulse covers. The frame's level
 * is the sum, clamped to one. At any rate the number of lit frames per second
 * is the rate, the average brightness follows the duty cycle, and nothing
 * beats.
 *
 * One model for every lamp with a shutter: a strobe's flash train and a moving
 * head's shutter channel are the same thing at different rates. Pure -- no
 * three, no scene -- so a test can run it at 60 fps against every rate.
 */

/**
 * The ways a lamp can be run.
 *
 * Named for what the light does, not for OFL's channel vocabulary, which
 * `modeFromEffect` translates from.
 *
 * @constant {Object}
 */
export const SHUTTER_MODES = {
  /** Dark. */
  OFF: 'off',
  /** Steady on: an open shutter, or a strobe used as a blinder. */
  ON: 'on',
  /** Regular flashes at the rate. */
  STROBE: 'strobe',
  /** Flashes at the rate on average, irregularly spaced. */
  RANDOM: 'random',
  /** Bursts of a few uneven flashes, with a pause between bursts. */
  LIGHTNING: 'lightning',
  /** Brightness climbs over each cycle and snaps off. */
  RAMP_UP: 'rampUp',
  /** Snaps on and fades over each cycle. */
  RAMP_DOWN: 'rampDown',
  /** Rises and falls smoothly over each cycle. */
  PULSE: 'pulse',
};

/** Every mode, in the order a list offers them. */
export const SHUTTER_MODE_ORDER = [
  SHUTTER_MODES.OFF,
  SHUTTER_MODES.ON,
  SHUTTER_MODES.STROBE,
  SHUTTER_MODES.RANDOM,
  SHUTTER_MODES.LIGHTNING,
  SHUTTER_MODES.RAMP_UP,
  SHUTTER_MODES.RAMP_DOWN,
  SHUTTER_MODES.PULSE,
];

/** What each mode is called on screen. */
export const SHUTTER_MODE_LABELS = {
  [SHUTTER_MODES.OFF]: 'Off',
  [SHUTTER_MODES.ON]: 'On',
  [SHUTTER_MODES.STROBE]: 'Strobe',
  [SHUTTER_MODES.RANDOM]: 'Random',
  [SHUTTER_MODES.LIGHTNING]: 'Lightning',
  [SHUTTER_MODES.RAMP_UP]: 'Ramp up',
  [SHUTTER_MODES.RAMP_DOWN]: 'Ramp down',
  [SHUTTER_MODES.PULSE]: 'Pulse',
};

/**
 * The OFL ShutterStrobe effect each mode is written out as, so a generated
 * profile reads correctly on a patch sheet and a library profile maps back.
 *
 * @constant {Object}
 */
export const SHUTTER_MODE_EFFECTS = {
  [SHUTTER_MODES.OFF]: 'Closed',
  [SHUTTER_MODES.ON]: 'Open',
  [SHUTTER_MODES.STROBE]: 'Strobe',
  [SHUTTER_MODES.RANDOM]: 'Strobe',
  [SHUTTER_MODES.LIGHTNING]: 'Lightning',
  [SHUTTER_MODES.RAMP_UP]: 'RampUp',
  [SHUTTER_MODES.RAMP_DOWN]: 'RampDown',
  [SHUTTER_MODES.PULSE]: 'RampUpDown',
};

/**
 * The longest interval one frame may stand for, in seconds.
 *
 * A hidden tab or a stalled renderer would otherwise hand the next frame a
 * second's worth of flashes to catch up on, all at once.
 *
 * @constant {Number}
 */
export const MAX_FRAME_SECONDS = 0.1;

/** A frame shorter than this is a clock glitch, not a frame. */
const MIN_FRAME_SECONDS = 1e-4;

/**
 * How many flashes one frame is allowed to schedule.
 *
 * A rate of thousands is a typing error, not a request, and a loop that
 * honoured it would spin.
 *
 * @constant {Number}
 */
const MAX_FLASHES_PER_FRAME = 64;

/**
 * How unevenly random flashes are spaced, as a range of multiples of the mean
 * interval. Uniform on this range keeps the mean at one over the rate, and
 * keeps two flashes from ever landing on top of each other.
 */
const RANDOM_SPREAD_MIN = 0.3;
const RANDOM_SPREAD_MAX = 1.7;

/** A lightning burst: how many strokes, and how far apart, in seconds. */
const LIGHTNING_STROKES_MIN = 2;
const LIGHTNING_STROKES_MAX = 5;
const LIGHTNING_GAP_MIN = 0.02;
const LIGHTNING_GAP_MAX = 0.06;

/** Millisecond duration channel to seconds. */
const MS = 0.001;

/**
 * Where the frames that matter are counted, when it is not the display.
 *
 * A recording at a rate below the display's takes one rendered frame per
 * slot of its own clock. A flash lit for one rendered frame then lands on the
 * frame the recorder takes or on the one it skips, and with both grids locked
 * to the display it is the same answer every time -- measured on a 30 fps
 * take of a 15 Hz strobe: 4 lit frames where 159 were due. So while a take
 * runs, every lamp holds its state until the recorder's slot changes, and the
 * rendered frame the recorder takes carries the flashes of the slot before
 * it.
 *
 * The clock answers with the slot's own start time, and that is what the
 * lamp's interval ends at -- not the time of the rendered frame that first
 * saw the new slot. The display is not at exactly 60 Hz, so that frame's
 * place inside the slot wanders, and intervals ended there wander with it:
 * measured as a flash slipping one slot late every few seconds, dimmed by
 * the longer interval it was spread over. Ended at the slot boundaries, the
 * intervals are the slots, whatever the display does.
 *
 * Null when the display's own frames are the ones that count.
 *
 * @type {Function|null} `() => { index, seconds }|null`, the current slot
 *   and when it began, in the clock's own seconds
 */
let slotClock = null;

/**
 * A jump in the sampled time larger than this, either way, is a change of
 * clock rather than a long frame: the recorder's seconds and the scene's
 * seconds have different zeros. The train restarts from the new time.
 *
 * @constant {Number}
 */
const CLOCK_JUMP_SECONDS = 1;

/**
 * The lamp's behaviour over time, sampled once per drawn frame.
 */
export default class Shutter {
  /**
   * @param {Object} [options]
   * @param {Function} [options.random] a `() => 0..1` source, so a test can
   *   seed one and a scene can leave it at `Math.random`
   */
  constructor({ random = Math.random } = {}) {
    this._random = random;
    this.mode = SHUTTER_MODES.OFF;
    /** Flashes or cycles per second. */
    this.rate = 0;
    /** How long each flash lasts, in milliseconds. Zero is a bare flash. */
    this.duration = 0;
    /** When the last frame ended. Null until the first sample. */
    this._last = null;
    /** When the next scheduled flash is due. */
    this._next = 0;
    /**
     * The regular strobe's grid: flashes fall at `origin + count / rate`,
     * counted rather than accumulated, so a thousand additions of a sixtieth
     * cannot drift a flash onto the wrong frame.
     */
    this._gridOrigin = 0;
    this._gridCount = 0;
    this._gridRate = 0;
    /** Pulses started and not yet finished: `{ start, end }` in seconds. */
    this._pulses = [];
    /** Strokes still to come in the current lightning burst. */
    this._strokesLeft = 0;
    /** Single flashes asked for since the last frame. */
    this._pending = 0;
    /** The last level handed out. */
    this._level = 0;
    /** How long the last sampled frame was, in seconds. */
    this._frame = 1 / 60;
    /** Whether the last level came from flashes rather than a steady lamp. */
    this._pulsed = false;
    /** The recorder slot the last frame was sampled in, when there is one. */
    this._slot = null;
  }

  /**
   * Makes every lamp step on a recorder's frame slots, or on the display's
   * frames again.
   *
   * @public
   * @param {Function|null} clock `() => { index, seconds }|null`: the slot
   *   the recorder is in and when it began, in the recorder's own seconds
   */
  static setSlotClock(clock) {
    slotClock = typeof clock === 'function' ? clock : null;
  }

  /**
   * The level the last sampled frame was lit at, 0..1.
   *
   * @readonly
   * @type {Number}
   */
  get level() { return this._level; }

  /**
   * How long the last sampled frame stood for, in seconds, within the bounds
   * `sample` clamps to. What a flash's energy is spread over.
   *
   * @readonly
   * @type {Number}
   */
  get frameSeconds() { return this._frame; }

  /**
   * Whether the last level was made of flashes -- a strobe train or a single
   * fire -- rather than a lamp held on or ramped. A flash tube's brightness
   * depends on the answer: a flash is a capacitor's charge in an instant, a
   * held lamp is its supply's average.
   *
   * @readonly
   * @type {Boolean}
   */
  get pulsed() { return this._pulsed; }

  /**
   * Asks for one flash, whatever the mode. It lands in the next frame sampled.
   *
   * @public
   */
  fire() { this._pending += 1; }

  /**
   * How lit the frame ending now is, 0..1.
   *
   * The frame is the interval from the previous sample to this one. Called once
   * per drawn frame with the scene clock; calling it twice for one frame counts
   * the second call as a frame of no length, which is harmless and lights
   * nothing new.
   *
   * @public
   * @param {Number} now seconds
   * @returns {Number}
   */
  sample(now) {
    let end = Number(now) || 0;
    let slotLength = 0;
    if (slotClock) {
      const slot = slotClock();
      if (slot) {
        // Inside the slot already sampled: this rendered frame is a copy of
        // the last, and the recorder will take one of the two.
        if (slot.index === this._slot) return this._level;
        this._slot = slot.index;
        // The interval ends where the slot begins, in the recorder's seconds.
        end = slot.seconds;
        slotLength = Number(slot.length) || 0;
      }
    } else {
      this._slot = null;
    }
    // A different clock: the recorder's took over, or handed back. What was
    // scheduled is in the old clock's seconds and means nothing now.
    if (this._last !== null && Math.abs(end - this._last) > CLOCK_JUMP_SECONDS) {
      this._last = null;
      this._pulses = [];
    }
    if (this._last === null) {
      // The first frame is taken as a nominal one rather than as nothing: a
      // train anchored on a frame of no length would sit on a boundary. On a
      // recorder's clock the nominal frame is a whole slot, so the first
      // frame taken is lit like every other and not by a flash squeezed into
      // a sixtieth.
      if (slotLength > 0) this._frame = slotLength;
      this._last = end - this._frame;
      // The first flash falls at once, so a strobe that is switched on flashes
      // rather than waiting out a whole interval in the dark.
      this._next = end;
    }
    let start = this._last;
    if (end - start > MAX_FRAME_SECONDS) start = end - MAX_FRAME_SECONDS;
    if (end - start < MIN_FRAME_SECONDS) start = end - MIN_FRAME_SECONDS;
    this._last = end;
    this._frame = end - start;

    let level;
    let pulsed = false;
    switch (this.mode) {
      case SHUTTER_MODES.ON:
        level = 1;
        this.dropSchedule(end);
        break;
      case SHUTTER_MODES.RAMP_UP:
      case SHUTTER_MODES.RAMP_DOWN:
      case SHUTTER_MODES.PULSE:
        level = this.envelope(end);
        this.dropSchedule(end);
        break;
      case SHUTTER_MODES.STROBE:
      case SHUTTER_MODES.RANDOM:
      case SHUTTER_MODES.LIGHTNING:
        // A flashing mode with no rate has nothing to flash at: steady on,
        // the same rule as a ramp. It is what a mover's shutter does when its
        // strobe channel is selected with the speed at zero.
        if (this.interval() <= 0) {
          level = 1;
          this.dropSchedule(end);
          break;
        }
        this.schedule(start, end);
        level = this.coverage(start, end);
        pulsed = true;
        break;
      case SHUTTER_MODES.OFF:
      default:
        level = 0;
        this.dropSchedule(end);
        break;
    }

    // A single flash lands whatever the mode, on top of it.
    if (this._pending > 0) {
      this._pulses.push({ start, end: start + this.flashSeconds() });
      this._pending = 0;
      const flash = this.coverage(start, end);
      if (flash > level) {
        level = flash;
        pulsed = true;
      }
    }
    this._pulsed = pulsed;

    this._level = Math.min(Math.max(level, 0), 1);
    return this._level;
  }

  /**
   * Forgets the flash train, so that the next flashing mode starts clean and
   * flashes at once rather than catching up.
   *
   * @private
   * @param {Number} now
   */
  dropSchedule(now) {
    this._next = now;
    this._strokesLeft = 0;
    // A pulse already under way is kept: a single flash asked for during a
    // ramp must not be cut short by the ramp.
    this._pulses = this._pulses.filter((pulse) => pulse.end > now);
  }

  /**
   * How long one flash lasts, in seconds.
   *
   * @private
   * @returns {Number}
   */
  flashSeconds() {
    return Math.max(Number(this.duration) || 0, 0) * MS;
  }

  /**
   * The mean interval between flashes, or zero when the lamp is not flashing.
   *
   * @private
   * @returns {Number}
   */
  interval() {
    const rate = Number(this.rate) || 0;
    return rate > 0 ? 1 / rate : 0;
  }

  /**
   * Starts every flash due inside the frame.
   *
   * @private
   * @param {Number} start frame start, seconds
   * @param {Number} end frame end, seconds
   */
  schedule(start, end) {
    const mean = this.interval();
    if (mean <= 0) {
      this._next = end;
      return;
    }
    // A schedule left behind -- the rate was zero, the mode was off -- resumes
    // now rather than pouring every missed flash into this frame.
    if (this._next < start) this._next = start;

    const flashLength = this.flashSeconds();
    let guard = 0;
    if (this.mode === SHUTTER_MODES.STROBE) {
      // A new grid whenever the rate changes or the train was interrupted,
      // anchored half a frame past the flash that is due next. A train
      // anchored on a frame time puts every flash of a rate that divides the
      // frame rate exactly on a frame boundary, where clock jitter decides
      // which frame gets it and a recording shows uneven gaps. Half a frame in,
      // each flash sits squarely inside its frame.
      if (this._gridRate !== mean || this._gridOrigin + this._gridCount * mean !== this._next) {
        this._gridOrigin = this._next + (end - start) / 2;
        this._gridCount = 0;
        this._gridRate = mean;
        this._next = this._gridOrigin;
      }
      while (this._next < end && guard < MAX_FLASHES_PER_FRAME) {
        guard += 1;
        this._pulses.push({ start: this._next, end: this._next + flashLength });
        this._gridCount += 1;
        this._next = this._gridOrigin + this._gridCount * mean;
      }
      return;
    }
    while (this._next < end && guard < MAX_FLASHES_PER_FRAME) {
      guard += 1;
      this._pulses.push({ start: this._next, end: this._next + flashLength });
      this._next += this.nextGap(mean);
    }
  }

  /**
   * How long after this flash the next one comes, in seconds.
   *
   * @private
   * @param {Number} mean one over the rate
   * @returns {Number}
   */
  nextGap(mean) {
    switch (this.mode) {
      case SHUTTER_MODES.RANDOM:
        return this.unevenGap(mean);
      case SHUTTER_MODES.LIGHTNING: {
        // Within a burst the strokes come fast; between bursts the rate sets
        // the pause, as unevenly as a random strobe's.
        if (this._strokesLeft > 0) {
          this._strokesLeft -= 1;
          return LIGHTNING_GAP_MIN + (LIGHTNING_GAP_MAX - LIGHTNING_GAP_MIN) * this._random();
        }
        this._strokesLeft = LIGHTNING_STROKES_MIN
          + Math.floor((LIGHTNING_STROKES_MAX - LIGHTNING_STROKES_MIN + 1) * this._random()) - 1;
        return this.unevenGap(mean);
      }
      case SHUTTER_MODES.STROBE:
      default:
        return mean;
    }
  }

  /**
   * A gap around the mean, drawn uniformly from the random spread.
   *
   * @private
   * @param {Number} mean seconds
   * @returns {Number}
   */
  unevenGap(mean) {
    const spread = RANDOM_SPREAD_MIN + (RANDOM_SPREAD_MAX - RANDOM_SPREAD_MIN) * this._random();
    return mean * spread;
  }

  /**
   * How much of the frame the pulses light, 0..1, and drops the pulses that
   * are over.
   *
   * A flash shorter than the frame lights the whole frame it started in: a
   * millisecond of xenon is seen as a lit frame, not as a sixteenth of one.
   * Splitting it across two frames by where it straddled the boundary would
   * turn one bright frame into two dim ones. A pulse longer than the frame is
   * measured properly, by how much of the frame it covers.
   *
   * @private
   * @param {Number} start frame start, seconds
   * @param {Number} end frame end, seconds
   * @returns {Number}
   */
  coverage(start, end) {
    const frame = end - start;
    let lit = 0;
    const remaining = [];
    for (let i = 0; i < this._pulses.length; i += 1) {
      const pulse = this._pulses[i];
      const length = pulse.end - pulse.start;
      if (length <= frame) {
        // Counted once, in the frame it began in. One that began before this
        // frame was counted already, or was missed by a stalled clock, and is
        // dropped either way.
        if (pulse.start >= start && pulse.start < end) lit += 1;
        if (pulse.start >= end) remaining.push(pulse);
      } else {
        const overlap = Math.min(pulse.end, end) - Math.max(pulse.start, start);
        if (overlap > 0) lit += overlap / frame;
        if (pulse.end > end) remaining.push(pulse);
      }
    }
    this._pulses = remaining;
    return Math.min(lit, 1);
  }

  /**
   * The ramp modes' brightness at an instant, from where the clock is in the
   * cycle.
   *
   * @private
   * @param {Number} now seconds
   * @returns {Number}
   */
  envelope(now) {
    const rate = Number(this.rate) || 0;
    // A ramp with no rate has nowhere to go: steady on, which is what the
    // lamp does when its speed channel is at zero.
    if (rate <= 0) return 1;
    const phase = (((now * rate) % 1) + 1) % 1;
    switch (this.mode) {
      case SHUTTER_MODES.RAMP_UP: return phase;
      case SHUTTER_MODES.RAMP_DOWN: return 1 - phase;
      case SHUTTER_MODES.PULSE:
      default: return 0.5 - 0.5 * Math.cos(2 * Math.PI * phase);
    }
  }

  /**
   * The mode an OFL ShutterStrobe capability asks for.
   *
   * @public
   * @param {String} effect OFL `shutterEffect`: Open, Closed, Strobe, Pulse,
   *   RampUp, RampDown, RampUpDown, Lightning, Spikes, Burst
   * @param {Boolean} [randomTiming] OFL's flag for irregular spacing
   * @returns {String} one of {@link SHUTTER_MODES}
   */
  static modeFromEffect(effect, randomTiming = false) {
    switch (effect) {
      case 'Open': return SHUTTER_MODES.ON;
      case 'Closed': return SHUTTER_MODES.OFF;
      case 'Lightning': return SHUTTER_MODES.LIGHTNING;
      case 'RampUp': return SHUTTER_MODES.RAMP_UP;
      case 'RampDown': return SHUTTER_MODES.RAMP_DOWN;
      case 'RampUpDown':
      case 'Pulse': return SHUTTER_MODES.PULSE;
      case 'Strobe':
      case 'Spikes':
      case 'Burst':
      default:
        return randomTiming ? SHUTTER_MODES.RANDOM : SHUTTER_MODES.STROBE;
    }
  }
}
