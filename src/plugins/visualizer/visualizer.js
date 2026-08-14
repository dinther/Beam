/* eslint-disable */
// TODO: find a way for the linter to accept node_module nested libs
import * as THREE from 'three';

import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import Stats from 'stats.js';
import ModelInstancer from './model_instancer';
import SceneManager from './scene_manager';
import AnimationManager from './animation_manager';
import Controls from './controls';
import MovingHead from './moving_head';
import InfiniteGridHelper from './grid';
import LEDField from './led_field';
import DMXStore from './dmx_store';
import SceneEnv from './scene_env';
import Perf from './perf_overlay';
import createLEDDebugPanel from './led_debug_panel';
import {
  EffectComposer,
  RenderPass,
  EffectPass,
  BloomEffect,
  ToneMappingEffect,
  ToneMappingMode,
  KernelSize,
} from 'postprocessing';

/**
 * Post-processing composer.
 *
 * Module-scoped rather than stored on the Visualizer instance: the instance is
 * reached through a Vue-reactive handle, and three.js objects that come back
 * wrapped in a reactive Proxy break rendering.
 */
let finalComposer = null;

/**
 * Bloom pass, kept accessible so the fog controls can drive it.
 *
 * For broad emitters like LED strip there is no beam to draw, only a halo that
 * thickens as the air does -- and bloom already keys off how bright each
 * emitter rendered, so it inherits the emission cone for free. That makes
 * screen-space glare a fair stand-in for scattering, at no geometry cost.
 */
let bloomEffect = null;

/**
 * Whether screen-space bloom is part of the chain.
 *
 * Off: the world-space glow billboards on the emitters carry the halo instead,
 * which unlike bloom shrinks correctly with distance. Left as a switch rather
 * than deleted, since the two are complementary and bloom may earn its place
 * back for the lens-glare part.
 */
const USE_BLOOM = false;

/** Bloom response to fog density, which arrives as 0..1. */
const BLOOM_BY_FOG = {
  // Haze off is not glow off: a bright emitter still glares in any lens or eye.
  // Density adds the extra spread the air contributes on top of that floor.
  intensity: { min: 1.8, max: 5.0 },
  radius: { min: 0.40, max: 1.0 },
  threshold: { min: 0.30, max: 0.05 },
};

/**
 * THREE.Vector3 round prototype override.
 * Allows for precision-specified rounding
 *
 * @param {Number} digits Decimal place of rounding
 * @returns {Object} THREE.Vector3 instance
 * @todo put every overrides in an override.js module
 */
THREE.Vector3.prototype.round = function vector3RoundPolyfill(digits) {
  const e = 10 ** (digits || 0);
  this.x = Math.round(this.x * e) / e;
  this.y = Math.round(this.y * e) / e;
  this.z = Math.round(this.z * e) / e;
  return this;
};

/**
 * Default visualizer preferences values
 *
 * @constant
 * @type {String}
 * @default
 */
const DEFAULT_PREFERENCES = {
  FOGGING_STATE: true,
  FOGGING_DENSITY: 18,
  GLOBAL_FOGGING_TURBULENCES: 0,
  GLOBAL_BRIGHTNESS: 80,
};

/**
 * @class
 * @classdesc WebGL Visualizer instance
 */
class Visualizer {
  /**
   * Constructs Visualizer instance
   *
   * @param {Object} domElement handle to domElement to be used by the WEBGL renderer
   */
  constructor(domElement) {
    this.domElement = domElement;
    this.renderer = null;
    this.camera = null;
    this.controls = null;
    this.animation = null;
    this.finalComposer = null;
    this.globalBrightness = 100;
    this.globalLightHandle = null;
    this.autoRotate = false;
    this.autoFocus = true;
    this.stats = new Stats();
    this.stats.showPanel(0);
    this.stats.dom.style.position = 'absolute';
  }

  /**
   * Initialises WebGL Visualizer instance
   *
   * @public
   * @async
   */
  async init() {
    await ModelInstancer.init(`${import.meta.env.VITE_STATIC_URL}/visualizer/models/model_list.json`);
    this.prepareCamera();
    this.prepareRenderer();
    this.prepareControls();
    this.resize();
    Controls.init(this.camera, this.domElement, this.controls);
    this.startRender();
    this.main();
    this.resize();
  }

  /**
   * Visualizer preferences
   *
   * @type {Object}
   */
  set preferences(preferences) {
    if (preferences) {
      this.globalBrightness = preferences.globalBrightness;
      this.globalFoggingDensity = preferences.globalFoggingDensity;
      this.globalFoggingState = preferences.globalFoggingState;
      this.globalFoggingTurbulences = preferences.globalFoggingTurbulences;
    }
  }

