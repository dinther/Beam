// eslint-disable-next-line import/extensions, import/no-unresolved
import GUI from 'three/examples/jsm/libs/lil-gui.module.min.js';
import LEDField from './led_field';
import LEDPanel from './led_panel';
import Perf from './perf_overlay';
import SceneEnv from './scene_env';
import { ambientCeiling } from './ambient';
import Tuning from './tuning';

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
    sizeAtFullHaze: glow.sizeAtFullHaze.value,
    haloFalloff: halo.haloFalloff.value,
    haloRadiance: halo.haloRadiance.value,
    haloBackScatter: halo.haloBackScatter.value,
    // Scene
    hazeDensity: visualizer.globalFoggingDensity,
    hazeScale: visualizer.globalFoggingScale,
    hazeEnabled: !!visualizer.globalFoggingState,
    turbulence: visualizer.globalFoggingTurbulences,
    hazeCycle: visualizer.globalHazeCycle,
    ambient: ambientCeiling(),
    airHaze: visualizer.ambientHaze ? visualizer.ambientHaze.ceiling : 0,
    airGrain: visualizer.ambientHaze ? visualizer.ambientHaze.fieldDepth() : 0,
    airScale: visualizer.ambientHaze ? visualizer.ambientHaze.scaleMultiplier : 1,
    // Measurement
    passes: Perf.getPasses(),
  };

  const die = gui.addFolder('Emitter die');
  die.add(state, 'gain', 0, 8, 0.05)
    .onChange((v) => Tuning.write('gain', v, visualizer));
  die.add(state, 'haloStrength', 0, 2, 0.01)
    .onChange((v) => Tuning.write('haloStrength', v, visualizer));
  die.add(state, 'coreScale', 0.25, 4, 0.05)
    .name('die size x')
    .onChange((v) => Tuning.write('coreScale', v, visualizer));
  die.add(state, 'backScatter', 0, 1, 0.01)
    .name('back scatter')
    .onChange((v) => Tuning.write('backScatter', v, visualizer));

  const distance = gui.addFolder('Distance dimming');
  distance.add(state, 'dimStartDistance', 0.2, 20, 0.1)
    .name('full gain beyond')
    .onChange((v) => Tuning.write('dimStartDistance', v, visualizer));
  distance.add(state, 'dimFloor', 0, 1, 0.01)
    .name('closest dim')
    .onChange((v) => Tuning.write('dimFloor', v, visualizer));

  const scatter = gui.addFolder('Scattered glow');
  // Falloff first: it is the one that decides whether the glow reads as air or
  // as a wash, and the one worth reaching for before anything else.
  scatter.add(state, 'haloFalloff', 1, 24, 0.25)
    .name('falloff sharpness')
    .onChange((v) => Tuning.write('haloFalloff', v, visualizer));
  // The volume's only brightness. There used to be a second, `strength`, which
  // multiplied the same result -- two controls for one quantity, so a value
  // reached through them could not be read back off either.
  scatter.add(state, 'haloRadiance', 0, 4, 0.01)
    .name('brightness')
    .onChange((v) => Tuning.write('haloRadiance', v, visualizer));
  // Reach is authored per fixture from its own size; this scales all of them
  // together, against the size the look was built at. Stops at 1.5 because the
  // marched box is built with exactly that much headroom -- past it the shader
  // clamps, and a slider that goes on moving while nothing changes is worse
  // than one that stops.
  scatter.add(state, 'glowSize', 0.01, 1.5, 0.005)
    .name('reach x')
    .onChange((v) => Tuning.write('glowSize', v, visualizer));
  scatter.add(state, 'haloBackScatter', 0, 1, 0.01)
    .name('omnidirectional')
    .onChange((v) => Tuning.write('haloBackScatter', v, visualizer));
  // How far the glow reaches once the air is thick, against its authored size.
  // Stops at 1.5 because that is the headroom the panel's marched box was built
  // with; past it the shader clamps, and a slider that keeps moving while
  // nothing changes is worse than one that stops.
  scatter.add(state, 'sizeAtFullHaze', 0.5, 1.5, 0.01)
    .name('reach at full haze x')
    .onChange((v) => Tuning.write('sizeAtFullHaze', v, visualizer));

  // Haze now multiplies the authored glow values rather than replacing them,
  // so these no longer disturb the sliders above.
  const scene = gui.addFolder('Scene haze');
  const enabled = scene.add(state, 'hazeEnabled')
    .name('haze on')
    .onChange((v) => {
      visualizer.globalFoggingState = v ? 1 : 0;
    });
  // Amount, and only amount. This used to be the noise scale as well, so
  // turning the haze up made its grain coarser instead of making it stronger
  // -- one control for two quantities, and neither readable off it.
  const density = scene.add(state, 'hazeDensity', 0, 100, 1)
    .name('intensity')
    .onChange((v) => {
      visualizer.globalFoggingDensity = v;
    });
  // The other half of what density used to mean. Metres, because it is a size
  // in the room: fine wisps at the bottom of the range, slow billows at the
  // top, and the beams themselves are a couple of metres of it.
  const metres = scene.add(state, 'hazeScale', 2, 15, 0.1)
    .name('haze scale (m)')
    .onChange((v) => {
      visualizer.globalFoggingScale = v;
    });
  const churn = scene.add(state, 'turbulence', 0, 100, 1)
    .name('turbulence')
    .onChange((v) => {
      visualizer.globalFoggingTurbulences = v;
    });
  // The room is the source of these four, and the panel follows it.
  //
  // lil-gui holds its own copy of every value, taken when the control is
  // built. This panel is built during `main()`, and the haze settings used to
  // arrive afterwards -- so the folder showed haze off at zero intensity for
  // the rest of the session while the scene ran on the stored values. The
  // reading was wrong, not the scene. `SceneEnv` now has its numbers before
  // any of this is built, and announces every later change, so the two cannot
  // drift again.
  const followRoom = () => {
    state.hazeEnabled = !!visualizer.globalFoggingState;
    state.hazeDensity = visualizer.globalFoggingDensity;
    state.hazeScale = visualizer.globalFoggingScale;
    state.turbulence = visualizer.globalFoggingTurbulences;
    enabled.updateDisplay();
    density.updateDisplay();
    metres.updateDisplay();
    churn.updateDisplay();
  };
  followRoom();
  SceneEnv.on('changed', followRoom);

  // Screen-space bloom. Normally it follows haze density and needs no controls
  // at all -- these exist to find the values worth keeping, which is what this
  // whole panel is for. Touching any slider takes the bloom off the haze
  // follower until Follow haze is ticked again, or the next change of haze
  // would undo whatever was just set.
  const bloomState = visualizer.bloom;
  if (bloomState) {
    const bloom = gui.addFolder('Bloom');
    bloom.close();
    const local = {
      intensity: bloomState.intensity,
      threshold: bloomState.threshold,
      radius: bloomState.radius,
      followHaze: !bloomState.manual,
    };
    const follow = bloom.add(local, 'followHaze')
      .name('follow haze')
      .onChange((v) => {
        if (v) {
          visualizer.releaseBloom();
          // Forgotten rather than stored: following the haze is the absence of
          // an override, so remembering "follow" as a value would give the
          // fog a stored opinion to argue with.
          ['bloomIntensity', 'bloomThreshold', 'bloomRadius'].forEach(Tuning.forget);
        } else {
          Tuning.write('bloomIntensity', local.intensity, visualizer);
        }
      });
    const handOver = () => { local.followHaze = false; follow.updateDisplay(); };
    bloom.add(local, 'intensity', 0, 6, 0.05)
      .onChange((v) => { handOver(); Tuning.write('bloomIntensity', v, visualizer); });
    bloom.add(local, 'threshold', 0, 1, 0.01)
      .name('brightness gate')
      .onChange((v) => { handOver(); Tuning.write('bloomThreshold', v, visualizer); });
    bloom.add(local, 'radius', 0, 1, 0.01)
      .name('spread')
      .onChange((v) => { handOver(); Tuning.write('bloomRadius', v, visualizer); });
  }

  // Everything below is set-once tuning rather than something to reach for
  // while working, so it starts closed. Nine controls in one flat list is how
  // a panel stops being usable.
  const tuning = scene.addFolder('Room tuning');
  tuning.close();

  // Palette cycling, done in the shader. The baked field is frozen, so this is
  // what puts motion back into it -- brightness sweeping along the field's own
  // contours rather than the field itself changing shape. Inert unless the
  // beam shader was built with HAZE_MODE 2.
  tuning.add(state, 'hazeCycle', 0, 100, 1)
    .name('contour cycling')
    .onChange((v) => {
      Tuning.write('hazeCycle', v, visualizer);
    });

  // Environment fill at full house lights. The scene had none until
  // 2026-08-28: one directional light meant every surface facing away from it
  // rendered pure black. Too much washes the show out, too little brings the
  // black faces back, and only the eye can settle it against real beams.
  tuning.add(state, 'ambient', 0, 1.5, 0.01)
    .name('ambient fill')
    .onChange((v) => Tuning.write('roomAir', v, visualizer));

  // Haze in the air itself, rather than only where a fixture draws geometry.
  // This is the one with a real per-pixel cost -- six samples over the whole
  // screen -- so watch gpuMs while dragging it, and zero is exactly the
  // behaviour that shipped before.
  scene.add(state, 'airHaze', 0, 2, 0.01)
    .name('room air')
    .onChange((v) => {
      Tuning.write('airHaze', v, visualizer);
    });

  // How much of the air's density is the noise field rather than uniform.
  // Zero is perfectly smooth and cannot grain at all; it is the honest dial for
  // the trade, since grain is the variance of an 8-sample estimate.
  tuning.add(state, 'airGrain', 0, 1, 0.01)
    .name('air texture')
    .onChange((v) => {
      Tuning.write('airGrain', v, visualizer);
    });

  // Air feature size against the scene's haze scale. 1 matches the beams
  // exactly, which is the point -- one field, one source. Larger is coarser
  // air and less grain, which is the trade this was set at 3 for by mistake.
  tuning.add(state, 'airScale', 0.5, 4, 0.05)
    .name('air feature size x')
    .onChange((v) => {
      Tuning.write('airScale', v, visualizer);
    });

  const perf = gui.addFolder('Measurement');
  perf.add(state, 'passes', 1, 16, 1)
    .name('render passes')
    .onChange((v) => Perf.setPasses(v));

  return gui;
}
