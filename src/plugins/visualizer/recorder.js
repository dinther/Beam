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
 * The same list for a take that carries sound.
 *
 * A mime type naming only a video codec does not promise the muxer will accept
 * an audio track, so the audio codec is named too. AAC (`mp4a.40.2`) is the
 * pairing that plays everywhere H.264 does. Probed in Electron 41.7.1
 * (Chromium 146): `avc1.640028,mp4a.40.2`, `avc1.42E01E,mp4a.40.2` and
 * `avc1.640028,opus` are all supported; `mp4a.67` is not.
 *
 * @constant {Array<String>}
 */
const CODECS_WITH_AUDIO = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1.640028,opus',
  'video/mp4',
  'video/webm;codecs=h264,opus',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

/**
 * Bits per second for the sound.
 *
 * 192k stereo AAC is transparent enough for a room recording and costs about
 * 1.4 MB a minute, which is noise beside the video.
 *
 * @constant {Number}
 */
const AUDIO_BITRATE = 192000;

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
 * @param {Boolean} [withAudio] whether the take carries an audio track
 * @returns {String|null} a mime type, or null when none can be recorded
 */
function pickMimeType(withAudio = false) {
  if (typeof MediaRecorder === 'undefined') return null;
  const list = withAudio ? CODECS_WITH_AUDIO : CODECS;
  return list.find((type) => MediaRecorder.isTypeSupported(type)) || null;
}

/**
 * The desktop audio mix, as a single track.
 *
 * `getDisplayMedia` is the only route to system audio, and it will not hand
 * back audio without also starting a screen capture -- so the video track it
 * returns is stopped immediately and thrown away. Main has to answer the
 * request with `audio: 'loopback'` for any of this to arrive; see
 * `setupDesktopAudio` in `main.js`.
 *
 * The constraints are not decoration. Left to itself the loopback device comes
 * up as MONO with echo cancellation, noise suppression and automatic gain all
 * enabled -- sensible for a voice call and ruinous for music, which pumps under
 * AGC and smears under noise suppression. Measured: asking for these turns all
 * three off and gives stereo.
 *
 * @returns {Promise<MediaStreamTrack|null>} the audio track, or null
 */
async function captureDesktopAudio() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return null;
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: {
      autoGainControl: false,
      echoCancellation: false,
      noiseSuppression: false,
      channelCount: 2,
      sampleRate: 48000,
    },
  });
  stream.getVideoTracks().forEach((track) => track.stop());
  const [audio] = stream.getAudioTracks();
  if (!audio) return null;
  return audio;
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
   * @param {Boolean} [options.audio] record the desktop audio mix as well
   */
  constructor({
    canvas, fps, quality, name, documentPath, audio,
  }) {
    this.canvas = canvas;
    this.fps = fps;
    this.quality = quality;
    this.name = name;
    this.documentPath = documentPath || null;
    this.wantsAudio = !!audio;
    /** The desktop audio track, when one was captured. */
    this.audioTrack = null;

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
    if (!window.videoRecorder) return { ok: false, error: 'Recording is unavailable' };

    // Ask for the sound BEFORE opening the file, so a refused capture does not
    // leave an empty take on disk. A failure here is not fatal: the take still
    // has a picture, and silently recording video is better than recording
    // nothing because the audio device was busy.
    if (this.wantsAudio) {
      try {
        this.audioTrack = await captureDesktopAudio();
        if (!this.audioTrack) this.audioNote = 'No desktop audio device was available';
      } catch (err) {
        this.audioNote = `Desktop audio was not captured: ${err.message}`;
        console.warn(`[recorder] ${this.audioNote}`);
      }
    }
    const withAudio = !!this.audioTrack;

    const mimeType = pickMimeType(withAudio);
    if (!mimeType) {
      if (this.audioTrack) this.audioTrack.stop();
      return { ok: false, error: 'This build cannot record video' };
    }

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
      // One stream carries both, so the muxer interleaves them and the file
      // needs no post-processing to be in sync.
      if (this.audioTrack) this.stream.addTrack(this.audioTrack);
      this.recorder = new MediaRecorder(this.stream, {
        mimeType,
        videoBitsPerSecond: bitrateFor(width, height, this.fps, this.quality),
        ...(withAudio ? { audioBitsPerSecond: AUDIO_BITRATE } : {}),
      });
    } catch (err) {
      // The file is open and nothing will be written to it, so it goes rather
      // than being left as an empty take.
      if (this.audioTrack) this.audioTrack.stop();
      this.audioTrack = null;
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
    console.log(`[recorder] ${width}x${height} @ ${this.fps} fps, ${mimeType}`
      + `${withAudio ? ' + desktop audio' : ''} -> ${this.path}`);
    return {
      ok: true, path: this.path, audio: withAudio, note: this.audioNote || null,
    };
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

    // The audio track was added to this stream, so this stops it too.
    this.stream.getTracks().forEach((track) => track.stop());
    this.audioTrack = null;
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
  Recording, QUALITY, FRAME_RATES, pickMimeType, bitrateFor, captureDesktopAudio,
};
