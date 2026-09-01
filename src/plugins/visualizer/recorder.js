/**
 * Canvas recording: codec, bitrate, and the pump that keeps nothing in memory.
 *
 * The visualizer's canvas is the source. `Visualizer.beginRecordingFrame` has
 * already fixed its drawing buffer at the requested size, so `captureStream`
 * yields exactly those pixels -- this module never resizes anything.
 *
 * Chunks go straight to the main process as they encode. That is what makes a
 * take unlimited: `MediaRecorder` with no timeslice holds the whole recording
 * as one Blob until it stops, which for anything past a couple of minutes is
 * hundreds of megabytes of renderer heap.
 */

/**
 * Container and codec, most wanted first.
 *
 * H.264 in MP4 is what plays everywhere without transcoding -- players,
 * editors, and every social upload. Probed in Electron 41.7.1 (Chromium 146):
 * `avc1.640028` (High 4.0) and `avc1.42E01E` (Baseline 3.0) are both supported,
 * as is bare `video/mp4`. The WebM entries are a floor, not a preference: they
 * exist so a Chromium that ever drops proprietary codecs records something
 * rather than throwing.
 *
 * The level digits are a *request*, and Chromium overrides them from the frame
 * size in both directions -- measured: asking for High 4.0 at 1280 x 720 wrote
 * `avcC` profile 0x64 level 31, which is High 3.1. So the level here neither
 * caps the frame size nor guarantees a floor; it only picks the profile.
 *
 * @constant {Array<String>}
 */
const CODECS = [
  'video/mp4;codecs=avc1.640028',
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
  'video/webm;codecs=h264',
  'video/webm;codecs=vp9',
  'video/webm',
];

/**
 * Quality as bits per pixel per frame.
 *
 * Expressed this way rather than as a bitrate because a bitrate that suits
 * 1080p is starvation at 4K and waste at 720p, and the user sets the frame size
 * separately. Multiply by width x height x fps for the number handed to the
 * encoder.
 *
 * The values are high for their names: a beam show is hard to encode -- large
 * smooth gradients, high contrast, haze that moves every pixel every frame --
 * and it bands early where footage of a room would not.
 *
 * @constant {Object}
 */
const QUALITY = {
  low: { label: 'Low', bpp: 0.10 },
  medium: { label: 'Medium', bpp: 0.18 },
  high: { label: 'High', bpp: 0.30 },
  maximum: { label: 'Maximum', bpp: 0.50 },
};

/** Frame rates offered. 24 is the film cadence; 60 matches the visualizer. */
const FRAME_RATES = [24, 25, 30, 50, 60];

/**
 * How often encoded bytes are handed over, in milliseconds.
 *
 * Short enough that a crash loses little and memory never builds, long enough
 * that the IPC round trip is not a per-frame cost. At 60 fps this is one
 * message per 30 frames.
 */
const CHUNK_MS = 500;

/**
 * The best container and codec this build actually supports.
 *
 * @returns {String|null} a mime type, or null when none can be recorded
 */
function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  return CODECS.find((type) => MediaRecorder.isTypeSupported(type)) || null;
}

/**
 * Bits per second for a frame size, rate and quality.
 *
 * @param {Number} width pixels
 * @param {Number} height pixels
 * @param {Number} fps frames per second
 * @param {String} quality key into `QUALITY`
 * @returns {Number} bits per second, rounded
 */
function bitrateFor(width, height, fps, quality) {
  const { bpp } = QUALITY[quality] || QUALITY.medium;
  return Math.round(width * height * fps * bpp);
}

/**
 * One recording, from the canvas to a file.
 *
 * Not a singleton: it holds the state of a take, and a take that has stopped
 * should not be able to answer questions about the next one.
 */
class Recording {
  /**
   * @param {Object} options
   * @param {HTMLCanvasElement} options.canvas source, already at record size
   * @param {Number} options.fps frames per second
   * @param {String} options.quality key into `QUALITY`
   * @param {String} options.name project name the file is called after
   * @param {String|null} options.documentPath the show's path, when saved
   */
  constructor({
    canvas, fps, quality, name, documentPath,
  }) {
    this.canvas = canvas;
    this.fps = fps;
    this.quality = quality;
    this.name = name;
    this.documentPath = documentPath || null;

    this.id = null;
    this.path = null;
    this.stream = null;
    this.recorder = null;
    this.error = null;
    this.bytes = 0;
    this.startedAt = 0;
    /**
     * Chunks are written one after another, never concurrently.
     *
     * `ondataavailable` fires on a timer and does not wait for the previous
     * write to be acknowledged, so two chunks can be in flight at once -- and
     * IPC does not promise they arrive in the order they were sent. Out of
     * order they would interleave inside the file and corrupt it. Every write
     * is queued behind the last.
     */
    this.queue = Promise.resolve();
    this.pending = 0;
  }

