import * as THREE from 'three';

/**
 * @file A live video source, as a texture.
 *
 * The renderer's half of the NDI path. Frames arrive from the preload as
 * `window` messages carrying a **transferred** ArrayBuffer -- see `ndi.js` and
 * the `ndi` bridge in `preload.js` -- so by the time one reaches here it has
 * been moved, not copied, and this module owns it outright.
 *
 * What it deliberately does not do yet: slicing a frame into regions, or
 * connectors, or anything that consumes the texture. This is the pipe.
 */

/** Open feeds by handle, so an arriving frame can find the one it belongs to. */
const feeds = new Map();

/**
 * Whether video input is available at all.
 *
 * Absent in a plain browser, and absent if the addon would not load -- the
 * bridge is only exposed when `ndi.js` imported cleanly. Callers check this
 * rather than trapping on `window.ndi`.
 *
 * @returns {Boolean}
 */
function available() {
  return typeof window !== 'undefined' && !!window.ndi;
}

/**
 * A frame lands here for every open feed, on the page's own thread.
 *
 * A frame for a handle nobody holds is simply dropped: the buffer was
 * transferred to this world, so letting go of it is all that is needed to
 * release the 8 MB.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.channel !== 'ndi:frame') return;
    const feed = feeds.get(message.handle);
    if (feed) feed.accept(message);
  });
}

class VideoFeed {
  /**
   * @param {Number} handle from the bridge
   * @param {String} name the source it was opened from
   */
  constructor(handle, name) {
    this._handle = handle;
    this._name = name;
    this._texture = null;
    this._format = 'RGBA';
    this._width = 0;
    this._height = 0;
    // Only ever the newest. A 60 fps sender into a renderer that is busy would
    // otherwise build a queue of 8 MB frames, and every one but the last is
    // already stale by the time it could be drawn.
    this._pending = null;
    this._frames = 0;
    this._holders = 1;
  }

  get name() { return this._name; }

  /** 'UYVY' or 'RGBA' -- how the texture's bytes are packed. */
  get format() { return this._format; }

  /** Width of the *picture*, which for UYVY is twice the texture's. */
  get width() { return this._width; }

  /**
   * The bytes of the newest frame, exactly as uploaded.
   *
   * For anything that has to show this feed in a **second WebGL context** --
   * the slicing popup does, because a texture belongs to the context that
   * uploaded it and cannot be handed to another. The array is replaced each
   * frame rather than written into, so a holder must re-read it rather than
   * keep a reference; `frameCount` says when.
   *
   * @returns {Uint8Array|null}
   */
  get pixels() { return this._texture ? this._texture.image.data : null; }

  /** Texture width, which is half the picture's when the format is UYVY. */
  get texels() { return this._texture ? this._texture.image.width : 0; }

  get height() { return this._height; }

  /** @returns {THREE.DataTexture|null} null until the first frame lands */
  get texture() { return this._texture; }

  /** How many frames have been taken up into the texture. */
  get frameCount() { return this._frames; }

  /** Claims this feed for one more holder. See `close`. */
  retain() { this._holders += 1; }

  /**
   * Takes delivery of a frame. Called from the message listener, not by users.
   *
   * @param {Object} message `{ width, height, stride, buffer }`
   */
  accept(message) {
    this._pending = message;
  }

  /**
   * Moves the newest frame into the texture, if one has arrived.
   *
   * Called once per rendered frame rather than on arrival, so that a source
   * running faster than the display costs one upload per *drawn* frame instead
   * of one per received frame.
   *
   * @returns {Boolean} whether the texture changed
   */
  update() {
    const frame = this._pending;
    if (!frame) return false;
    this._pending = null;

    const {
      width, height, stride, buffer,
    } = frame;
    const format = frame.format === 'UYVY' ? 'UYVY' : 'RGBA';
    // UYVY carries two pixels in four bytes, so a row is half as many texels
    // as it is pixels -- and the texture is uploaded at that width. The shader
    // in `video_material.js` unpacks it; nothing here interprets the bytes.
    const texels = format === 'UYVY' ? width / 2 : width;
    const tight = texels * 4;
    let pixels = new Uint8Array(buffer);

    // A sender is entitled to pad its rows, and then the buffer is not an
    // image -- it is rows with gaps. MadMapper sends tight (7680 bytes for
    // 1920), so this repack has not been exercised against a real padded
    // sender; it is here so that one does not render as a diagonal smear.
    if (stride !== tight) {
      const packed = new Uint8Array(tight * height);
      for (let row = 0; row < height; row += 1) {
        packed.set(pixels.subarray(row * stride, row * stride + tight), row * tight);
      }
      pixels = packed;
    }

    // A source can change resolution mid-stream -- switching composition in
    // MadMapper does exactly that -- so the texture is rebuilt rather than
    // assumed. `DataTexture` cannot be resized in place.
    if (!this._texture
      || this._texture.image.width !== texels
      || this._texture.image.height !== height
      || this._format !== format) {
      if (this._texture) this._texture.dispose();
      const { RGBAFormat, UnsignedByteType } = THREE;
      this._texture = new THREE.DataTexture(pixels, texels, height, RGBAFormat, UnsignedByteType);
      // Packed bytes are not a colour, so nothing may be interpolated or
      // colour-managed on the way in: blending a luma with a chroma produces
      // garbage that reads as ringing along every vertical edge. The shader
      // converts, and converts to sRGB itself.
      this._texture.colorSpace = format === 'UYVY'
        ? THREE.NoColorSpace : THREE.SRGBColorSpace;
      const filter = format === 'UYVY' ? THREE.NearestFilter : THREE.LinearFilter;
      this._texture.minFilter = filter;
      this._texture.magFilter = filter;
      // No mipmaps: they would be rebuilt from scratch every frame, and
      // nothing samples this minified yet.
      this._texture.generateMipmaps = false;
      // NDI hands over rows top-down; GL's origin is bottom-left.
      this._texture.flipY = true;
    } else {
      this._texture.image.data = pixels;
    }

    this._texture.needsUpdate = true;
    this._format = format;
    this._width = width;
    this._height = height;
    this._frames += 1;
    return true;
  }

  /**
   * Stops the receiver and releases the texture, once nobody wants it.
   *
   * Reference counted, because two things legitimately want the same source
   * at once -- the scene and the slicing popup -- and a second receiver on one
   * sender is a second 16 MB frame every 33 ms for the same pixels.
   */
  close() {
    this._holders -= 1;
    if (this._holders > 0) return;
    feeds.delete(this._handle);
    if (available()) window.ndi.close(this._handle);
    if (this._texture) {
      this._texture.dispose();
      this._texture = null;
    }
    this._pending = null;
  }
}

/**
 * Everything advertising itself on the network.
 *
 * @param {Number} [waitMs]
 * @returns {Promise<Array>} `{ name, urlAddress }`, empty when unavailable
 */
async function sources(waitMs) {
  if (!available()) return [];
  return window.ndi.sources(waitMs);
}

/**
 * Opens a named source.
 *
 * @param {String} name exactly as `sources` reported it
 * @returns {Promise<VideoFeed|null>} null when video input is unavailable
 */
async function open(name) {
  if (!available()) return null;
  // Shared rather than duplicated. Whoever opens second gets the same feed and
  // a claim on it; `close` only tears down when the last claim goes.
  const existing = Array.from(feeds.values()).find((feed) => feed.name === name);
  if (existing) {
    existing.retain();
    return existing;
  }
  const handle = await window.ndi.open(name);
  const feed = new VideoFeed(handle, name);
  feeds.set(handle, feed);
  return feed;
}

/** Every feed currently open. */
function all() {
  return Array.from(feeds.values());
}

/** Moves the newest frame of every open feed into its texture. */
function updateAll() {
  feeds.forEach((feed) => feed.update());
}

export default {
  available, sources, open, all, updateAll, VideoFeed,
};
