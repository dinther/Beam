import PatchSingleton from '@/models/DMX/patch.model';
import { subscribeFrames } from '@/plugins/artnet.frames';

/**
 * Renderer-side Art-Net connection manager.
 *
 * Bridges the main-process DMX sockets -- Art-Net and sACN, exposed together as
 * `window.artnet` because both deliver the same frames -- to the DMX model
 * layer:
 *  - input:  inbound frames are written straight into the show's address space,
 *            which fans the 512-byte buffer out to patched fixtures — the same
 *            path that drives the 3D visualizer from manual faders.
 *
 * When `window.artnet` is unavailable (plain browser), every method is a safe
 * no-op.
 */

/**
 * How often the patched universes are re-checked, in ms.
 *
 * Polled rather than announced. The patch has no change event, and the set is
 * read off a run list that is short even for a rig of hundreds -- so a compare
 * every couple of seconds costs nothing and needs no hook in the model that
 * every future caller would have to remember to fire.
 */
const UNIVERSE_WATCH_MS = 2000;

class ArtNetConnection {
  constructor() {
    this.inputEnabled = false;
    this.unsubscribe = null;
    this.universeTimer = null;
    /** The last set announced, as a string, so a compare is one comparison. */
    this.announced = '';
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
    this.unsubscribe = subscribeFrames((universe, data) => {
      // The universe number is an offset into the show's address space, not a
      // lookup key: a frame is delivered whether or not a Universe object
      // exists for it, and a fixture straddling the boundary is filled by the
      // two frames that cover its channels.
      PatchSingleton.writeUniverse(universe, data);
    });
    this.watchUniverses();
    this.inputEnabled = true;
  }

  /**
   * Keeps sACN's multicast memberships in step with what the show has patched.
   *
   * Art-Net needs none of this -- it is broadcast or unicast, and arrives
   * whatever is patched. sACN normally arrives on a multicast group per
   * universe, and a group has to be joined before anything from it is seen, so
   * a fixture patched into a universe nobody has joined is a fixture that
   * never lights.
   *
   * @public
   */
  watchUniverses() {
    if (!this.available || !window.artnet.listenTo || this.universeTimer) return;
    const announce = () => {
      const universes = PatchSingleton.patchedUniverses();
      const key = universes.join();
      if (key === this.announced) return;
      this.announced = key;
      window.artnet.listenTo(universes);
    };
    announce();
    this.universeTimer = setInterval(announce, UNIVERSE_WATCH_MS);
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
    if (this.universeTimer) {
      clearInterval(this.universeTimer);
      this.universeTimer = null;
    }
    this.inputEnabled = false;
  }

  /**
   * Who is sending on either wire, and where two of them collide.
   *
   * @public
   * @async
   * @returns {Promise<Object>} `{ sources, conflicts }`, empty outside Electron
   */
  async sources() {
    if (!this.available || !window.artnet.sources) return { sources: [], conflicts: [] };
    return window.artnet.sources();
  }
}

export default new ArtNetConnection();
