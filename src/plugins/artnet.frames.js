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

/** Everyone currently listening. */
const listeners = new Set();

/** Handle for the one IPC subscription, held while anyone is listening. */
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
export function subscribeFrames(listener) {
  if (typeof window === 'undefined' || !window.artnet) return null;

  listeners.add(listener);
  if (!detach) detach = window.artnet.onFrames(deliver);

  return () => {
    listeners.delete(listener);
    // The IPC listener costs nothing while idle, but leaving it attached with
    // nobody behind it means a batch is still unpacked on every frame.
    if (!listeners.size && detach) {
      detach();
      detach = null;
    }
  };
}

export default { subscribeFrames };
