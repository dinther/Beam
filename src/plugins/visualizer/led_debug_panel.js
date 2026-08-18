// eslint-disable-next-line import/extensions, import/no-unresolved
import GUI from 'three/examples/jsm/libs/lil-gui.module.min.js';
import LEDField from './led_field';
import LEDPanel from './led_panel';
import Perf from './perf_overlay';

/**
 * @file Debug panel for the LED bar proof of concept.
 *
 * Every control writes straight into a shader uniform, so changes show on the
 * next frame with no rebuild. This exists to find the values worth hard-coding;
 * it is not intended to survive into the real fixture UI.
 */

/**
 * Every tunable uniform, by group.
 *
 * `halo` belongs to the panel path -- the marched glow volume -- and is kept
 * apart from `glow`, which is the billboard blob. They mean different things by
 * a falloff, so one control cannot serve both.
 *
 * @returns {Object|null} `{ emitter, glow, halo }`
 */
function tunableGroups() {
  const field = LEDField.tunables();
  if (!field) return null;
  return { ...field, halo: LEDPanel.tunables() };
}

/**
 * Writes a shared uniform.
 *
 * There is exactly one of each across the whole field, so this is a single
 * assignment rather than a loop over fixtures.
 *
 * @param {String} group 'emitter', 'glow' or 'halo'
 * @param {String} name uniform name
 * @param {Number} value
 */
function setUniform(group, name, value) {
  const groups = tunableGroups();
  if (!groups || !groups[group]) return;
  const uniform = groups[group][name];
  if (uniform) uniform.value = value;
}

/**
 * Builds the panel. Safe to call when no bars exist -- it simply does nothing.
 *
 * @param {Object} visualizer Visualizer instance, for the haze controls
 * @returns {Object|null} the GUI instance
 */
export default function createLEDDebugPanel(visualizer, host) {
  const uniforms = tunableGroups();
  if (!uniforms) return null;

  // Anchored inside the 3D viewport rather than the window, so it stays clear
  // of the panels beside it. Absolute positioning needs a positioned
  // ancestor, and without one it would fall back to the document.
  const container = host || document.body;
  if (container !== document.body && getComputedStyle(container).position === 'static') {
    container.style.position = 'relative';
  }

  const gui = new GUI({ title: 'LED bar (debug)', container });
  gui.domElement.style.position = 'absolute';
  // Bottom right: the navigation cube owns the opposite corner.
  gui.domElement.style.bottom = '8px';
  gui.domElement.style.right = '8px';
  gui.domElement.style.top = '';
  gui.domElement.style.zIndex = '100';

  const { emitter, glow, halo } = uniforms;

  const state = {
    // Emitter die
    gain: emitter.gain.value,
    haloStrength: emitter.haloStrength.value,
    backScatter: emitter.backScatter.value,
    coreScale: emitter.coreScale.value,
    // Distance dimming
    dimStartDistance: emitter.dimStartDistance.value,
    dimFloor: emitter.dimFloor.value,
    // Scattered glow
    glowSize: glow.glowSize.value,
    haloFalloff: halo.haloFalloff.value,
    haloRadiance: halo.haloRadiance.value,
    haloBackScatter: halo.haloBackScatter.value,
    turbulenceScale: glow.turbulenceScale.value,
    // Scene
    hazeDensity: visualizer.globalFoggingDensity,
    hazeEnabled: !!visualizer.globalFoggingState,
    turbulence: visualizer.globalFoggingTurbulences,
    // Measurement
    passes: Perf.getPasses(),
  };

  const die = gui.addFolder('Emitter die');
  die.add(state, 'gain', 0, 8, 0.05)
    .onChange((v) => setUniform('emitter', 'gain', v));
  die.add(state, 'haloStrength', 0, 2, 0.01)
    .onChange((v) => setUniform('emitter', 'haloStrength', v));
  die.add(state, 'coreScale', 0.25, 4, 0.05)
    .name('die size x')
    .onChange((v) => setUniform('emitter', 'coreScale', v));
  die.add(state, 'backScatter', 0, 1, 0.01)
    .name('back scatter')
    .onChange((v) => setUniform('emitter', 'backScatter', v));

  const distance = gui.addFolder('Distance dimming');
  distance.add(state, 'dimStartDistance', 0.2, 20, 0.1)
    .name('full gain beyond')
    .onChange((v) => setUniform('emitter', 'dimStartDistance', v));
  distance.add(state, 'dimFloor', 0, 1, 0.01)
    .name('closest dim')
    .onChange((v) => setUniform('emitter', 'dimFloor', v));

  const scatter = gui.addFolder('Scattered glow');
  // Falloff first: it is the one that decides whether the glow reads as air or
  // as a wash, and the one worth reaching for before anything else.
  scatter.add(state, 'haloFalloff', 1, 24, 0.25)
    .name('falloff sharpness')
    .onChange((v) => setUniform('halo', 'haloFalloff', v));
  // The volume's only brightness. There used to be a second, `strength`, which
  // multiplied the same result -- two controls for one quantity, so a value
  // reached through them could not be read back off either.
  scatter.add(state, 'haloRadiance', 0, 4, 0.01)
    .name('brightness')
    .onChange((v) => setUniform('halo', 'haloRadiance', v));
  // Reach is authored per fixture from its own size; this scales all of them
  // together, against the size the look was built at. Stops at 1.5 because the
  // marched box is built with exactly that much headroom -- past it the shader
  // clamps, and a slider that goes on moving while nothing changes is worse
  // than one that stops.
  scatter.add(state, 'glowSize', 0.01, 1.5, 0.005)
    .name('reach x')
    .onChange((v) => setUniform('glow', 'glowSize', v));
  scatter.add(state, 'haloBackScatter', 0, 1, 0.01)
    .name('omnidirectional')
    .onChange((v) => setUniform('halo', 'haloBackScatter', v));
  scatter.add(state, 'turbulenceScale', 0.1, 8, 0.1)
    .name('turbulence scale (m)')
    .onChange((v) => setUniform('glow', 'turbulenceScale', v));

  // Haze now multiplies the authored glow values rather than replacing them,
  // so these no longer disturb the sliders above.
  const scene = gui.addFolder('Scene haze');
  scene.add(state, 'hazeEnabled')
    .name('haze on')
    .onChange((v) => {
      visualizer.globalFoggingState = v ? 1 : 0;
    });
  scene.add(state, 'hazeDensity', 0, 100, 1)
    .name('density')
    .onChange((v) => {
      visualizer.globalFoggingDensity = v;
    });
  scene.add(state, 'turbulence', 0, 100, 1)
    .name('turbulence')
    .onChange((v) => {
      visualizer.globalFoggingTurbulences = v;
    });

  const perf = gui.addFolder('Measurement');
  perf.add(state, 'passes', 1, 16, 1)
    .name('render passes')
    .onChange((v) => Perf.setPasses(v));

  return gui;
}
