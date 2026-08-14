// eslint-disable-next-line import/extensions, import/no-unresolved
import GUI from 'three/examples/jsm/libs/lil-gui.module.min.js';
import LEDField from './led_field';
import Perf from './perf_overlay';

/**
 * @file Debug panel for the LED bar proof of concept.
 *
 * Every control writes straight into a shader uniform, so changes show on the
 * next frame with no rebuild. This exists to find the values worth hard-coding;
 * it is not intended to survive into the real fixture UI.
 */

/**
 * Writes a shared uniform.
 *
 * There is exactly one of each across the whole field, so this is a single
 * assignment rather than a loop over fixtures.
 *
 * @param {String} group 'emitter' or 'glow'
 * @param {String} name uniform name
 * @param {Number} value
 */
function setUniform(group, name, value) {
  const uniforms = LEDField.tunables();
  if (!uniforms) return;
  const uniform = uniforms[group][name];
  if (uniform) uniform.value = value;
}

/**
 * Builds the panel. Safe to call when no bars exist -- it simply does nothing.
 *
 * @param {Object} visualizer Visualizer instance, for the haze controls
 * @returns {Object|null} the GUI instance
 */
export default function createLEDDebugPanel(visualizer) {
  const uniforms = LEDField.tunables();
  if (!uniforms) return null;

  const gui = new GUI({ title: 'LED bar (debug)' });
  gui.domElement.style.position = 'absolute';
  gui.domElement.style.top = '8px';
  gui.domElement.style.right = '8px';
  gui.domElement.style.zIndex = '100';

  const { emitter, glow } = uniforms;

  const state = {
    // Emitter die
    gain: emitter.gain.value,
    beamAngle: (Math.acos(emitter.beamCutoff.value) * 180) / Math.PI,
    haloStrength: emitter.haloStrength.value,
    backScatter: emitter.backScatter.value,
    coreRadius: emitter.coreRadius.value,
    // Distance dimming
    dimStartDistance: emitter.dimStartDistance.value,
    dimFloor: emitter.dimFloor.value,
    // Scattered glow
    glowSize: glow.glowSize.value,
    glowGain: glow.glowGain.value,
    glowFalloff: glow.glowFalloff.value,
    glowBackScatter: glow.backScatter.value,
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
  die.add(state, 'beamAngle', 10, 180, 1)
    .name('beam angle (full)')
    .onChange((v) => setUniform('emitter', 'beamCutoff', Math.cos((v / 2) * (Math.PI / 180))));
  die.add(state, 'haloStrength', 0, 2, 0.01)
    .onChange((v) => setUniform('emitter', 'haloStrength', v));
  die.add(state, 'coreRadius', 0.02, 0.6, 0.005)
    .name('die size')
    .onChange((v) => setUniform('emitter', 'coreRadius', v));
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
  scatter.add(state, 'glowSize', 0.01, 1.0, 0.005)
    .name('size at full haze (m)')
    .onChange((v) => setUniform('glow', 'glowSize', v));
  scatter.add(state, 'glowGain', 0, 3, 0.01)
    .name('strength')
    .onChange((v) => setUniform('glow', 'glowGain', v));
  scatter.add(state, 'glowFalloff', 0.5, 500, 0.5)
    .name('falloff sharpness')
    .onChange((v) => setUniform('glow', 'glowFalloff', v));
  scatter.add(state, 'glowBackScatter', 0, 1, 0.01)
    .name('omnidirectional')
    .onChange((v) => setUniform('glow', 'backScatter', v));
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
