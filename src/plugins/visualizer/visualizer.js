/* eslint-disable */
// TODO: find a way for the linter to accept node_module nested libs
import * as THREE from 'three';
import { markRaw } from 'vue';

import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import Stats from 'stats.js';
import ModelInstancer from './model_instancer';
import SceneManager from './scene_manager';
import AnimationManager from './animation_manager';
import Controls from './controls';
import ViewCube from './view_cube';
import MovingHead from './moving_head';
import InfiniteGridHelper from './grid';
import LEDField from './led_field';
import LEDPanel from './led_panel';
import DMXStore from './dmx_store';
import SceneObjects from './scene_objects';

/** Room reserved for patched LED fixtures, on top of the scene's own bars. */
const LED_FIXTURE_BAR_CAPACITY = 256;
/**
 * Billboard capacity: one quad per LED, and nothing asks for any.
 *
 * Every LED fixture is built by `Fixture.prepare3DModelInstance`, which hands
 * its bar an addressing function, and a bar with one draws through the panel
 * renderer -- a single surface, whatever its pixel count. The billboard path
 * that this number sizes is left with no callers, so 20,000 of them bought
 * megabytes of instance matrices and attributes that were allocated at startup
 * and never written to.
 *
 * Zero builds none of it. Raise it to bring the path back for anything that
 * cannot be a surface -- a strip bent along a polyline is the case it was
 * written for.
 */
const LED_FIXTURE_LED_CAPACITY = 0;

/** How far a press may travel and still count as a click on the gizmo. */
const VIEW_CUBE_CLICK_SLOP_PX = 4;
import SceneEnv from './scene_env';
import { hazeCycle, setHazeCycle } from './haze_noise';
import { installAmbient, setHouseBrightness } from './ambient';
import AmbientHazeEffect from './ambient_haze';
import Perf from './perf_overlay';
import Preferences from './preferences';
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
 * Ambient haze pass, kept accessible so the debug panel and the house lights
 * can reach it. Module-scoped for the same reason the composer is.
 */
let ambientHazeEffect = null;

/**
 * Scene reference helpers.
 *
 * Module-scoped rather than stored on the Visualizer instance: the instance is
 * reached through a Vue-reactive handle, and three.js cannot render a proxied
 * Object3D.
 */
const helpers = {
  grid: null,
  axes: null,
  floor: null,
  gridVisible: true,
  axesVisible: true,
  floorVisible: true,
};

/**
 * Coerces a preference value to a boolean.
 *
 * Values arrive from several places -- a checkbox, a showfile, or a select
 * emitting an index -- so anything absent means "leave it on", but a literal
 * zero means off. Comparing against `false` alone gets that backwards.
 *
 * @param {*} value
 * @returns {Boolean}
 */
function asVisible(value) {
  return value === undefined || value === null ? true : !!value;
}

/** Pushes stored visibility onto whichever helpers have been built. */
function applyHelperVisibility() {
  if (helpers.grid) helpers.grid.visible = helpers.gridVisible;
  if (helpers.axes) helpers.axes.visible = helpers.axesVisible;
  if (helpers.floor) helpers.floor.visible = helpers.floorVisible;
}

/**
 * Whether screen-space bloom is part of the chain.
 *
 * Off: the world-space glow billboards on the emitters carry the halo instead,
 * which unlike bloom shrinks correctly with distance. Left as a switch rather
 * than deleted, since the two are complementary and bloom may earn its place
 * back for the lens-glare part.
 */
const USE_BLOOM = false;

/**
 * Background shown while the house lights are up.
 *
 * rgb(60, 60, 60). Work light means a lit room, and a lit room does not have a
 * near-black void behind it -- the stored background is for a show, where the
 * dark is the point. The preference is not overwritten: this is what is on
 * screen, not what was chosen.
 *
 * @constant {String}
 */
