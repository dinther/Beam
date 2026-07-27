import ShowSingleton from '@/singletons/show.singleton';
import liveInstance from '@/models/DMX/live.model';

/**
 * Renderer-side Art-Net connection manager.
 *
 * Bridges the main-process Art-Net socket (exposed as `window.artnet`) to the
 * DMX model layer:
 *  - input:  inbound frames are written straight into `universe.DMX512Data`,
 *            which fans the 512-byte buffer out to patched fixtures — the same
 *            path that drives the 3D visualizer from manual faders.
 *  - output: per-universe, the current `universe.DMX512Data` is sent out on the
 *            Live animation tick.
 *
 * When `window.artnet` is unavailable (plain browser), every method is a safe
 * no-op and manual fader control still works.
 */

const ARTNET_DEFAULT_PORT = 6454;

class ArtNetConnection {
  constructor() {
    this.inputEnabled = false;
    this.outputs = new Map(); // universeId -> { ip, port, animId }
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
      try {
        const target = ShowSingleton.universePool.getFromId(universe);
        if (target) target.DMX512Data = data;
      } catch (err) {
        // No universe patched at this Art-Net address — ignore the frame.
      }
    });
    this.inputEnabled = true;
  }

  /**
   * Stops routing inbound frames.
   */
  disableInput() {
    // Only stop routing frames locally; the underlying socket is shared with
    // output, so it is left open and owned by the main process.
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.inputEnabled = false;
  }

  /**
   * Begins streaming a universe's DMX buffer out as Art-Net.
   *
   * @param {Object} universe Universe instance
   * @param {Object} [opts]
   * @param {string} [opts.ip] destination (unicast or broadcast)
   * @param {number} [opts.port] destination port
   */
  startOutput(universe, opts = {}) {
    if (!this.available) return;
    this.stopOutput(universe.id);
    const ip = opts.ip || '255.255.255.255';
    const port = opts.port || ARTNET_DEFAULT_PORT;
    const animId = liveInstance.add(() => {
      window.artnet.send({ universe: universe.id, data: universe.DMX512Data, ip, port });
    });
    this.outputs.set(universe.id, { ip, port, animId });
  }

  /**
   * Stops streaming a universe.
   *
   * @param {Number} universeId
   */
  stopOutput(universeId) {
    const output = this.outputs.get(universeId);
    if (output) {
      liveInstance.remove(output.animId);
      this.outputs.delete(universeId);
    }
  }

  /**
   * Whether a universe is currently being streamed out.
   *
   * @param {Number} universeId
   * @returns {Boolean}
   */
  isOutputting(universeId) {
    return this.outputs.has(universeId);
  }
}

export default new ArtNetConnection();
