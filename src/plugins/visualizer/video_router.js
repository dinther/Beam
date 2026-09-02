import VideoFeed from './video_feed';

/**
 * @file The one video source the scene is showing, and who is watching it.
 *
 * A connector says *which part* of a picture a device gets. This says *where
 * the picture comes from* -- and the two are deliberately separate, because a
 * connector's rectangle is show data while its binding to a real sender is a
 * fact about one machine. "DEV1 (MadMapper - Video-Output-1)" means nothing on
 * a different computer, and opening a show elsewhere is the normal case rather
 * than an edge one.
 *
 * **Nothing here opens a receiver on its own.** A feed is a network socket and
 * a 16 MB frame every 33 ms, and starting one behind a user's back is not this
 * module's decision to make -- the same reason the old `attachVideoTest` sat
 * behind a debug flag. `select()` is called when someone picks a source in
 * Preferences > Video, and only then.
 *
 * This is deliberately *one* source rather than one per connector. That matches
 * how the video path was designed -- one canvas carved into regions, which is
 * MadMapper's own model -- and it is the whole reason connectors exist as a
 * name in the middle. Per-connector senders can come later without anything
 * that reads this having to change.
 */

/** The feed every device currently draws from, or null. */
let current = null;

/** Its sender name, kept so re-selecting the same one is free. */
let currentName = '';

/** Bumped whenever the feed changes, so renderers know to rebuild materials. */
let generation = 0;

/** Called when the feed changes, so the scene can rebuild what draws it. */
const listeners = new Set();

/**
 * Turns a connector id into the connector, installed by the show.
 *
 * A renderer must not reach into the show and the show must not know what a
 * renderer wants, so the one object that knows both hands over a function.
 */
let resolver = () => null;

function announce() {
  generation += 1;
  listeners.forEach((fn) => {
    try {
      fn(current);
    } catch (err) {
      // A listener that throws must not stop the others hearing about it.
      // eslint-disable-next-line no-console
      console.error('[video] router listener failed', err);
    }
  });
}

export default {
  /**
   * Installs the connector lookup. Called once, by the show.
   *
   * @public
   * @param {Function} fn (id) => VideoConnector or null
   */
  resolveWith(fn) {
    resolver = fn || (() => null);
  },

  /**
   * The connector behind an id, or null for unbound.
   *
   * @public
   * @param {*} id
   * @returns {Object|null}
   */
  connector(id) {
    if (id === null || id === undefined) return null;
    return resolver(id);
  },

  /**
   * The feed the scene is showing, or null when nothing is selected.
   *
   * @public
   * @returns {Object|null}
   */
  feed() {
    return current;
  },

  /**
   * Which sender is selected, for a panel that wants to say so.
   *
   * @public
   * @returns {String}
   */
  name() {
    return currentName;
  },

  /**
   * Changes as the feed does, so a renderer can tell a rebuild is due without
   * comparing textures.
   *
   * @public
   * @returns {Number}
   */
  generation() {
    return generation;
  },

  /**
   * Points the scene at a sender, opening it if need be.
   *
   * Reference counted through `VideoFeed`, so the slicing editor and the scene
   * watching the same sender is one receiver rather than two.
   *
   * @public
   * @async
   * @param {String} name sender name, or empty to show nothing
   * @returns {Object|null} the feed
   */
  async select(name) {
    if (name === currentName) return current;
    const previous = current;
    currentName = name || '';
    current = name ? await VideoFeed.open(name) : null;
    // Released after the new one is open, so watching the same sender twice
    // never closes the receiver in between and re-opens it.
    if (previous) previous.close();
    announce();
    return current;
  },

  /**
   * Announces that a connector's rectangle changed, without changing the feed.
   *
   * Carving a slice while a display is showing it should move the picture on
   * the display, which is most of what makes the editor worth having open.
   *
   * @public
   */
  touch() {
    listeners.forEach((fn) => fn(current));
  },

  /**
   * Lets go of whatever is open.
   *
   * @public
   */
  release() {
    if (!current) return;
    current.close();
    current = null;
    currentName = '';
    announce();
  },

  /**
   * @public
   * @param {Function} fn called with the feed whenever it changes
   * @returns {Function} call it to stop listening
   */
  listen(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