const HOUSE_LIGHTS_BACKGROUND = '#3c3c3c';

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
  // Full haze. This was 18 when it doubled as the noise scale; as an amount
  // that would be a beam at a fifth of its brightness.
  FOGGING_DENSITY: 100,
  /** Width of one haze feature, in metres. Size, not amount. */
  FOGGING_SCALE: 4.9,
  GLOBAL_FOGGING_TURBULENCES: 100,
  GLOBAL_BRIGHTNESS: 100,
  BRIGHTNESS_HOUSE_OFF: 30,
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
    // Loaded before anything is built, so the scene comes up already dressed
    // rather than flickering through defaults.
    await Preferences.load();
    await ModelInstancer.init(`${import.meta.env.VITE_STATIC_URL}/visualizer/models/model_list.json`);
    this.prepareCamera();
    this.prepareRenderer();
    this.prepareControls();
    this.resize();
    Controls.init(this.camera, this.domElement, this.controls);
    this.prepareViewCube();
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
    // Falls back to the stored preferences, which is how the visualizer dresses
    // itself on startup without a show being involved.
    const source = preferences || Preferences.all();
    // The switch first: it decides which of the two brightnesses is the one
    // to dress the scene with.
    this._houseLights = source.houseLights !== false;
    // Straight to SceneEnv too: this assigns the field rather than going
    // through the setter, and `hazeAmount` is folded on the house lights.
    SceneEnv.houseLights = this._houseLights;
    this._brightnessUp = Visualizer.asBrightness(
      source.globalBrightness,
      DEFAULT_PREFERENCES.GLOBAL_BRIGHTNESS,
    );
    this._brightnessDown = Visualizer.asBrightness(
      source.brightnessHouseOff,
      DEFAULT_PREFERENCES.BRIGHTNESS_HOUSE_OFF,
    );
    this.applyBrightness();
    this.globalFoggingDensity = source.globalFoggingDensity;
    this.globalFoggingScale = source.globalFoggingScale;
    this.globalFoggingState = source.globalFoggingState;
    this.globalFoggingTurbulences = source.globalFoggingTurbulences;
    this.snapEnabled = source.snapEnabled !== false;
    this.snapSpacing = source.snapSpacing;
    this.showGrid = source.showGrid;
    this.showAxes = source.showAxes;
    this.showFloor = source.showFloor;
    this.debug = source.debug;
    this.backgroundColor = source.backgroundColor;
    // The stored colour may be undefined, and the house switch was read above,
    // so settle what is actually on screen either way.
    this.applyBackground();
  }

  /**
   * Scene background.
   *
   * Set on the existing colour rather than replaced: the scene's background is
   * a Color instance and swapping it for a string would drop whatever else
   * three.js hangs off it.
   *
   * @type {String}
   */
  set backgroundColor(value) {
    if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) return;
    Preferences.set('backgroundColor', value);
    // Through `applyBackground`, so choosing a colour with the house up stores
    // it without fighting the work-light background for the screen.
    this.applyBackground();
  }

  /**
   * Puts whichever background is in force onto the scene.
   *
   * Set on the existing colour rather than replaced: the scene's background is
   * a Color instance and swapping it for a string would drop whatever else
   * three.js hangs off it.
   *
   * @public
   */
  // eslint-disable-next-line class-methods-use-this
  applyBackground() {
    const stored = Preferences.get('backgroundColor');
    const colour = SceneEnv.houseLights ? HOUSE_LIGHTS_BACKGROUND : stored;
    if (typeof colour !== 'string') return;
    if (SceneManager.background && SceneManager.background.set) {
      SceneManager.background.set(colour);
    } else {
      SceneManager.background = new THREE.Color(colour);
    }
  }

  // eslint-disable-next-line class-methods-use-this
  get backgroundColor() {
    return Preferences.get('backgroundColor');
  }

  /**
   * Whether the frame timings and the shader tuning panel are on screen.
   *
   * Both are working surfaces rather than features, so they are off unless
   * asked for, and the answer is remembered the way the helpers are.
   *
   * @type {Boolean}
   */
  set debug(visible) {
    // Not asVisible: that treats a missing value as visible, which is right
    // for the helpers and wrong here. A show or a preferences file that says
    // nothing about debugging is not asking for it.
    this._debug = !!visible;
    Preferences.set('debug', this._debug);
    Perf.setVisible(this._debug);
    if (this.ledDebugPanel && this.ledDebugPanel.domElement) {
      this.ledDebugPanel.domElement.style.display = this._debug ? '' : 'none';
    }
  }

  get debug() {
    return !!this._debug;
  }

  /**
   * Reference grid visibility.
   *
   * The helpers are stored as a preference rather than a view toggle so that a
   * show opens looking the way it was left.
   *
   * @type {Boolean}
   */
  // eslint-disable-next-line class-methods-use-this
  set showGrid(visible) {
    helpers.gridVisible = asVisible(visible);
    Preferences.set('showGrid', helpers.gridVisible);
    applyHelperVisibility();
  }

  // eslint-disable-next-line class-methods-use-this
  get showGrid() {
    return helpers.gridVisible;
  }

  /**
   * Origin axes visibility.
   *
   * @type {Boolean}
   */
  // eslint-disable-next-line class-methods-use-this
  set showAxes(visible) {
    helpers.axesVisible = asVisible(visible);
    Preferences.set('showAxes', helpers.axesVisible);
    applyHelperVisibility();
  }

  // eslint-disable-next-line class-methods-use-this
  get showAxes() {
    return helpers.axesVisible;
  }

  /**
   * Floor visibility.
   *
   * @type {Boolean}
   */
  // eslint-disable-next-line class-methods-use-this
  set showFloor(visible) {
    helpers.floorVisible = asVisible(visible);
    Preferences.set('showFloor', helpers.floorVisible);
    applyHelperVisibility();
  }

  // eslint-disable-next-line class-methods-use-this
  get showFloor() {
    return helpers.floorVisible;
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
    Preferences.set('globalFoggingState', SceneEnv.hazeEnabled ? 1 : 0);
    this.applyFogToBloom();
    this.applyHaze();
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
    this.applyHaze();
    Preferences.set('globalFoggingDensity', SceneEnv.hazeDensity * 100);
    this.applyFogToBloom();
  }

  // eslint-disable-next-line class-methods-use-this
  get globalFoggingDensity() {
    return SceneEnv.hazeDensity * 100;
  }

  /**
   * Global scene haze feature size, in metres.
   *
   * Size, not amount -- a small value gives fine wisps and a large one slow
   * billows, while `globalFoggingDensity` decides how much of it there is.
   * The two were the same control until 2026-08-24, which is why turning the
   * haze up used to change its grain rather than its strength.
   *
   * @type {Number} metres
   */
  set globalFoggingScale(value) {
    SceneEnv.hazeScale = Number.isFinite(value) ? value : DEFAULT_PREFERENCES.FOGGING_SCALE;
    MovingHead.fogScale = SceneEnv.hazeScale;
    Preferences.set('globalFoggingScale', SceneEnv.hazeScale);
  }

  // eslint-disable-next-line class-methods-use-this
  get globalFoggingScale() {
    return SceneEnv.hazeScale;
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
    Preferences.set('globalFoggingTurbulences', normalised * 100);
  }

  // eslint-disable-next-line class-methods-use-this
  get globalFoggingTurbulences() {
    return SceneEnv.hazeTurbulence * 100;
  }

  /**
   * How much contour cycling is mixed into the scene haze, 0..100.
   *
   * Reaches every fixture type at once -- the cycling uniform is shared by
   * reference, the way the haze volume is. Only the baked-volume path reads it,
   * and only in its cycling mode (`HAZE_MODE` 2 in `haze_noise.js`); the setter
   * is harmless otherwise. Deliberately not persisted yet: it is a tuning knob
   * for judging the field, not a settled control.
   *
   * @type {Number} 0..100
   */
  // eslint-disable-next-line class-methods-use-this
  set globalHazeCycle(value) {
    setHazeCycle(Number.isFinite(value) ? Math.min(Math.max(value, 0), 100) / 100 : 0);
  }

  // eslint-disable-next-line class-methods-use-this
  get globalHazeCycle() {
    return hazeCycle() * 100;
  }

  /**
   * Global scene brightness
   *
   * @type {Number}
   */
  /**
   * The brightness in force, as a percentage.
   *
   * Kept as the one name the rest of the app already used; it writes whichever
   * of the two rooms is showing.
   *
   * @type {Number}
   */
  set globalBrightness(value) {
    if (this._houseLights) {
      this.houseLightsUp = value;
      return;
    }
    this.houseLightsDown = value;
  }

  /**
   * Which stored brightness the scene is currently showing.
   *
   * @readonly
   * @type {String}
   */
  get brightnessKey() {
    return this._houseLights ? 'globalBrightness' : 'brightnessHouseOff';
  }

  /**
   * Brightness with the house lights up, as a percentage.
   *
   * Held on the instance rather than read from Preferences on every access.
   * Preferences is a plain module, so nothing watching it can be told when it
   * changes -- a settings panel bound to it read once and then showed that
   * first answer for ever. The instance is reached through the reactive show,
   * so a change here is seen.
   *
   * @type {Number}
   */
  set houseLightsUp(value) {
    this._brightnessUp = Visualizer.asBrightness(value, DEFAULT_PREFERENCES.GLOBAL_BRIGHTNESS);
    Preferences.set('globalBrightness', this._brightnessUp);
    if (this._houseLights) this.applyBrightness();
  }

  get houseLightsUp() {
    return this._brightnessUp;
  }

  /**
   * Brightness with the house lights down, as a percentage.
   *
   * @type {Number}
   */
  set houseLightsDown(value) {
    this._brightnessDown = Visualizer.asBrightness(value, DEFAULT_PREFERENCES.BRIGHTNESS_HOUSE_OFF);
    Preferences.set('brightnessHouseOff', this._brightnessDown);
    if (!this._houseLights) this.applyBrightness();
  }

  get houseLightsDown() {
    return this._brightnessDown;
  }

  /**
   * Whether the house lights are up.
   *
   * Two settings rather than one dimmer: a rig is inspected with the room lit
   * and watched with it dark, and each wants its own brightness kept.
   *
   * @type {Boolean}
   */
  set houseLights(on) {
    this._houseLights = !!on;
    // House up means work light, and work light means a clear view -- so the
    // haze goes with it. SceneEnv folds this into `hazeAmount`, which every
    // renderer that scatters light already reads.
    SceneEnv.houseLights = this._houseLights;
    this.applyHaze();
    this.applyBackground();
    Preferences.set('houseLights', this._houseLights);
    this.applyBrightness();
  }

  get houseLights() {
    return !!this._houseLights;
  }

  /**
   * Puts the effective haze onto the beams.
   *
   * Every other renderer reads `SceneEnv.hazeAmount` itself and follows the
   * `changed` event, but the beam shader carries its own `fogFactor` uniform,
   * so the one number has to be pushed to it. Guarded because the beam mesh
   * does not exist until `prepareInstanciation` has run, and preferences are
   * applied before that.
   *
   * @public
   */
  // eslint-disable-next-line class-methods-use-this
  applyHaze() {
    try {
      MovingHead.fogDensity = SceneEnv.hazeAmount;
    } catch (err) {
      // No beams yet; `main()` pushes the value once instancing is prepared.
    }
  }

  /**
   * Puts whichever brightness is in force onto the light.
   *
   * @public
   */
  applyBrightness() {
    this._globalBrightness = (this._houseLights ? this._brightnessUp : this._brightnessDown) / 100;
    if (this.globalLightHandle) {
      this.globalLightHandle.intensity = this._globalBrightness * 0.25;
    }
    // The environment is fill for the same room, so it follows the same
    // control rather than being a second thing to remember to turn down.
    setHouseBrightness(this._globalBrightness);
    if (ambientHazeEffect) ambientHazeEffect.setHouseBrightness(this._globalBrightness);
  }

  /**
   * Reads a brightness percentage, falling back when there is not one.
   *
   * Tested for a number rather than for truthiness: zero is a brightness a
   * user can legitimately ask for -- house lights fully down -- and a falsy
   * test turned it into the default, which is very nearly full.
   *
   * @static
   * @param {*} value candidate percentage
   * @param {Number} fallback used when the candidate is not a number
   * @returns {Number} a percentage
   */
  static asBrightness(value, fallback) {
    const asked = Number(value);
    return Number.isFinite(asked) ? asked : fallback;
  }

  get globalBrightness() {
    return this._globalBrightness * 100;
  }

  /**
   * Global scene brightness
   *
   * @type {Number}
   */
  /**
   * Whether gizmo drags snap to a spacing. The toggle is a toolbar button; the
   * spacing itself is a preference, since it is set once and then left.
   *
   * @type {Boolean}
   */
  // eslint-disable-next-line class-methods-use-this
  set snapEnabled(value) {
    Controls.snapEnabled = value;
    Preferences.set('snapEnabled', Controls.snapEnabled);
  }

  // eslint-disable-next-line class-methods-use-this
  get snapEnabled() {
    return Controls.snapEnabled;
  }

  /**
   * Which transform tool the gizmo shows: 'translate' or 'rotate'.
   *
   * A workspace state rather than a preference: it is switched constantly
   * while laying a rig out, and starting every session on the arrows is what
   * the keys already did.
   *
   * @type {String}
   */
  // eslint-disable-next-line class-methods-use-this
  set gizmoMode(value) {
    Controls.gizmoMode = value;
  }

  // eslint-disable-next-line class-methods-use-this
  get gizmoMode() {
    return Controls.gizmoMode;
  }

  /**
   * Snap spacing, in metres. One number for all three axes.
   *
   * The drawn grid follows it, so the lines you see are the positions the
   * gizmo will land on -- a grid at one spacing and a snap at another is worse
   * than no grid at all.
   *
   * @type {Number}
   */
  // eslint-disable-next-line class-methods-use-this
  set snapSpacing(value) {
    Controls.snapSpacing = value;
    Preferences.set('snapSpacing', Controls.snapSpacing);
    if (helpers.grid && helpers.grid.setSpacing) helpers.grid.setSpacing(Controls.snapSpacing);
  }

  // eslint-disable-next-line class-methods-use-this
  get snapSpacing() {
    return Controls.snapSpacing;
  }

  /**
   * Rotation snap, in degrees.
   *
   * @type {Number}
   */
  // eslint-disable-next-line class-methods-use-this
  set snapDegrees(value) {
    Controls.snapDegrees = value;
    Preferences.set('snapDegrees', Controls.snapDegrees);
  }

  // eslint-disable-next-line class-methods-use-this
  get snapDegrees() {
    return Controls.snapDegrees;
  }

  /**
   * Looks down one of the six axes, framed to fit.
   *
   * @public
   * @param {String} name top, bottom, front, back, left or right
   */
  // eslint-disable-next-line class-methods-use-this
  setView(name) {
    Controls.setView(name);
  }

  /**
   * Chooses the opening view for a show that has just loaded.
   *
   * @public
   */
  // eslint-disable-next-line class-methods-use-this
  frameDefault() {
    // Three-quarters from the front, a little above: enough of an angle to
    // read depth, not so much that it becomes a plan. The distance is not ours
    // to choose -- setViewDirection fits whatever is there, and copes with an
    // empty show by framing a unit box at the origin.
    Controls.setViewDirection(new THREE.Vector3(1, -1, 0.6));
  }

  /**
   * Frames everything in the scene from where the camera already is.
   *
   * @public
   */
  // eslint-disable-next-line class-methods-use-this
  frameAll() {
    Controls.frameAll();
  }

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

  /**
   * Current settings, for the preferences popup to restore on cancel.
   *
   * Deliberately not part of a show: these describe the workspace, not the
   * rig, and persist to their own file.
   *
   * @readonly
   * @type {Object}
   */
  // eslint-disable-next-line class-methods-use-this
  get showData() {
    return Preferences.all();
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
    this.applyHaze();

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

    // Read from Preferences rather than from Controls: this runs unawaited
    // from init(), so it may get here before the stored settings have been
    // pushed onto the visualizer -- but Preferences.load() is the first thing
    // init() waits for, so the number is already in hand.
    const spacing = Preferences.get('snapSpacing') || 1;
    const gridHelper = new InfiniteGridHelper(
      spacing,
      spacing * 10,
      new THREE.Color('white'),
      100,
    );
    gridHelper.rotateX(Math.PI / 2.0);
    gridHelper.position.setZ(-0.3);
    helpers.grid = gridHelper;
    SceneManager.add(gridHelper);

    const axesHelper = new THREE.AxesHelper(2);
    helpers.axes = axesHelper;

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
    floor.receiveShadow = true;
    floor.position.setZ(-0.25);
    helpers.floor = floor;

    this.globalLightHandle.target = floor;

    SceneManager.add(this.globalLightHandle, floor, axesHelper);

    // Preferences are applied when the show loads, which is before any of this
    // exists; push them onto the objects now that it does.
    applyHelperVisibility();

    // Proof-of-concept LED bar matrix, driven straight from Art-Net.
    //
    // Addressing is one continuous pixel stream across universes at 170 pixels
    // (510 channels) each, so channels 511 and 512 are never used and no pixel
    // is split across a universe boundary. 100 bars of 60 LEDs is 6,000 pixels,
    // spanning 36 universes.
    DMXStore.attachArtNet();

    // Library models, reachable from the console while there is no UI for
    // them. Development only: this is scaffolding for judging a model's scale
    // and orientation by eye, and comes out when placing one is a real action.
    //
    //   await beamObjects.list()            what is in Library/Objects
    //   await beamObjects.place('name')     put one at the origin
    //   beamObjects.stats()                 draw calls against placements
    if (import.meta.env.DEV) {
      window.beamObjects = {
        list: () => (window.library ? window.library.objects() : []),
        place: async (name, transform) => {
          const found = (await window.library.objects())
            .find((item) => item.name === name);
          if (!found) throw new Error(`no model named ${name} in Library/Objects`);
          return SceneObjects.place(found, transform);
        },
        move: SceneObjects.move,
        clear: SceneObjects.clear,
        stats: SceneObjects.stats,
      };
    }

    // Capacity for patched LED fixtures. The instanced meshes are sized once,
    // so this is a hard ceiling rather than a hint: past it, a bar patches and
    // addresses correctly but does not draw.
    LEDField.init({
      scene: SceneManager,
      maxBars: LED_FIXTURE_BAR_CAPACITY,
      maxLeds: LED_FIXTURE_LED_CAPACITY,
    });

    // Nothing is built into the field up front any more, so the watermark that
    // protects scene furniture from a fixture rebuild sits at zero.
    LEDField.mark();

    // Emitter and glow tuning. Writes straight into shader uniforms so values
    // can be found by eye rather than by rebuild.
    this.ledDebugPanel = createLEDDebugPanel(this, this.domElement.parentElement);
    // Built either way, so switching the preference is instant rather than
    // needing the scene rebuilt; only its visibility follows the flag.
    this.debug = Preferences.get('debug');
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
    // Shadow casting is driven by the fixtures' spot lights; without `enabled`
    // the map is never rendered and `autoUpdate` alone does nothing.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.physicallyCorrectLights = true;
    this.renderer.setPixelRatio(0.8); // Forcing pixel ratio to 1 to avoid unnecessary computations
    // Tone mapping moves into the composer. Left on the renderer it is applied
    // per material, clamping emitters to white before bloom can tell that they
    // are brighter than white.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.prepareComposer();
    // Needs the renderer, so it cannot run any earlier than this.
    installAmbient(this.renderer, SceneManager);
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

    // Before bloom and tone mapping: the air is part of the image, so it has
    // to be there when glare and the tone curve are worked out. It reads the
    // depth buffer, which is why it cannot be a plain material on geometry.
    ambientHazeEffect = new AmbientHazeEffect(this.camera);

    const effects = bloomEffect
      ? [ambientHazeEffect, bloomEffect, toneMapping]
      : [ambientHazeEffect, toneMapping];
    finalComposer.addPass(new EffectPass(this.camera, ...effects));
  }

  /**
   * The ambient haze pass, once the composer has been built.
   *
   * @returns {AmbientHazeEffect|null}
   */
  // eslint-disable-next-line class-methods-use-this
  get ambientHaze() {
    return ambientHazeEffect;
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
    // Only where the camera sits for the instant before a show is framed:
    // `frameDefault` decides the real opening view from what the show actually
    // contains, rather than from a rig that happened to be here once.
    this.camera.position.set(4.6, -4.6, 3);
    this.camera.lookAt(0, 0, 1);
  }

  /**
   * Builds the corner navigation cube and wires it to the canvas.
   *
   * Its listeners run before the scene's own picking and stop the event when
   * the pointer is over the gizmo, so clicking a face never also selects
   * whatever fixture happens to be behind it.
   *
   * @public
   */
  prepareViewCube() {
    // Never proxied: the visualizer handle hangs off the reactive show, so
    // anything assigned to it is wrapped, and three reads Object3D internals
    // that a proxy cannot hand back unchanged.
    this.viewCube = markRaw(new ViewCube(this.camera, this.domElement));
    this.domElement.addEventListener('pointermove', (event) => {
      const over = this.viewCube.handlePointerMove(event);
      this.domElement.style.cursor = over ? 'pointer' : '';
    });
    this.domElement.addEventListener('pointerleave', () => this.viewCube.clearHover());
    // A press on the gizmo is left to travel: OrbitControls orbits on any drag
    // over the canvas, and the cube mirrors the camera, so dragging it round
    // needs no code of its own. Only a press that goes nowhere is a face
    // click, which is decided on release.
    this.domElement.addEventListener('pointerdown', (event) => {
      this.viewCubeDownAt = this.viewCube.handleClick(event)
        ? { x: event.clientX, y: event.clientY }
        : null;
    }, true);

    this.domElement.addEventListener('pointerup', (event) => {
      const down = this.viewCubeDownAt;
      this.viewCubeDownAt = null;
      if (!down) return;
      const travelled = Math.hypot(event.clientX - down.x, event.clientY - down.y);
      if (travelled > VIEW_CUBE_CLICK_SLOP_PX) return;
      const hit = this.viewCube.handleClick(event);
      if (!hit) return;
      // The event still has to reach OrbitControls so it can end its drag
      // cleanly; the scene's own picking is told to sit this one out instead,
      // otherwise clicking the gizmo would also clear the selection behind it.
      Controls.ignoreNextPointerUp = true;
      if (hit.view) Controls.setView(hit.view);
      else Controls.setViewDirection(hit.direction);
    }, true);
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
    this.controls.target.set(0, 0, 4.1);
    // Was PI / 2.1, which pinned the orbit just above horizontal. Fixtures
    // aimed downward can only be seen from underneath, so the camera has to be
    // able to get below them; stopping just short of the pole avoids the
    // gimbal flip at straight-up.
    this.controls.maxPolarAngle = Math.PI * 0.98;
    // Left is reserved for picking and rubber-band selection, so the camera
    // moves on the other two: middle pans, right orbits.
    this.controls.mouseButtons = {
      LEFT: null,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.ROTATE,
    };
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
      // Buffer only, never the canvas's own style. setSize writes inline
      // width and height by default, and a ResizeObserver is watching this
      // very element -- so each resize restyled what it was measuring, while
      // the stylesheet's `!important` sizing overrode it again. The buffer and
      // the displayed size disagreed for a frame every frame of a drag, which
      // is the flicker. CSS sizes the canvas; this only sizes what is drawn.
      this.renderer.setSize(width, height, false);
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
      // Inside the loop, and inside Perf, because it is part of the frame:
      // measuring the scene without it would report a cost nobody pays.
      // Skips itself when no Art-Net has arrived and nothing has moved.
      // Before the panels, which read the texture this uploads into. Inside
      // Perf for the same reason they are: it is part of the frame.
      //
      // Skipped entirely when nothing reads it. Art-Net arrives whether or not
      // the show has anything patched -- an empty scene with a 256 x 256 tile
      // on the wire was uploading 7.5 MB/s into a texture with no readers,
      // because the store accepts every universe on the wire and has no notion
      // of a show. `refresh` already returns early on the same condition; this
      // is the upload that fed it.
      DMXStore.flush(this.renderer, LEDPanel.hasReaders());
      LEDPanel.refresh(this.renderer);
      // Objects are instanced, so the gizmo cannot drag one directly -- it
      // drags a plain node and this copies it into the buffer. Only while
      // something is selected: with nothing picked, no instance can be moving.
      if (Controls.pooledInstances && Controls.pooledInstances.length) {
        SceneObjects.syncFromOwners();
      }
      if (finalComposer) {
        finalComposer.render();
      } else {
        this.renderer.render(SceneManager, this.camera);
      }
    }
    Perf.end();

    // Over the finished image, and after Perf.end() so the gizmo's own cost is
    // not counted against the scene it is reporting on.
    if (this.viewCube) this.viewCube.render(this.renderer);
  }
}

export default Visualizer;