  /**
   * Global scene fogging state
   * @type {Boolean}
   * @param {boolean} value
   */
  // eslint-disable-next-line class-methods-use-this
  set globalFoggingState(value) {
    SceneEnv.hazeEnabled = value === undefined || value === null
      ? DEFAULT_PREFERENCES.FOGGING_STATE
      : !!value;
    MovingHead.fogState = SceneEnv.hazeEnabled;
    this.applyFogToBloom();
  }

  // eslint-disable-next-line class-methods-use-this
  get globalFoggingState() {
    return SceneEnv.hazeEnabled ? 1 : 0;
  }

  /**
   * Global scene fogging density
   *
   * @type {Number}
   */
  set globalFoggingDensity(value) {
    SceneEnv.hazeDensity = Number.isFinite(value)
      ? Math.min(Math.max(value, 0), 100) / 100
      : DEFAULT_PREFERENCES.FOGGING_DENSITY / 100;
    MovingHead.fogDensity = SceneEnv.hazeDensity;
    this.applyFogToBloom();
  }

  // eslint-disable-next-line class-methods-use-this
  get globalFoggingDensity() {
    return SceneEnv.hazeDensity * 100;
  }

  /**
   * Global scene fogging turbulence
   *
   * @type {Number}
   */
  // eslint-disable-next-line class-methods-use-this
  set globalFoggingTurbulences(value) {
    const normalised = Number.isFinite(value)
      ? Math.min(Math.max(value, 0), 100) / 100
      : DEFAULT_PREFERENCES.GLOBAL_FOGGING_TURBULENCES / 100;
    SceneEnv.hazeTurbulence = normalised;
    // The beam shader scales this differently; keep its own convention.
    MovingHead.fogTurbulence = normalised * 2;
  }

  // eslint-disable-next-line class-methods-use-this
  get globalFoggingTurbulences() {
    return SceneEnv.hazeTurbulence * 100;
  }

  /**
   * Global scene brightness
   *
   * @type {Number}
   */
  set globalBrightness(value) {
    this._globalBrightness = value ? value / 100 : DEFAULT_PREFERENCES.GLOBAL_BRIGHTNESS;
    if (this.globalLightHandle) {
      this.globalLightHandle.intensity = this._globalBrightness * 0.25;
    }
  }

  get globalBrightness() {
    return this._globalBrightness * 100;
  }

  /**
   * Global scene brightness
   *
   * @type {Number}
   */
    set autoFocus(value) {
      Controls.autoFocus = value;
    }
  
    get autoFocus() {
      return Controls.autoFocus;
    }

  /**
   * Controls auto-rotation state
   * 
   * @type {Boolean}
   */
  set autoRotate(value) {
    if(this.controls){
      this.controls.autoRotate = value;
    }
  }

  get autoRotate(){
    if(this.controls){ 
      return this.controls.autoRotate
    }
    return false;
  }

  get showData() {
    return {
      globalFoggingState: this.globalFoggingState,
      globalFoggingDensity: this.globalFoggingDensity,
      globalFoggingTurbulences: this.globalFoggingTurbulences,
      globalBrightness: this.globalBrightness,
      autoRotate: this.autoRotate,
    };
  }

  /**
   * Recenters the camera to point at (0,0,0)
   */
  recenter(){
    Controls.setFocus(false);
  }

  /**
   * Starts rendering loop.
   * Pools the rendering function into the animation manager's pool
   *
   * @public
   */
  startRender() {
    if (!this.animation) {
      this.stats.dom.style.display = 'initial';
      this.animation = AnimationManager.add(this.render.bind(this));
    }
  }

  /**
   * Stops rendering loop.
   * Removes of the rendering function from the animation manager's pool
   *
   * @public
   */
  stopRender() {
    if (this.animation) {
      AnimationManager.dispose(this.animation);
      this.animation = null;
    }
  }

