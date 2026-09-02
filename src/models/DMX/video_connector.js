/**
 * @file A named region of a video feed, and what devices plug into.
 *
 * A video connector is to video what a DMX address is to control: the thing a
 * device is patched to, not the thing it is. Several devices may share one,
 * which is the whole reason it exists as a name in the middle rather than as a
 * rectangle hanging off each consumer -- two projectors doubling the same
 * content is normal, and a rect stored per device cannot express it.
 *
 * It follows the shape MadMapper and Resolume already work in: one canvas
 * arriving over the wire, carved into surfaces. Twelve feeds in a 4K frame is
 * one texture, one upload and twelve rectangles -- see `video_feed.js` for why
 * that matters, and `madmapper interop` for where the rects can come from.
 *
 * **What lives here and what does not.** The rectangle is show data: it
 * describes the design and travels in the `.beam`. The *binding* to a real NDI
 * sender does not -- "DEV1 (MadMapper - Video-Output-1)" is a fact about one
 * machine, and opening the show anywhere else is the normal case, not an edge
 * case. That binding is a setting, and an unbound connector must say so rather
 * than quietly going black.
 */

/** Ids are unique within a run; shows carry their own. */
let nextId = 0;

/** Rotations a connector may apply, in degrees clockwise. */
export const CONNECTOR_ROTATIONS = [0, 90, 180, 270];

/**
 * Shapes worth offering, as width over height in **pixels**.
 *
 * Landscape first, then the portrait ones a hung panel needs, then the wide
 * ones a stage blend or a strip wants. `0` is free.
 */
