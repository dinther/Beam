/**
 * Headless shims.
 *
 * The model layer was written for the renderer and touches a few browser
 * globals at import time (proxify.utils.js registers window listeners; the
 * visualizer plugin expects a document). None of them affect the DMX write
 * path we are measuring, so they are stubbed rather than emulated.
 */
const noop = () => {};

if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    addEventListener: noop,
    removeEventListener: noop,
    location: { pathname: '/bench' },
    devicePixelRatio: 1,
    innerWidth: 1920,
    innerHeight: 1080,
  };
}

if (typeof globalThis.document === 'undefined') {
  const stubEl = () => ({
    style: {},
    setAttribute: noop,
    appendChild: noop,
    addEventListener: noop,
    removeEventListener: noop,
    getContext: () => null,
    getBoundingClientRect: () => ({
      x: 0, y: 0, width: 1920, height: 1080, top: 0, left: 0,
    }),
  });
  globalThis.document = {
    createElement: stubEl,
    createElementNS: stubEl,
    addEventListener: noop,
    removeEventListener: noop,
    body: stubEl(),
    documentElement: stubEl(),
  };
}

if (typeof globalThis.navigator === 'undefined') {
  globalThis.navigator = { userAgent: 'node' };
}

if (typeof globalThis.getComputedStyle === 'undefined') {
  // uikit.colors reads CSS custom properties at import time; the DMX write
  // path never consults them, so an empty style object is sufficient.
  globalThis.getComputedStyle = () => ({
    getPropertyValue: () => '',
  });
  globalThis.window.getComputedStyle = globalThis.getComputedStyle;
}
