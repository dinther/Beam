/* eslint-disable no-console */
import {
  Output, Mp4OutputFormat, StreamTarget, CanvasSource, MediaStreamAudioTrackSource,
  canEncodeVideo, getFirstEncodableAudioCodec,
} from 'mediabunny';
import Shutter from './shutter';

/**
 * @file Canvas recording: WebCodecs encoders, an MP4 written as a movie file,
 * and the pump that keeps nothing in memory.
 *
 * The visualizer's canvas is the source. `Visualizer.beginRecordingFrame` has
 * already fixed its drawing buffer at the requested size, so a frame taken
 * from it is exactly those pixels -- this module never resizes anything.
 *
 * **Frames are taken on the recording's own clock, not the display's.** The
 * visualizer reports every frame it draws; the recorder takes one only when
 * the next slot on the fps grid has arrived, and stamps it with that slot.
 * A 30 fps file therefore has a frame every 33.3 ms exactly, whatever the
 * display was doing, and a strobe flash lit for one rendered frame is in the
 * file once, on the frame it belongs to. A recorder that copies the canvas on
 * its own timer makes frames 17 to 49 ms apart and keeps or loses such a
 * flash by where its clock happens to stand.
 *
 * **The file is a movie, not a stream.** Bytes go to the main process as the
 * muxer produces them, which is what makes a take unlimited, but the muxer
 * writes a conventional MP4: one media block and a frame table at the end.
 * Uploaders read the table and accept the file; a fragmented stream with no
 * table, which is what a browser's own recorder produces, they refuse.
 */

/**
 * The video codec, and the audio codecs in order of preference.
 *
 * H.264 in MP4 is what plays everywhere without transcoding. AAC is the
 * audio that pairs with it everywhere; Opus in MP4 is the floor for a machine
 * without an AAC encoder, which is Windows N without its media pack.
 *
 * @constant
 */
const VIDEO_CODEC = 'avc';
const AUDIO_CODECS = ['aac', 'opus'];

/**
 * Bits per second for the sound.
 *
 * 192k stereo AAC is transparent enough for a room recording and costs about
 * 1.4 MB a minute, which is noise beside the video.
 *
 * @constant {Number}
 */
const AUDIO_BITRATE = 192000;

/** The desktop capture is asked for this rate; see `captureDesktopAudio`. */
const AUDIO_SAMPLE_RATE = 48000;

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
 * How often a key frame is written, in seconds. Seeking lands on these; two
 * seconds is the usual trade against file size.
 */
const KEY_FRAME_SECONDS = 2;

/**
 * How many bytes the muxer gathers before handing them over, so the IPC round
 * trip is not a per-packet cost. Four megabytes is a second or two of video
 * at the medium quality.
 *
 * @constant {Number}
 */
const CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * How many frames may be waiting on the encoder before new ones are dropped.
 *
 * The encoder runs behind the render loop, and a frame waits its turn. A
 * hardware encoder keeps up with the display; if one does not, the queue must
 * not grow without limit, so past this many the frame is skipped and counted.
 * The file keeps its timeline: the next frame taken lands on its own slot.
 *
 * @constant {Number}
 */
const MAX_FRAMES_IN_FLIGHT = 6;

/** The recording taking frames from the visualizer, if any. */
let active = null;

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
      sampleRate: AUDIO_SAMPLE_RATE,
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
 * Whether this machine can record at all: an H.264 encoder for a 1080p60
 * frame, which is the ordinary case.
 *
 * @returns {Promise<Boolean>}
 */