  /**
   * Sets up visualizer environment
   *
   * @public
   * @async
   */
  async main() {
    this.globalLightHandle = new THREE.DirectionalLight('white', this._globalBrightness * 100);
    this.globalLightHandle.castShadow = false;
    this.globalLightHandle.position.set(-10, -10, 10);

    MovingHead.prepareInstanciation(this.camera, SceneManager);

    // Safe only now: MovingHead's fog getters read through the beam mesh,
    // which does not exist until instancing has been prepared.
    this.applyFogToBloom();

    AnimationManager.add((t) => {
      MovingHead.update(t);
      LEDField.update(t);
    });

    // Floor
    const loader = new THREE.TextureLoader()
    .setPath(import.meta.env.VITE_STATIC_URL)
    const texture = await loader.loadAsync('./visualizer/textures/environment/checkerboard_default.jpg');

    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(8, 8);

    const gridHelper = new InfiniteGridHelper(5, 100, new THREE.Color('white'), 100);
    gridHelper.rotateX(Math.PI / 2.0);
    gridHelper.position.setZ(-0.3);
    SceneManager.add(gridHelper);

    const axesHelper = new THREE.AxesHelper(2);

    axesHelper.material.depthTest = false;
    axesHelper.renderOrder = 999;

    axesHelper.material.transparent = true;
    axesHelper.material.opacity = 0.8;

    axesHelper.setColors(
      new THREE.Color('#ff4d4d'), // X
      new THREE.Color('#4dff88'), // Y
      new THREE.Color('#4da6ff')  // Z
    );

    const checkerMaterial = new THREE.MeshStandardMaterial({ map: texture });

    const sideMaterial = new THREE.MeshStandardMaterial();

    const floorMaterial = [];

    floorMaterial.push(sideMaterial);
    floorMaterial.push(sideMaterial);
    floorMaterial.push(sideMaterial);
    floorMaterial.push(sideMaterial);
    floorMaterial.push(checkerMaterial);

    const floor_geometry = new THREE.BoxGeometry(50, 50, 0.5, 1, 1, 1);
    const floor = new THREE.Mesh(floor_geometry, checkerMaterial);
    floor.position.setZ(-0.25);

    this.globalLightHandle.target = floor;

    SceneManager.add(this.globalLightHandle, floor, axesHelper);

    // Proof-of-concept LED bar matrix, driven straight from Art-Net.
    //
    // Addressing is one continuous pixel stream across universes at 170 pixels
    // (510 channels) each, so channels 511 and 512 are never used and no pixel
    // is split across a universe boundary. 100 bars of 60 LEDs is 6,000 pixels,
    // spanning 36 universes.
    DMXStore.attachArtNet();

    // A flat wall of bars: 3 across, 30 high. Columns are spaced by the bar's
    // own length so they butt end to end into continuous rows; rows keep the
    // 300 mm pitch. 90 bars of 60 LEDs is 5,400 pixels, spanning 32 universes.
    const COLUMNS = 3;
    const ROWS = 30;
    // 3 columns of 1.05 m is 3.15 m wide, so 30 rows at 105 mm make the wall
    // roughly square.
    const ROW_PITCH = 0.105;
    const COLUMN_PITCH = 1.05;
    const LEDS_PER_BAR = 60;
    const BASE_HEIGHT = 0.5;

    const columnOrigin = -((COLUMNS - 1) * COLUMN_PITCH) / 2;

    LEDField.init({
      scene: SceneManager,
      maxBars: COLUMNS * ROWS,
      maxLeds: COLUMNS * ROWS * LEDS_PER_BAR,
    });

    for (let row = 0; row < ROWS; row += 1) {
      // Serpentine wiring: the chain runs left to right along even rows and
      // back right to left along odd ones, so consecutive rows join at the end
      // nearest each other instead of needing a return cable.
      const reversed = row % 2 === 1;

      for (let column = 0; column < COLUMNS; column += 1) {
        // Where this bar sits in the chain, which on a reversed row is the
        // mirror of where it sits physically.
        const chainPosition = reversed ? COLUMNS - 1 - column : column;
        const index = row * COLUMNS + chainPosition;

        LEDField.addBar({
          position: new THREE.Vector3(
            columnOrigin + column * COLUMN_PITCH,
            0,
            BASE_HEIGHT + row * ROW_PITCH,
          ),
          // Tilted 45 degrees off straight-down, angled toward the camera side.
          roll: 225,
          density: LEDS_PER_BAR,
          firstPixel: index * LEDS_PER_BAR,
          reverse: reversed,
        });
      }
    }

    // Debug panel for the LED proof of concept. Writes straight into shader
    // uniforms so values can be found by eye rather than by rebuild.
    createLEDDebugPanel(this);
  }

