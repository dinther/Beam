import PatchSingleton from '@/models/DMX/patch.model';

/**
 * Renderer-side Art-Net connection manager.
 *
 * Bridges the main-process Art-Net socket (exposed as `window.artnet`) to the
 * DMX model layer:
 *  - input:  inbound frames are written straight into the show's address space,
 *            which fans the 512-byte buffer out to patched fixtures — the same
 *            path that drives the 3D visualizer from manual faders.
 *
 * When `window.artnet` is unavailable (plain browser), every method is a safe
 * no-op.
 */

class ArtNetConnection {
  constructor() {
    this.inputEnabled = false;
    this.unsubscribe = null;
  }

  /** Whether a native Art-Net bridge is present (i.e. running under Electron). */
  // eslint-disable-next-line class-methods-use-this
  get available() {
    return typeof window !== 'undefined' && !!window.artnet;
  }

  /**
   * Opens the receive socket and starts routing inbound frames to universes.
   */
  enableInput() {
    if (!this.available || this.inputEnabled) return;
    window.artnet.start({});
    this.unsubscribe = window.artnet.onFrame(({ universe, data }) => {
      // The universe number is an offset into the show's address space, not a
      // lookup key: a frame is delivered whether or not a Universe object
      // exists for it, and a fixture straddling the boundary is filled by the
      // two frames that cover its channels.
      PatchSingleton.writeUniverse(universe, data);
    });
    this.inputEnabled = true;
  }

  /**
   * Stops routing inbound frames.
   */
  disableInput() {
    // Only stop routing frames locally; the socket itself stays open and owned
    // by the main process.
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.inputEnabled = false;
  }
}

export default new ArtNetConnection();
