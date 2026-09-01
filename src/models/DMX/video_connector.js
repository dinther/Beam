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
    this.name = data.name || `Connector ${this._id}`;

    // Normalised, with the origin at the picture's top-left -- the corner a
    // user sees, and the one the editor draws from. Storing pixels would tie
    // a show to the resolution it was built against, and a sender that
    // switches from 4K to 1080p is a mouse click in either MadMapper or
    // Resolume.
    const rect = data.rect || {};
    this.rect = {
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

  get showData() {
    return {
      id: this._id,
      name: this.name,
      // Flattened rather than spread: a connector held on the reactive show is
      // a Vue Proxy, and `structuredClone` refuses one when the show crosses
      // IPC to be written. `object.model.js` documents the same trap.
      rect: {
        x: this.rect.x,
        y: this.rect.y,
        width: this.rect.width,
        height: this.rect.height,
      },
      rotation: this.rotation,
      flipH: this.flipH,
      flipV: this.flipV,
      aspect: this.aspect,
    };
  }
}

export default VideoConnector;