  /**
   * Prepares WebGL renderer
   *
   * @public
   */
  prepareRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.domElement,
      antialias: true,
    });

    this.renderer.autoClear = true;
    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.physicallyCorrectLights = true;
    this.renderer.setPixelRatio(0.8); // Forcing pixel ratio to 1 to avoid unnecessary computations
    // Tone mapping moves into the composer. Left on the renderer it is applied
    // per material, clamping emitters to white before bloom can tell that they
    // are brighter than white.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.prepareComposer();
    Perf.init(this.renderer);
  }

  /**
   * Builds the post-processing chain.
   *
   * The half-float frame buffer is what makes this worth doing: values above
   * 1.0 survive the render instead of clipping, so bloom can distinguish an
   * emitter from a merely white surface.
   *
   * @public
   */
  prepareComposer() {
    finalComposer = new EffectComposer(this.renderer, {
      frameBufferType: THREE.HalfFloatType,
    });

    finalComposer.addPass(new RenderPass(SceneManager, this.camera));

    if (USE_BLOOM) {
      bloomEffect = new BloomEffect({
        intensity: BLOOM_BY_FOG.intensity.min,
        luminanceThreshold: BLOOM_BY_FOG.threshold.min,
        luminanceSmoothing: 0.4,
        mipmapBlur: true,
        radius: BLOOM_BY_FOG.radius.min,
        kernelSize: KernelSize.LARGE,
      });
    }

    const toneMapping = new ToneMappingEffect({
      mode: ToneMappingMode.ACES_FILMIC,
    });

    const effects = bloomEffect ? [bloomEffect, toneMapping] : [toneMapping];
    finalComposer.addPass(new EffectPass(this.camera, ...effects));
  }

  /**
   * Drives bloom from the scene's fog settings, so one haze control governs
   * both the moving-head beams and the glow around broad emitters.
   *
   * @public
   */
  applyFogToBloom() {
    // Renderers read haze from SceneEnv themselves; nothing to push here.
    const density = SceneEnv.hazeAmount;

    if (!bloomEffect) return;
    const lerp = (range) => range.min + (range.max - range.min) * density;

    bloomEffect.intensity = lerp(BLOOM_BY_FOG.intensity);
    bloomEffect.mipmapBlurPass.radius = lerp(BLOOM_BY_FOG.radius);
    bloomEffect.luminanceMaterial.threshold = lerp(BLOOM_BY_FOG.threshold);
  }

  /**
   * Prepares Visualizer's camera
   *
   * @public
   */
  prepareCamera() {
    const width = this.domElement.offsetWidth;
    const height = this.domElement.clientHeight;
    const aspect = width / height;
    this.camera = new THREE.PerspectiveCamera(45, aspect, 0.01, 1000);
    this.camera.up.set(0, 0, 1);
    // Framed on the LED array, which is centred at z = 2. Kept in step with
    // Controls.DEFAULT_ZOOM_OUT_ENDPOS so the opening frame and whatever the
    // focus animation settles on are the same view.
    this.camera.position.set(2.0, 6.0, 0.4);
    this.camera.lookAt(0, 0, 2.0);
  }

  /**
   * Prepares Visualizer's camera controls
   *
   * @public
   */
  prepareControls() {
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.screenSpacePannning = false;
    this.controls.minDistance = 0.2;
    this.controls.maxDistance = 100;
    this.controls.target.set(0, 0, 2.0);
    // Was PI / 2.1, which pinned the orbit just above horizontal. Fixtures
    // aimed downward can only be seen from underneath, so the camera has to be
    // able to get below them; stopping just short of the pole avoids the
    // gimbal flip at straight-up.
    this.controls.maxPolarAngle = Math.PI * 0.98;
    this.controls.autoRotate = this.autoRotate;
    this.controls.autoRotateSpeed = 5
    AnimationManager.add(() => {
      this.controls.update();
    });
  }

  /**
   * Resize handler.
   * Handles renderer's resizing and ensures preservation of screen aspect ratio.
   *
   * @public
   */
  resize() {
    const width = this.domElement.offsetWidth;
    const height = this.domElement.clientHeight;
    const aspect = width / height;
    if (this.width !== width || this.height !== height) {
      this.width = width;
      this.height = height;
      this.renderer.setSize(width, height);
      if (finalComposer) finalComposer.setSize(width, height);
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Render function
   *
   * @public
   */
  render() {
    Perf.begin();
    // Repeated when measuring: on a fast card a single pass finishes long
    // before vsync, so the cost is invisible until it suddenly is not.
    for (let pass = 0; pass < Perf.getPasses(); pass += 1) {
      if (finalComposer) {
        finalComposer.render();
      } else {
        this.renderer.render(SceneManager, this.camera);
      }
    }
    Perf.end();
  }
}

export default Visualizer;
