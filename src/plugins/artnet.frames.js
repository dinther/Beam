/**
 * The renderer's single Art-Net subscription.
 *
 * Two things want inbound universes -- the visualizer's DMX texture and the
 * show's address space -- and each used to register its own IPC listener. That
 * woke the renderer twice per message and unpacked the same batch twice. One
 * listener fans out to both instead.
 *
 * The main process delivers a batch per display frame: `universes` holds the
 * universe numbers that changed and `data` their values end to end, 512 per
 * universe. This unpacks it into one call per universe, which is the shape
 * both consumers already expect.
 */

/** Channels in a universe, and so the stride through a batch's `data`. */
const UNIVERSE_SIZE = 512;

/**
 * Whether batches arrive over a transferred MessagePort rather than over IPC.
 *
 * `webContents.send` structured-clones what it carries, and with context
 * isolation the preload copies it a second time to get it across the bridge.
 * A port is delivered straight into the page's own world, so only the clone is
 * left: at 512 x 512 that is 786 KB a flush copied once instead of twice.
 *
 * Set to false to go back to the IPC path. Main decides which path it sends
 * on, and this side listens on both regardless, so the switch cannot leave the
 * renderer deaf on the path main happens to choose.
 *
 * @constant {Boolean}
 */
const TRANSFER_FRAMES = true;

/** Everyone currently listening. */
const listeners = new Set();

/** Handle for the one subscription, held while anyone is listening. */
let detach = null;

/**
 * Fans one batch out to every listener, universe by universe.
 *
 * The frame handed on is a view into the batch, not a copy: it is valid for
 * the duration of the call and must be read or copied, never retained.
 *
 * @param {{universes: Uint16Array, data: Uint8Array}} batch
 */
function deliver({ universes, data }) {
  for (let index = 0; index < universes.length; index += 1) {
    const offset = index * UNIVERSE_SIZE;
    const frame = data.subarray(offset, offset + UNIVERSE_SIZE);
    listeners.forEach((listener) => listener(universes[index], frame));
  }
}

/**
 * Registers interest in inbound universes.
 *
 * @param {(universe: Number, frame: Uint8Array) => void} listener
 * @returns {Function|null} unsubscribe handle, or null outside Electron
 */
/**
 * Opens the transferable channel and feeds batches from it.
 *
 * The listener goes on before the port is asked for, so the reply cannot
 * arrive before anything is waiting for it. Returns synchronously -- matching
 * the IPC path it replaces -- while the port itself connects in the
 * background; the frames lost in that window are a few milliseconds of a
 * stream that repeats itself continuously.
 *
 * @returns {Function} detach handle
 */
function attachPort() {
  let port = null;
  let cancelled = false;

  const onWindowMessage = (event) => {
    if (event.source !== window || event.data !== 'artnet:frame-port') return;
    window.removeEventListener('message', onWindowMessage);
    if (cancelled) return;
    [port] = event.ports;
    port.onmessage = (message) => deliver(message.data);
    port.start();
  };

  window.addEventListener('message', onWindowMessage);
  window.artnet.requestFramePort();

  return () => {
    cancelled = true;
    window.removeEventListener('message', onWindowMessage);
    if (port) {
      port.onmessage = null;
      port.close();
    }
  };
}

export function subscribeFrames(listener) {
  if (typeof window === 'undefined' || !window.artnet) return null;

  listeners.add(listener);
  if (!detach) {
    // Both paths, always. Main sends a batch down exactly one of them, but
    // which one is its decision and it can change: the port is asked for
    // asynchronously, so early batches arrive over IPC, and a port that fails
    // hands the stream back to IPC mid-run. Listening on only the path we hope
    // for is what turned one bad call in main into a black rig.
    const stopIpc = window.artnet.onFrames(deliver);
    const stopPort = TRANSFER_FRAMES && window.artnet.requestFramePort
      ? attachPort()
      : null;
    detach = () => {
      stopIpc();
      if (stopPort) stopPort();
    };
  }

  return () => {
    listeners.delete(listener);
    // The subscription costs nothing while idle, but leaving it attached with
    // nobody behind it means a batch is still unpacked on every frame.
    if (!listeners.size && detach) {
      detach();
      detach = null;
    }
  };
}

export default { subscribeFrames };