  /** @returns {Number} seconds elapsed, 0 before it starts */
  get elapsed() {
    return this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0;
  }

  /**
   * Opens the file and starts encoding.
   *
   * @returns {Promise<Object>} `{ ok, path }` or `{ ok: false, error }`
   */
  async start() {
    const mimeType = pickMimeType();
    if (!mimeType) return { ok: false, error: 'This build cannot record video' };
    if (!window.videoRecorder) return { ok: false, error: 'Recording is unavailable' };

    const opened = await window.videoRecorder.begin({
      name: this.name,
      documentPath: this.documentPath,
    });
    if (!opened || !opened.ok) {
      return { ok: false, error: (opened && opened.error) || 'Could not open the file' };
    }
    this.id = opened.id;
    this.path = opened.path;

    const { width, height } = this.canvas;
    try {
      this.stream = this.canvas.captureStream(this.fps);
      this.recorder = new MediaRecorder(this.stream, {
        mimeType,
        videoBitsPerSecond: bitrateFor(width, height, this.fps, this.quality),
      });
    } catch (err) {
      // The file is open and nothing will be written to it, so it goes rather
      // than being left as an empty take.
      await window.videoRecorder.abort(this.id);
      this.id = null;
      return { ok: false, error: `Could not start the encoder: ${err.message}` };
    }

    this.recorder.ondataavailable = (event) => this.push(event.data);
    this.recorder.onerror = (event) => {
      this.error = (event.error && event.error.message) || 'The encoder failed';
      console.error(`[recorder] ${this.error}`);
    };

    this.recorder.start(CHUNK_MS);
    this.startedAt = Date.now();
    this.mimeType = mimeType;
    console.log(`[recorder] ${width}x${height} @ ${this.fps} fps, ${mimeType} -> ${this.path}`);
    return { ok: true, path: this.path };
  }

  /**
   * Hands one encoded chunk to the main process, in order.
   *
   * @private
   * @param {Blob} blob encoded bytes
   */
  push(blob) {
    if (!blob || !blob.size || this.id === null) return;
    this.pending += 1;
    this.queue = this.queue
      .then(async () => {
        if (this.id === null) return;
        const buffer = await blob.arrayBuffer();
        const result = await window.videoRecorder.write(this.id, buffer);
        if (result && result.ok) {
          this.bytes = result.bytes;
        } else if (!this.error) {
          this.error = (result && result.error) || 'The recording could not be written';
          console.error(`[recorder] ${this.error}`);
        }
      })
      .catch((err) => {
        if (!this.error) this.error = err.message;
      })
      .finally(() => { this.pending -= 1; });
  }

  /**
   * Stops encoding and closes the file.
   *
   * Waits for the queue, because `MediaRecorder.stop` emits one last chunk and
   * closing the file before it lands truncates the recording -- an MP4 missing
   * its tail will not play at all.
   *
   * @returns {Promise<Object>} `{ ok, path, bytes }` or `{ ok: false, error }`
   */
  async stop() {
    if (!this.recorder) return { ok: false, error: 'Not recording' };

    const finished = new Promise((resolve) => {
      this.recorder.onstop = resolve;
    });
    try {
      if (this.recorder.state !== 'inactive') this.recorder.stop();
    } catch (err) {
      console.error(`[recorder] stop failed: ${err.message}`);
    }
    await finished;
    // The last `ondataavailable` fires before `onstop`, so its write is on the
    // queue by now; awaiting the queue awaits it too.
    await this.queue;

    this.stream.getTracks().forEach((track) => track.stop());
    const { id } = this;
    this.id = null;
    this.recorder = null;
    this.stream = null;

    if (this.error) {
      await window.videoRecorder.abort(id);
      return { ok: false, error: this.error };
    }
    const closed = await window.videoRecorder.end(id);
    if (!closed || !closed.ok) {
      return { ok: false, error: (closed && closed.error) || 'The file could not be closed' };
    }
    return { ok: true, path: closed.path, bytes: closed.bytes };
  }
}

export default {
  Recording, QUALITY, FRAME_RATES, pickMimeType, bitrateFor,
};