export const CONNECTOR_ASPECTS = [
  { label: 'Free', value: 0 },
  { label: '16:9', value: 16 / 9 },
  { label: '16:10', value: 16 / 10 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:2', value: 3 / 2 },
  { label: '1:1', value: 1 },
  { label: '9:16', value: 9 / 16 },
  { label: '3:4', value: 3 / 4 },
  { label: '21:9', value: 21 / 9 },
  { label: '32:9', value: 32 / 9 },
];

class VideoConnector {
  /**
   * @param {Object} [data]
   * @param {Number} [data.id]
   * @param {String} [data.name]
   * @param {Object} [data.rect] normalised `{ x, y, width, height }`
   * @param {Number} [data.rotation] 0, 90, 180 or 270
   * @param {Boolean} [data.flipH]
   * @param {Boolean} [data.flipV]
   */
  constructor(data = {}) {
    nextId += 1;
    this._id = data.id === undefined ? nextId : data.id;
    if (this._id >= nextId) nextId = this._id + 1;
    // Named after a socket rather than after the concept. "Connector 3" names
    // the category; "HDMI 3" reads as something you plug a cable into, which
    // is the mental model that makes a projector's Source Select channel
    // explain itself -- a real projector cycles exactly these labels. It is a
    // white lie: the picture arrives over NDI. Paul's call, made knowing that,
    // because the clarity is worth more than the pedantry. Only the default
    // label is a socket; the *concept* stays a connector everywhere else.
    this.name = data.name || `HDMI ${this._id}`;

    // The frame the rectangle was authored against, which is what lets it be
    // written down in pixels. Zero until something has seen a real feed.
    const frame = data.frame || {};
    this.frame = {
      width: Math.max(Math.round(Number(frame.width) || 0), 0),
      height: Math.max(Math.round(Number(frame.height) || 0), 0),
    };

    // Held normalised, with the origin at the picture's top-left -- the corner
    // a user sees, and the one the editor draws from. Normalised is what a
    // sender that switches from 4K to 1080p needs, and that is a mouse click
    // in either MadMapper or Resolume.
    //
    // It is *written down* in pixels of `frame`, though, because percentages
    // cannot say "start at 1650 and take 540 across": a tenth of a percent of
    // a 4K frame is nearly four pixels, so whole numbers in this space simply
    // do not land on pixel boundaries. Storing the frame beside them keeps
    // both -- an exact edge to author against, and a fraction to sample with.
    const rect = data.rect || {};
    const authored = this.frame.width > 0 && this.frame.height > 0;
    this.rect = authored ? {
      x: VideoConnector.clamp(Number(rect.x) / this.frame.width, 0),
      y: VideoConnector.clamp(Number(rect.y) / this.frame.height, 0),
      width: VideoConnector.clamp(Number(rect.width) / this.frame.width, 1),
      height: VideoConnector.clamp(Number(rect.height) / this.frame.height, 1),
    } : {
      x: VideoConnector.clamp(rect.x, 0),
      y: VideoConnector.clamp(rect.y, 0),
      width: VideoConnector.clamp(rect.width, 1),
      height: VideoConnector.clamp(rect.height, 1),
    };

    // A panel hung in portrait is a rotated region of a landscape canvas, not
    // a second feed, so this belongs to the connector rather than the device.
    this.rotation = CONNECTOR_ROTATIONS.includes(data.rotation) ? data.rotation : 0;
    this.flipH = !!data.flipH;
    this.flipV = !!data.flipV;

    // Width over height in **pixels**, not in the normalised space the rect
    // lives in -- see `setRect`, where the difference matters. 0 is free.
    const aspect = Number(data.aspect);
    this.aspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 0;
  }

  get id() { return this._id; }

  /**
   * Keeps a value inside the frame.
   *
   * @param {Number} value
   * @param {Number} fallback used when the value is absent or not a number
   * @returns {Number} 0..1
   */
  static clamp(value, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(Math.max(number, 0), 1);
  }

  /**
   * Moves and resizes, keeping the rectangle inside the frame.
   *
   * Clamped here rather than in the editor because the numeric fields write
   * through this too, and a rectangle that has left the picture samples
   * nothing -- which looks like a broken feed rather than a bad number.
   *
   * @param {Object} rect any of `{ x, y, width, height }`, normalised
   */
  setRect(rect = {}, sourceAspect = 0) {
    const next = { ...this.rect, ...rect };
    // A degenerate rectangle is not a region, and a zero width would divide by
    // zero in whatever samples it.
    next.width = Math.min(Math.max(VideoConnector.clamp(next.width, this.rect.width), 0.001), 1);
    next.height = Math.min(Math.max(VideoConnector.clamp(next.height, this.rect.height), 0.001), 1);

    // A locked shape is a ratio of **pixels**, and this rectangle is a
    // fraction of the frame -- so the two only agree when the source is
    // square. A 16:9 region of a 16:9 frame is a square in normalised space;
    // of a 4:3 frame it is not. Getting this wrong gives a lock that looks
    // right on one sender and skews on the next.
    //
    //   w_px / h_px = (w * W) / (h * H)  =>  w / h = aspect * H / W
    if (this.aspect > 0 && sourceAspect > 0) {
      // Whichever edge the caller moved is the one to keep; the other follows.
      if (rect.height !== undefined && rect.width === undefined) {
        next.width = (next.height * this.aspect) / sourceAspect;
      } else {
        next.height = (next.width * sourceAspect) / this.aspect;
      }
      // Shrunk to fit rather than clipped, so a locked region never silently
      // stops being the shape it claims to be.
      if (next.height > 1) {
        next.height = 1;
        next.width = (next.height * this.aspect) / sourceAspect;
      }
      if (next.width > 1) {
        next.width = 1;
        next.height = (next.width * sourceAspect) / this.aspect;
      }
    }

    next.x = Math.min(VideoConnector.clamp(next.x, this.rect.x), 1 - next.width);
    next.y = Math.min(VideoConnector.clamp(next.y, this.rect.y), 1 - next.height);
    this.rect = next;
  }

  /**
   * The region in pixels of a frame.
   *
   * Rounded, because this is the number a user types and reads back: a slice
   * has to be able to start on pixel 1650 and stay there.
   *
   * @param {Number} [frameWidth] defaults to the frame it was authored against
   * @param {Number} [frameHeight]
   * @returns {Object} `{ x, y, width, height }` in whole pixels
   */
  pixelRect(frameWidth, frameHeight) {
    const width = Number(frameWidth) || this.frame.width;
    const height = Number(frameHeight) || this.frame.height;
    if (!width || !height) return null;
    return {
      x: Math.round(this.rect.x * width),
      y: Math.round(this.rect.y * height),
      width: Math.round(this.rect.width * width),
      height: Math.round(this.rect.height * height),
    };
  }

  /**
   * Moves and resizes in pixels of the frame now arriving.
   *
   * Re-authors against that frame, so the numbers a user last typed are the
   * numbers written down -- and a connector edited against a 1080p sender
   * stops claiming to be a rectangle of a 4K one.
   *
   * @param {Object} patch any of `{ x, y, width, height }`, in pixels
   * @param {Number} frameWidth
   * @param {Number} frameHeight
   */
  setPixelRect(patch = {}, frameWidth = 0, frameHeight = 0) {
    const width = Number(frameWidth) || this.frame.width;
    const height = Number(frameHeight) || this.frame.height;
    if (!width || !height) return;
    const normalised = {};
    if (patch.x !== undefined) normalised.x = patch.x / width;
    if (patch.y !== undefined) normalised.y = patch.y / height;
    if (patch.width !== undefined) normalised.width = patch.width / width;
    if (patch.height !== undefined) normalised.height = patch.height / height;
    // Free, deliberately: a locked aspect is a shape, and a pixel field is a
    // measurement. Letting the lock rewrite the number just typed makes the
    // field feel broken. The lock still governs dragging.
    this.setRect(normalised, 0);
    this.frame = { width, height };
  }

  /**
   * Records the frame a connector is being worked against.
   *
   * @param {Number} width
   * @param {Number} height
   */
  useFrame(width, height) {
    const w = Math.round(Number(width) || 0);
    const h = Math.round(Number(height) || 0);
    if (w > 0 && h > 0) this.frame = { width: w, height: h };
  }

  /**
   * Locks the shape, and reshapes what is there to match.
   *
   * Applied immediately rather than on the next drag: choosing 16:9 and
   * seeing nothing happen reads as a control that does not work.
   *
   * @param {Number} aspect width over height in pixels, 0 for free
   * @param {Number} sourceAspect the frame's own pixel aspect
   */
  setAspect(aspect, sourceAspect = 0) {
    this.aspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 0;
    if (this.aspect > 0) this.setRect({}, sourceAspect);
  }

  /** Cycles to the next quarter turn. */
  rotate() {
    const at = CONNECTOR_ROTATIONS.indexOf(this.rotation);
    this.rotation = CONNECTOR_ROTATIONS[(at + 1) % CONNECTOR_ROTATIONS.length];
  }

  /** True when the quarter turn swaps the output's width and height. */
  get swapsAxes() {
    return this.rotation === 90 || this.rotation === 270;
  }

  /**
   * Where a point of what the device receives lands in the source frame.
   *
   * Output space is the device's own: origin at the top-left of the picture it
   * gets, `u` to the right and `v` down. The answer is in the same normalised,
   * top-left-origin space the rectangle lives in, so it composes with `rect`
   * and nothing else has to know how a quarter turn is expressed.
   *
   * **The order is rotate, then flip**, and that is a decision rather than an
   * accident. A flip is what the viewer sees mirrored, so it is expressed in
   * the output's own axes: ticking Flip H on a panel hung in portrait mirrors
   * it left-to-right *as it hangs*, not left-to-right as the camera shot it.
   * Flipping first would make the same tick mean top-to-bottom on a rotated
   * connector, which is the sort of thing that reads as the control being
   * broken.
   *
   * This is the one place that says what rotation and flip *mean*. The slicing
   * preview is its first caller and a patched device will be its second; two
   * implementations of a quarter turn would disagree the first time one of
   * them was corrected.
   *
   * @param {Number} u 0..1 across the output
   * @param {Number} v 0..1 down the output
   * @returns {Object} `{ x, y }` normalised in the source frame
   */
  sampleAt(u, v) {
    const uf = this.flipH ? 1 - u : u;
    const vf = this.flipV ? 1 - v : v;

    // Turning the region clockwise carries its bottom-left corner to the
    // output's top-left, so an output row reads *down* a source column.
    let sx = uf;
    let sy = vf;
    if (this.rotation === 90) {
      sx = vf;
      sy = 1 - uf;
    } else if (this.rotation === 180) {
      sx = 1 - uf;
      sy = 1 - vf;
    } else if (this.rotation === 270) {
      sx = 1 - vf;
      sy = uf;
    }

    return {
      x: this.rect.x + sx * this.rect.width,
      y: this.rect.y + sy * this.rect.height,
    };
  }

  /**
   * The shape of what the device receives, width over height in **pixels**.
   *
   * Not the same as the region's shape: a quarter turn transposes it, which is
   * the whole reason a portrait panel can be fed from a landscape canvas.
   *
   * @param {Number} sourceAspect the frame's own pixel aspect
   * @returns {Number} 0 when the frame's shape is not known yet
   */
  outputAspect(sourceAspect) {
    if (!(sourceAspect > 0) || !this.rect.height) return 0;
    const region = (this.rect.width * sourceAspect) / this.rect.height;
    return this.swapsAxes ? 1 / region : region;
  }

  /**
   * What the device receives, in pixels of the source.
   *
   * Rounded, because it is a readout rather than an allocation -- and a region
   * is a fraction of a frame, so its edges rarely land on whole pixels.
   *
   * @param {Number} frameWidth
   * @param {Number} frameHeight
   * @returns {Object} `{ width, height }`
   */
  outputSize(frameWidth, frameHeight) {
    const width = Math.round(this.rect.width * frameWidth);
    const height = Math.round(this.rect.height * frameHeight);
    return this.swapsAxes
      ? { width: height, height: width }
      : { width, height };
  }

  get showData() {
    return {
      id: this._id,
      name: this.name,
      // Flattened rather than spread: a connector held on the reactive show is
      // a Vue Proxy, and `structuredClone` refuses one when the show crosses
      // IPC to be written. `object.model.js` documents the same trap.
      // In pixels once a real frame has been seen, and as fractions before
      // that. `frame` says which, so a show written either way reads back the
      // same -- and one written before this existed still loads.
      rect: this.pixelRect() || {
        x: this.rect.x,
        y: this.rect.y,
        width: this.rect.width,
        height: this.rect.height,
      },
      frame: { width: this.frame.width, height: this.frame.height },
      rotation: this.rotation,
      flipH: this.flipH,
      flipV: this.flipV,
      aspect: this.aspect,
    };
  }
}

export default VideoConnector;