async function canRecord() {
  if (typeof VideoEncoder === 'undefined') return false;
  try {
    return await canEncodeVideo(VIDEO_CODEC, {
      width: 1920, height: 1080, bitrate: bitrateFor(1920, 1080, 60, 'medium'),
    });
  } catch (err) {
    return false;
  }
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
    this.audioNote = null;

    this.id = null;
    this.path = null;
    this.output = null;
    this.video = null;
    this.audio = null;
    this.error = null;
    this.bytes = 0;
    this.startedAt = 0;
    /** Whether frames are being taken. */
    this.taking = false;
    /** When the first frame was taken, on the render clock, in milliseconds. */
    this.clockStart = null;
    /** The last fps-grid slot a frame was taken for. */
    this.frameIndex = -1;
    /**
     * The slot the lamps are stepping for in the frame being drawn now.
     *
     * Read from the clock once per rendered frame, after the previous frame
     * was taken, and handed to the lamps as they prepare the next. The next
     * frame is then taken if this slot is new, so the frame taken is exactly
     * the frame the lamps stepped for. A second read of the clock after the
     * render disagreed with the lamps' whenever a slot began between the two
     * reads, and the flash landed a slot late: measured as slips every few
     * seconds, more often as the render time grew.
     */
    this.currentSlot = 0;
    /** Frames waiting on the encoder. */
    this.inFlight = 0;
    /** Frames skipped because the encoder was behind. */
    this.dropped = 0;
    /**
     * How the render loop kept up with the slots, reported when the take
     * stops: slots that passed with no frame drawn in them, and the longest
     * interval between two drawn frames, in milliseconds.
     */
    this.skippedSlots = 0;
    this.longestFrameMs = 0;
    this.lastDrawnAt = null;
    /** Frames handed to the encoder, and packets it has produced. */
    this.framesAdded = 0;
    this.encodedPackets = 0;
    /** File chunks handed to the main process and not yet acknowledged. */
    this.writesPending = 0;
    /** When the last once-a-second progress line was printed. */
    this.lastReportAt = 0;
    /**
     * Chunks are written one after another, never concurrently.
     *
     * The muxer hands over a chunk and does not wait for the previous write to
     * be acknowledged, and IPC does not promise arrival in the order sent. Out
     * of order, a positional write is still placed correctly, but the file's
     * length as the main process reports it would run backwards. Every write
     * is queued behind the last, and the muxer's own back-pressure follows the
     * queue.
     */
    this.queue = Promise.resolve();
  }

  /** @returns {Number} seconds elapsed, 0 before it starts */
  get elapsed() {
    return this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0;
  }

  /**
   * How far the encoder has got: frames it has finished against frames it
   * was handed. What the widget shows while a take is finishing, since the
   * flush at stop takes as long as the encoder's backlog takes to clear.
   *
   * @readonly
   * @type {Object} `{ encoded, total }`
   */
  get progress() {
    return { encoded: this.encodedPackets, total: this.framesAdded };
  }

  /**
   * Opens the file and starts encoding.
   *
   * @returns {Promise<Object>} `{ ok, path, audio, note }` or `{ ok: false, error }`
   */
  async start() {
    if (!window.videoRecorder) return { ok: false, error: 'Recording is unavailable' };
    const { width, height } = this.canvas;
    const bitrate = bitrateFor(width, height, this.fps, this.quality);

    if (typeof VideoEncoder === 'undefined') {
      return { ok: false, error: 'This machine cannot encode H.264 video' };
    }
    // The card's encoder, asked for by name. Left to no preference, Chromium
    // falls back to a software encoder silently when the hardware one is
    // busy, and a software encoder at 1080p runs at a third of real time:
    // measured as 372 of 618 frames still queued when a take stopped, and
    // thirty seconds to flush them. Software is the fallback, not the default.
    let hardwareAcceleration = 'prefer-hardware';
    if (!(await canEncodeVideo(VIDEO_CODEC, {
      width, height, bitrate, hardwareAcceleration,
    }))) {
      hardwareAcceleration = 'no-preference';
      if (!(await canEncodeVideo(VIDEO_CODEC, { width, height, bitrate }))) {
        return { ok: false, error: 'This machine cannot encode H.264 video at this size' };
      }
    }

    // Ask for the sound BEFORE opening the file, so a refused capture does not
    // leave an empty take on disk. A failure here is not fatal: the take still
    // has a picture, and silently recording video is better than recording
    // nothing because the audio device was busy.
    let audioCodec = null;
    if (this.wantsAudio) {
      try {
        this.audioTrack = await captureDesktopAudio();
        if (!this.audioTrack) this.audioNote = 'No desktop audio device was available';
      } catch (err) {
        this.audioNote = `Desktop audio was not captured: ${err.message}`;
        console.warn(`[recorder] ${this.audioNote}`);
      }
      if (this.audioTrack) {
        audioCodec = await getFirstEncodableAudioCodec(AUDIO_CODECS, {
          numberOfChannels: 2, sampleRate: AUDIO_SAMPLE_RATE, bitrate: AUDIO_BITRATE,
        });
        if (!audioCodec) {
          this.audioNote = 'This machine has no audio encoder; the take is silent';
          this.audioTrack.stop();
          this.audioTrack = null;
        }
      }
    }

    const opened = await window.videoRecorder.begin({
      name: this.name,
      documentPath: this.documentPath,
    });
    if (!opened || !opened.ok) {
      this.dropAudio();
      return { ok: false, error: (opened && opened.error) || 'Could not open the file' };
    }
    this.id = opened.id;
    this.path = opened.path;

    try {
      const target = new StreamTarget(new WritableStream({
        write: (chunk) => this.write(chunk),
      }), { chunked: true, chunkSize: CHUNK_BYTES });

      this.output = new Output({
        // The frame table goes at the end, after the media: the one layout
        // that needs neither the whole file in memory nor a fragmented stream.
        format: new Mp4OutputFormat({ fastStart: false }),
        target,
      });

      this.video = new CanvasSource(this.canvas, {
        codec: VIDEO_CODEC,
        bitrate,
        keyFrameInterval: KEY_FRAME_SECONDS,
        // No frame is ever dropped by the encoder itself; the recorder drops
        // them, counted, when the encoder is behind. See `frameDrawn`.
        latencyMode: 'quality',
        hardwareAcceleration,
        onEncoderConfig: (config) => {
          console.log(`[recorder] video encoder ${config.codec}, `
            + `${config.hardwareAcceleration || 'no-preference'}, ${config.latencyMode}`);
        },
        // Frames handed in against packets out: the difference at stop is the
        // encoder's backlog, and the flush at stop takes as long as it takes to
        // clear it.
        onEncodedPacket: () => { this.encodedPackets += 1; },
      });
      // The rate is declared, so every timestamp is snapped to its grid.
      this.output.addVideoTrack(this.video, { frameRate: this.fps });

      if (this.audioTrack) {
        this.audio = new MediaStreamAudioTrackSource(this.audioTrack, {
          codec: audioCodec,
          bitrate: AUDIO_BITRATE,
        });
        // A failure in the audio pump is reported through this promise alone.
        this.audio.errorPromise.catch((err) => {
          this.error = `Audio failed: ${err.message}`;
          console.error(`[recorder] ${this.error}`);
        });
        this.output.addAudioTrack(this.audio);
      }

      await this.output.start();
    } catch (err) {
      // The file is open and nothing will be written to it, so it goes rather
      // than being left as an empty take.
      this.dropAudio();
      await window.videoRecorder.abort(this.id);
      this.id = null;
      this.output = null;
      return { ok: false, error: `Could not start the encoder: ${err.message}` };
    }

    this.startedAt = Date.now();
    this.clockStart = performance.now();
    this.currentSlot = 0;
    this.taking = true;
    active = this;
    // The lamps step on this take's frame slots from here, ending each of
    // their intervals where a slot begins; see `shutter.js`. They are told
    // the slot decided for the frame being drawn, never a fresh reading.
    Shutter.setSlotClock(() => ({
      index: this.currentSlot,
      seconds: this.clockStart / 1000 + this.currentSlot / this.fps,
      length: 1 / this.fps,
    }));
    console.log(`[recorder] ${width}x${height} @ ${this.fps} fps, H.264`
      + `${audioCodec ? ` + ${audioCodec.toUpperCase()} desktop audio` : ''} -> ${this.path}`);
    return {
      ok: true, path: this.path, audio: !!audioCodec, note: this.audioNote || null,
    };
  }

  /**
   * The slot of the fps grid the recording clock is in now, counted from the
   * start of the take.
   *
   * Read once per rendered frame, in `frameDrawn`, and nowhere else: the
   * lamps are handed the reading rather than taking their own.
   *
   * @private
   * @returns {Number}
   */
  slot() {
    return Math.floor(((performance.now() - this.clockStart) / 1000) * this.fps);
  }

  /**
   * Takes a frame if the recording clock has reached a new slot.
   *
   * Called by the visualizer after every frame it draws. The first call sets
   * the clock's zero; from then on a frame is taken when the elapsed time has
   * crossed into a new fps interval, and stamped with that interval's start.
   * Display frames inside an interval are passed over; intervals the display
   * skipped are left empty, and the frame before them stands until the next.
   *
   * @public
   */
  frameDrawn() {
    if (!this.taking || !this.video) return;
    const now = performance.now();
    if (this.lastDrawnAt !== null) {
      this.longestFrameMs = Math.max(this.longestFrameMs, now - this.lastDrawnAt);
    }
    this.lastDrawnAt = now;
    // Once a second: where the frames are. A growing gap between added and
    // encoded is the encoder behind; writes pending is the disk behind.
    if (now - this.lastReportAt >= 1000) {
      this.lastReportAt = now;
      console.log(`[recorder] t=${((now - this.clockStart) / 1000).toFixed(0)}s`
        + ` added ${this.framesAdded}, encoded ${this.encodedPackets},`
        + ` in flight ${this.inFlight}, writes pending ${this.writesPending}, ${this.bytes} bytes`);
    }

    // The frame just drawn shows the lamps stepped for `currentSlot`. Taken
    // if that slot is new; then the clock is read once for the next frame,
    // and the lamps are told the answer as they prepare it.
    const index = this.currentSlot;
    this.currentSlot = this.slot();
    if (index <= this.frameIndex) return;
    if (this.frameIndex >= 0 && index > this.frameIndex + 1) {
      const skipped = index - this.frameIndex - 1;
      this.skippedSlots += skipped;
      console.warn(`[recorder] ${skipped} slot(s) passed with no frame drawn at ${(index / this.fps).toFixed(2)} s`);
    }
    this.frameIndex = index;

    if (this.inFlight >= MAX_FRAMES_IN_FLIGHT) {
      this.dropped += 1;
      return;
    }
    this.inFlight += 1;
    this.framesAdded += 1;
    this.video.add(index / this.fps)
      .catch((err) => {
        if (!this.error) this.error = `Encoding failed: ${err.message}`;
        console.error(`[recorder] ${this.error}`);
      })
      .finally(() => { this.inFlight -= 1; });
  }

  /**
   * Hands one chunk of the file to the main process, in order and at its
   * position.
   *
   * @private
   * @param {Object} chunk `{ type: 'write', data, position }`
   * @returns {Promise} settles when the chunk has been acknowledged
   */
  write(chunk) {
    if (this.id === null) return Promise.resolve();
    // Copied: the muxer may reuse its buffer once this returns, and the copy
    // crosses to the main process by structured clone.
    const data = chunk.data.slice();
    const { position } = chunk;
    this.writesPending += 1;
    this.queue = this.queue
      .then(async () => {
        if (this.id === null) return;
        const result = await window.videoRecorder.write(this.id, position, data);
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
      .finally(() => { this.writesPending -= 1; });
    return this.queue;
  }

  /**
   * Stops the desktop audio capture, if one was started.
   *
   * @private
   */
  dropAudio() {
    if (this.audioTrack) this.audioTrack.stop();
    this.audioTrack = null;
  }

  /**
   * Stops encoding, writes the frame table and closes the file.
   *
   * Waits for the frames still in the encoder and for every chunk to land,
   * because the frame table is the last thing written and a file without it
   * will not play at all.
   *
   * @returns {Promise<Object>} `{ ok, path, bytes, dropped }` or `{ ok: false, error }`
   */
  async stop() {
    if (!this.output) return { ok: false, error: 'Not recording' };
    this.taking = false;
    if (active === this) {
      active = null;
      Shutter.setSlotClock(null);
    }

    const stopBegan = performance.now();
    const backlog = this.framesAdded - this.encodedPackets;
    let drained = stopBegan;
    let finalized = stopBegan;
    try {
      // Frames handed to the encoder are still encoding; the finalize below
      // flushes the encoders, but a frame whose `add` has not yet resolved
      // would be lost to it.
      while (this.inFlight > 0) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => { setTimeout(resolve, 5); });
      }
      drained = performance.now();
      if (this.error) {
        await this.output.cancel();
      } else {
        await this.output.finalize();
      }
      finalized = performance.now();
    } catch (err) {
      if (!this.error) this.error = `Could not finish the file: ${err.message}`;
      console.error(`[recorder] ${this.error}`);
    }
    // The last chunk's write is on the queue by now; awaiting the queue awaits it.
    await this.queue;
    const written = performance.now();
    console.log(`[recorder] stop: ${backlog} frame(s) still in the encoder,`
      + ` drained in ${(drained - stopBegan).toFixed(0)} ms,`
      + ` finalized in ${(finalized - drained).toFixed(0)} ms,`
      + ` written in ${(written - finalized).toFixed(0)} ms`);

    this.dropAudio();
    const { id } = this;
    this.id = null;
    this.output = null;
    this.video = null;
    this.audio = null;

    if (this.error) {
      await window.videoRecorder.abort(id);
      return { ok: false, error: this.error };
    }
    const closed = await window.videoRecorder.end(id);
    if (!closed || !closed.ok) {
      return { ok: false, error: (closed && closed.error) || 'The file could not be closed' };
    }
    if (this.dropped) {
      console.warn(`[recorder] ${this.dropped} frame(s) dropped: the encoder fell behind`);
    }
    console.log(`[recorder] ${this.frameIndex + 1} slots, ${this.skippedSlots} passed undrawn,`
      + ` longest interval between drawn frames ${this.longestFrameMs.toFixed(1)} ms`);
    return {
      ok: true, path: closed.path, bytes: closed.bytes, dropped: this.dropped,
    };
  }
}

/**
 * Tells the recording, if there is one, that the visualizer has drawn a frame.
 *
 * Called at the end of every render, after the composer has finished and
 * before anything is drawn over the picture.
 *
 * @public
 */
function frameDrawn() {
  if (active) active.frameDrawn();
}

export default {
  Recording, QUALITY, FRAME_RATES, bitrateFor, captureDesktopAudio, canRecord, frameDrawn,
};
