/* eslint-disable import/no-extraneous-dependencies */
/**
 * @file NDI receive, for the preload.
 *
 * The odd one out in this folder: everything else here runs in the main
 * process, and this runs in the **renderer's** process, because `preload.js`
 * imports it and the window is built with `sandbox: false`. That is the whole
 * point of putting it here rather than beside the Art-Net socket -- a video
 * frame is 8 MB, and a frame that never crosses a process boundary never has
 * to be copied across one.
 *
 * `grandi` is a Node-API addon, so it is ABI-stable and survives an Electron
 * upgrade without a rebuild, and it carries its own `Processing.NDI.Lib` -- so
 * there is nothing for a user to install. It must stay **external** to the
 * preload bundle (see `electron.vite.config.js`): a `.node` file cannot be
 * bundled, only required.
 */

/**
 * The addon, loaded once and lazily.
 *
 * Lazily because loading it starts NDI's own discovery machinery, and a user
 * who never opens a video feed should not be paying for that -- nor should the
 * app fail to start on a machine where the addon will not load. Dynamically
 * because `grandi` publishes ESM only, and this file is bundled to CommonJS.
 *
 * @returns {Promise<Object>} the grandi module
 */
let loading = null;
function load() {
  if (!loading) {
    loading = import('grandi').then((m) => m.default || m);
  }
  return loading;
}

/**
 * How often a feed asks the addon for a frame, unless told otherwise.
 *
 * Not a quality setting -- see the pacing in `open` for why it is a frame-rate
 * setting for the whole application. 30 is above what a visualiser needs to
 * look live and comfortably under what costs frames.
 */
const DEFAULT_MAX_FPS = 30;

/**
 * The pixel formats this path can produce, by the SDK's own FourCC number.
 *
 * Only the two `UYVY_RGBA` can yield. Anything else arriving is a bug or a
 * sender doing something unusual, and the consumer is told the raw number so
 * it can say so rather than guessing.
 */
const FOURCC_NAMES = {
  1498831189: 'UYVY',
  1094862674: 'RGBA',
};

/** Open receivers by handle, so `close` can find the one it was given. */
const receivers = new Map();
let nextHandle = 1;

/**
 * Everything currently advertising itself on the network.
 *
 * The wait is not optional: NDI discovery is a background conversation, and
 * asking the instant a finder is created reliably returns nothing at all.
 *
 * @param {Number} [waitMs] how long to let discovery run
 * @returns {Promise<Array>} `{ name, urlAddress }`
 */
async function sources(waitMs = 1500) {
  const grandi = await load();
  const finder = await grandi.find();
  try {
    await finder.wait(waitMs);
    return finder.sources().map((s) => ({ name: s.name, urlAddress: s.urlAddress || '' }));
  } finally {
    finder.destroy();
  }
}

/**
 * Opens a source and pulls frames from it until it is closed.
 *
 * @param {String} name exactly as `sources` reported it
 * @param {Function} onFrame called with `{ width, height, buffer }` per frame
 * @param {Object} [options] `maxFps`, how often to ask for a frame
 * @returns {Promise<Number>} a handle for `close`
 */
async function open(name, onFrame, { maxFps = DEFAULT_MAX_FPS } = {}) {
  const grandi = await load();
  const found = (await sources()).find((s) => s.name === name);
  if (!found) throw new Error(`no NDI source named ${name}`);

  const receiver = await grandi.receive({
    source: { name: found.name, urlAddress: found.urlAddress || undefined },
    // UYVY for opaque video, RGBA when the sender has an alpha channel.
    //
    // Asking for RGBA outright looks simpler and costs twice, both ways:
    // NDI's wire format is YUV 4:2:2, so the SDK converts on the CPU for every
    // frame, and the result is 4 bytes a pixel instead of 2 -- a 4K frame is
    // 33 MB rather than 16.6 MB, and that upload was measured at ~9.7 ms.
    // Taking the SDK's own format skips its conversion and halves the bytes;
    // the shader does the colour transform, where it is nearly free.
    colorFormat: grandi.ColorFormat.UYVY_RGBA,
    bandwidth: grandi.Bandwidth.Highest,
    name: 'Beatline Beam',
  });

  const period = 1000 / Math.max(1, maxFps);
  let lastAt = 0;
  const handle = nextHandle;
  nextHandle += 1;
  const entry = { receiver, running: true };
  receivers.set(handle, entry);

  // A loop rather than a callback because that is the shape the addon offers:
  // `video()` resolves when a frame lands. It does its waiting on the addon's
  // own thread, so awaiting here costs the renderer nothing while idle.
  (async () => {
    while (entry.running) {
      // Paced, and this is the single most important line in the file.
      //
      // Asking as fast as the sender sends makes the addon materialise a frame
      // every time -- 8 MB allocated and freed, sixty times a second. Measured
      // against a 1080p60 sender: pulling flat out costs **5 frames a second**
      // off the renderer while showing up as 0.1 ms of CPU, because the work is
      // allocator and GC time between frames rather than inside the render.
      // Pulling at ~23/s instead put the frame rate back to 59.
      //
      // Skipped frames cost nothing: unasked-for frames are dropped inside the
      // SDK, so this asks for the newest rather than working through a backlog.
      const wait = period - (Date.now() - lastAt);
      if (wait > 0) {
        // eslint-disable-next-line no-await-in-loop, no-promise-executor-return
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      lastAt = Date.now();

      let frame;
      try {
        // eslint-disable-next-line no-await-in-loop
        frame = await entry.receiver.video(5000);
      } catch (err) {
        if (entry.running) {
          // eslint-disable-next-line no-console
          console.error('[ndi] receive failed', err);
        }
        break;
      }
      if (!entry.running) break;
      // A sender that has gone away yields timeouts rather than an error. Keep
      // waiting: NDI reconnects on its own when it comes back.
      if (!frame || frame.type !== 'video') {
        // eslint-disable-next-line no-continue
        continue;
      }

      const { data } = frame;
      // Every frame the addon hands over owns its whole ArrayBuffer and is a
      // fresh allocation -- verified against a live sender -- so it can be
      // *transferred* to the page rather than copied. At 1080p60 that is the
      // difference between moving a pointer and moving 500 MB a second. The
      // copy is kept as a fallback in case that ever stops being true.
      const owned = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength;
      const buffer = owned ? data.buffer : data.slice().buffer;
      onFrame({
        width: frame.xres,
        height: frame.yres,
        // Named rather than numbered, so nothing downstream has to import the
        // addon's enum to know what it is holding.
        format: FOURCC_NAMES[frame.fourCC] || String(frame.fourCC),
        // How many bytes a row occupies, which is not always the width: the
        // consumer has to know before it can treat this as an image.
        stride: frame.lineStrideBytes,
        buffer,
      });
    }
    entry.receiver.destroy();
    receivers.delete(handle);
  })();

  return handle;
}

/**
 * Stops a receiver. The loop tears down the receiver itself, so that a frame
 * already in flight is never destroyed underneath.
 *
 * @param {Number} handle from `open`
 */
function close(handle) {
  const entry = receivers.get(handle);
  if (entry) entry.running = false;
}

/** Stops everything, for a window that is going away. */
function closeAll() {
  receivers.forEach((entry) => { entry.running = false; });
}

export default {
  sources, open, close, closeAll,
};
