/**
 * @file Persistence for the debug panel's tuning values.
 *
 * The panel exists to find values worth keeping, and until now keeping them
 * meant editing a constant in source. This stores whatever has been moved and
 * puts it back at startup, so a session's work survives a restart.
 *
 * **Defaults deliberately live where they always did.** Nothing here is
 * registered in `Preferences.DEFAULTS`: the constants in `led_field.js`,
 * `led_panel.js` and `ambient.js` remain the single source of truth, and this
 * only ever holds departures from them. Copying them into a second table would
 * be two versions of one fact, and the preference would silently win -- so a
 * constant changed in a new version would never reach anyone who had opened
 * the panel once. That is the exact failure `departures()` was written to
 * avoid; see the note there.
 *
 * A key that has never been touched reads back `undefined` and is skipped,
 * which is what leaves the source constant in charge.
 */

import Preferences from './preferences';
import { EMITTER_UNIFORMS, GLOW_UNIFORMS } from './led_field';
import LEDPanel from './led_panel';
import { setAmbientCeiling } from './ambient';

const PREFIX = 'tune.';

/** The uniform object a group name refers to. */
function groupFor(group) {
  if (group === 'halo') return LEDPanel.tunables();
  if (group === 'emitter') return EMITTER_UNIFORMS;
  return GLOW_UNIFORMS;
}

/** Writes a value into a uniform object, if that uniform exists. */
function uniform(group, name) {
  return (value) => {
    const target = groupFor(group);
    if (target && target[name]) target[name].value = value;
  };
}

/**
 * Every control the panel offers, and how to put a stored value back.
 *
 * The visualizer is passed in because some of these live on it rather than in
 * a uniform. Anything whose target is absent is skipped rather than throwing:
 * the ambient haze effect only exists once the composer has been built.
 */
const CONTROLS = {
  // Emitter die
  gain: uniform('emitter', 'gain'),
  haloStrength: uniform('emitter', 'haloStrength'),
  coreScale: uniform('emitter', 'coreScale'),
  backScatter: uniform('emitter', 'backScatter'),
  // Distance dimming
  dimStartDistance: uniform('emitter', 'dimStartDistance'),
  dimFloor: uniform('emitter', 'dimFloor'),
  // Scattered glow
  glowSize: uniform('glow', 'glowSize'),
  sizeAtFullHaze: uniform('glow', 'sizeAtFullHaze'),
  haloFalloff: uniform('halo', 'haloFalloff'),
  haloRadiance: uniform('halo', 'haloRadiance'),
  haloBackScatter: uniform('halo', 'haloBackScatter'),
  // Room
  roomAir: (value) => setAmbientCeiling(value),
  hazeCycle: (value, vis) => { vis.globalHazeCycle = value; },
  airHaze: (value, vis) => { if (vis.ambientHaze) vis.ambientHaze.setCeiling(value); },
  airGrain: (value, vis) => { if (vis.ambientHaze) vis.ambientHaze.setFieldDepth(value); },
  airScale: (value, vis) => {
    if (vis.ambientHaze) vis.ambientHaze.setScaleMultiplier(value);
  },
  // Bloom. Only meaningful once it has been taken off the haze follower --
  // `bloomManual` is what `setBloom` sets, and restoring a value has to set it
  // too or the follower would overwrite these on the next change of haze.
  bloomIntensity: (value, vis) => vis.setBloom('intensity', value),
  bloomThreshold: (value, vis) => vis.setBloom('threshold', value),
  bloomRadius: (value, vis) => vis.setBloom('radius', value),
};

/**
 * Applies a value and remembers it.
 *
 * @param {String} key one of `CONTROLS`
 * @param {Number} value
 * @param {Object} visualizer
 */
function write(key, value, visualizer) {
  const control = CONTROLS[key];
  if (!control) return;
  control(value, visualizer);
  Preferences.set(PREFIX + key, value);
}

/**
 * Forgets a stored value, so the source constant takes over again.
 *
 * @param {String} key
 */
function forget(key) {
  Preferences.set(PREFIX + key, undefined);
}

/**
 * Puts every stored value back.
 *
 * Called after `Preferences.load()`, and again once the composer exists, since
 * some targets are not built at the first call.
 *
 * @param {Object} visualizer
 * @returns {Number} how many values were restored
 */
function applyStored(visualizer) {
  let restored = 0;
  Object.keys(CONTROLS).forEach((key) => {
    const value = Preferences.get(PREFIX + key);
    if (value === undefined || value === null) return;
    CONTROLS[key](value, visualizer);
    restored += 1;
  });
  return restored;
}

/**
 * The stored value for a control, or undefined when it has never been moved.
 *
 * @param {String} key
 * @returns {Number|undefined}
 */
function stored(key) {
  return Preferences.get(PREFIX + key);
}

export default {
  write, forget, applyStored, stored, CONTROLS, PREFIX,
};
