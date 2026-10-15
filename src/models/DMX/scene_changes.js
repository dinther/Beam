/**
 * @file Reports edits to scene items that are not proxied.
 *
 * Fixtures report their writes through `ProxifySingleton`. Objects,
 * structures and groups are not proxied, so their setters call `sceneChanged`
 * and the show marks itself unsaved.
 */

const listeners = new Set();

/**
 * @public
 * @param {Function} listener called with no arguments on every change
 * @returns {Function} removes the listener
 */
export function onSceneChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Tells the listeners that saved scene data changed.
 *
 * @public
 */
export function sceneChanged() {
  listeners.forEach((listener) => listener());
}
