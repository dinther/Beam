/* eslint-disable */
// TODO: find a way for the linter to accept node_module nested libs
import * as THREE from 'three';
import { markRaw } from 'vue';

import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import Stats from 'stats.js';
import ModelInstancer from './model_instancer';
import SceneManager from './scene_manager';
import AnimationManager from './animation_manager';
import Controls, { ORTHO_STANDOFF, ORTHO_REFERENCE_FOV, setOrthoHalfHeight } from './controls';
import NavGizmo from './nav_gizmo';
import Light from './light';
import { flushGoboCells } from './gobo_library';
import Animation from './animation_wheel';
import InfiniteGridHelper from './grid';
import LEDField from './led_field';
import LightField, { SCENE_PER_NIT } from './light_field';
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
 * that this number sizes has no callers, and any capacity here is megabytes of
 * instance matrices and attributes allocated at startup that nothing writes to.
 *
 * Zero builds none of it. Raise it to bring the path back for anything that
 * cannot be a surface -- a strip bent along a polyline is the case it serves.
 */
const LED_FIXTURE_LED_CAPACITY = 0;


/**
 * How far a look-around drag turns the view: a screen height is a full turn.
 *
 * The same rate `OrbitControls` rotates at, so the two drags feel like one
 * hand rather than two devices.
 */
const LOOK_TURN_PER_HEIGHT = Math.PI * 2;

/** Stops just short of the poles, where the view would flip over on itself. */
const LOOK_MIN_POLAR = Math.PI * 0.02;
const LOOK_MAX_POLAR = Math.PI * 0.98;

/** `PointerEvent.button` values the hand-held drags are hung off. */
const MIDDLE_BUTTON = 1;
const RIGHT_BUTTON = 2;

/**
 * What a hand-held drag is doing: turning the view, lifting the whole rig, or
 * panning it under the pointer.
 */
const DRAG_LOOK = 'look';
const DRAG_LIFT = 'lift';
const DRAG_PAN = 'pan';
const DRAG_ORBIT = 'orbit';
const DRAG_WALK = 'walk';

/** Scratch for the walk: the grabbed point, its level, and where the ray meets it. */
const walkGrab = new THREE.Vector3();
const walkPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const walkMeet = new THREE.Vector3();
const walkStep = new THREE.Vector3();

/** Scratch for the orbit's pivot and turns. */
const orbitPivot = new THREE.Vector3();
const orbitTurn = new THREE.Quaternion();
const orbitAxis = new THREE.Vector3();
const orbitForward = new THREE.Vector3();
const orbitNdc = new THREE.Vector2();
const orbitRay = new THREE.Raycaster();
const WORLD_UP = new THREE.Vector3(0, 0, 1);

/**
 * How much nearer the wheel brings the camera to what is under the cursor,
 * per pixel of wheel travel: a notch, about 100 pixels, closes 15% of the
 * distance.
 */
const WHEEL_RATE = 0.0016;
/** A wheel line, for a mouse that reports in lines, in pixels. */
const WHEEL_LINE_PX = 33;
/** The smallest and largest an orthographic view may be, half its height in metres. */
const ORTHO_MIN_HALF = 0.02;
const ORTHO_MAX_HALF = 1000;
/** Scratch for the wheel's aim point, its step, and the view's forward. */
const wheelPoint = new THREE.Vector3();
const wheelStep = new THREE.Vector3();
const wheelForward = new THREE.Vector3();

/** Scratch for the look vector, so a drag allocates nothing per move. */
const lookVector = new THREE.Vector3();
/** Scratch for the pan's screen axes and step. */
const panRight = new THREE.Vector3();
const panUp = new THREE.Vector3();
const panStep = new THREE.Vector3();
import SceneEnv from './scene_env';
import {
  installAmbient, setHouseBrightness, setHouseState, setEnvironments,
  houseLevelFor, onRoomChange, KEY_LIGHT_INTENSITY, KEY_LIGHT_POSITION,
} from './ambient';
import AmbientHazeEffect from './ambient_haze';
import ReflectionsEffect from './reflections';
import BeamHaloEffect from './beam_halo';
import Perf from './perf_overlay';
import Preferences from './preferences';
import { refreshAddressFormat } from '../../models/DMX/address_format';
import Tuning from './tuning';
import createLEDDebugPanel from './led_debug_panel';
import VideoFeed from './video_feed';
import Display from './display';
import Projector from './projector';
import Laser from './laser';
import VideoRouter from './video_router';
import VideoDecode from './video_decode';
import ProjectorDepth from './projector_depth';
import ProjectorEffect from './projector_pass';
import SurfaceAlbedo from './surface_albedo';
import ContactShadows from './contact_shadows';
import LaserEffect from './laser_pass';
import Strobe from './strobe';
import StrobeWashEffect from './strobe_wash';
import { SelectionOutlineEffect } from './selection_outline';
import Recorder from './recorder';
import Screenshot from './screenshot';
import {
  EffectComposer,
  RenderPass,
  EffectPass,
  BloomEffect,
  ToneMappingEffect,
  ToneMappingMode,
  KernelSize,
  BlendFunction,
} from 'postprocessing';

/**
 * Post-processing composer.
 *
 * Module-scoped rather than stored on the Visualizer instance: the instance is
 * reached through a Vue-reactive handle, and three.js objects that come back
 * wrapped in a reactive Proxy break rendering.
 */
let finalComposer = null;
/** The passes that are given the camera, kept so a camera swap reaches them. */
let renderPass = null;
let laserPass = null;
let reflectionsPass = null;
let reflectionsEffect = null;
let mainPass = null;

/** The projection pass, module-scoped for the same reason the composer is. */
let projectorEffect = null;
let laserEffect = null;
/** Whites the frame when a strobe fires at the camera. */
let strobeWashEffect = null;
let selectionOutlineEffect = null;
/** Scratch for the wash summed over every strobe each frame. */
const strobeWash = new THREE.Color();

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
 * Whether the debug panel has taken the bloom over.
 *
 * Bloom normally follows haze density. Once a value is set by hand that has to
 * stop, or the next change of haze would undo it.
 */
let bloomManual = false;
let toneMappingEffect = null;

/**
 * Ambient haze pass, kept accessible so the debug panel and the house lights
 * can reach it. Module-scoped for the same reason the composer is.
 */
let ambientHazeEffect = null;
let beamHaloEffect = null;

/**
 * Multisample count for the composer's render target.
 *
 * Four rather than two, measured: both cost the same here -- 14.2 ms against
 * 14.7 ms on two beams filling the screen -- because the price is blend
 * bandwidth on a half-float target rather than sample count, and additive
 * geometry with heavy overdraw pays it either way. Two still left 6-9 level
 * steps in a single pixel on a beam's edge; four leaves none.
 *
 * The cost is real where beams fill the frame: 7.7 ms without, 14.2 ms with.
 * It is nothing where they do not (2.2 vs 2.3 ms). On the 500-mover show it is
 * 3.27 ms against 4.72 ms, together with the pixel ratio below.
 *
 * This sat at zero for a while, which is what made every edge in the scene
 * step: with nothing multisampling the composer's target and no AA pass in the
 * chain, a silhouette is a hard staircase. Measured on the floor's diagonal,
 * the edge's sub-pixel position wandered 0.332 px RMS off a straight line at
 * zero and 0.178 px at four.
 *
 * @constant {Number}
 */
const MSAA_SAMPLES = 4;

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
  /**
   * Suppresses reference furniture for the duration of a take.
   *
   * Separate from `gridVisible`/`axesVisible` on purpose. Those are settings:
   * their setters write to `Preferences`, so hiding the grid for a recording
   * through them would turn the user's grid off permanently -- and leave it off
   * if the app died mid-take. This is a mode, and it stores nothing.
   */
  recording: false,
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
/**
 * Pushes the stored grid style onto the grid, if there is one yet.
 *
 * @private
 */
function applyGridStyle() {
  if (!helpers.grid) return;
  helpers.grid.opacity = Preferences.get('gridOpacity');
  helpers.grid.lineWidth = Preferences.get('gridLineWidth');
}

function applyHelperVisibility() {
  if (helpers.grid) helpers.grid.visible = helpers.gridVisible && !helpers.recording;
  if (helpers.axes) helpers.axes.visible = helpers.axesVisible && !helpers.recording;
}

/**
 * Whether screen-space bloom is part of the chain.
 *
 * Off: the world-space glow billboards on the emitters carry the halo instead,
 * which unlike bloom shrinks correctly with distance. Left as a switch rather
 * than deleted, since the two are complementary and bloom may earn its place
 * back for the lens-glare part.
 */
const USE_BLOOM = true;

/**
 * The camera. Fixed, never adaptive: what is set looks the same every time
 * it is looked at.
 *
 * Exposure is an EV at ISO 100, as a photographer sets it, and maps luminance
 * to the tone curve: see `exposureForEV`. Higher EV is darker; one EV halves
 * the picture. 5.25 is the calibration every fixture's look was tuned at;
 * the regression set uses it. Each house state keeps its own EV: a lit room and a
 * dark show want different exposures, as they do on a real camera.
 *
 * Glare is the lens's own spread of light: a few percent of everything
 * bright, thrown wide, with no threshold -- a camera does not choose what
 * to glare on. It replaced a bloom that followed the haze; the haze's
 * spread of light is now the beams' halo, which is light in the air, not
 * in the lens.
 */
const CAMERA_EV = 5.25;

/**
 * The tone curve's input scale for an EV at ISO 100.
 *
 * Saturation-based exposure: a luminance of 1.2 x 2^EV cd/m2 reaches 1.0, as
 * photometric renderers (Frostbite, Filament) define it. The render buffer
 * holds cd/m2 times `SCENE_PER_NIT`, which this undoes.
 *
 * @param {Number} ev
 * @returns {Number}
 */
export function exposureForEV(ev) {
  return 1 / (1.2 * (2 ** ev) * SCENE_PER_NIT);
}
const CAMERA_TONE_CURVE = 'ACES_FILMIC';
const GLARE_STRENGTH = 0.04;
const GLARE_RADIUS = 0.85;

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
/**
 * The opening view: where the camera sits and what it looks at.
 *
 * A viewpoint set by hand: 16 degrees off the front axis and 24 above the
 * horizon.
 *
 * Fixed rather than computed. Framing the scene sounds better and is not: an
 * axis-aligned box fits the extremes, so a single outlier moves the centre and
 * inflates the radius. One ceiling object at x = 17.2 in a rig that otherwise
 * ends at x = 4 pulls the centre to x = 6.4 and the camera to 31 m out, and the
 * show opens looking at the gap beside it. A view that is always the same is
 * worth more than one that is occasionally better framed and often wrong.
 *
 * @constant {Object}
 */
const DEFAULT_VIEW = {
  position: { x: 10.27, y: -36.17, z: 18.93 },
  target: { x: 0.15, y: -1.2, z: 2.79 },
};

const HOUSE_LIGHTS_BACKGROUND = '#3c3c3c';


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
  HOUSE_LUX_UP: 300,
  HOUSE_LUX_DOWN: 6,
  // Incident-meter exposure for 300 lux at ISO 100: log2(300 x 100 / 250).
  HOUSE_EV_UP: 7,
  // Set for a bright projection in a dark room; the room stays near black.
  HOUSE_EV_DOWN: 6.5,
};

// The haze defaults live in `preferences.js` only, and `SceneEnv` reads them.
// One set, so the order the scene is built in cannot decide which applies.

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
    // Off by default: selecting something flies the camera to it, which is
    // help when you are looking for a fixture and an interruption when you
    // have already framed the shot you want to judge.
    this.autoFocus = false;
    this.stats = new Stats();
    this.stats.showPanel(0);
    this.stats.dom.style.position = 'absolute';
    /**
     * The frame a recording is composed for, or null when there is none.
     *
     * While this is set the drawing buffer is pinned to it and `resize` stands
     * down, so the canvas keeps the size the recording asked for however the
     * panel around it is dragged.
     *
     * @type {{width: Number, height: Number, fov: Number}|null}
     */
    this.recordFrame = null;
    /** Camera FOV and renderer pixel ratio to put back afterwards. */
    this.beforeRecord = null;
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
    // Addresses on screen were drawn in the fallback spelling until now.
    refreshAddressFormat();
    // Straight onto the room, before a renderer or a debug panel can read it.
    // A panel that reads `SceneEnv` before this shows zeros for the rest of
    // the session while the scene runs on the stored values.
    SceneEnv.adopt(Preferences.all());
    await ModelInstancer.init(`${import.meta.env.VITE_STATIC_URL}/visualizer/models/model_list.json`);
    this.prepareCamera();
    this.prepareRenderer();
    this.prepareControls();
    this.resize();
    Controls.init(this.camera, this.domElement, this.controls);
    this.prepareNavGizmo();
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
    // Which image lights each state, then which state is showing. Named before
    // the switch is set so the first environment built is the right one rather
    // than the default being built and immediately replaced.
    this._environmentHouseOn = source.environmentHouseOn || 'room';
    this._environmentHouseOff = source.environmentHouseOff || 'room';
    setEnvironments({ on: this._environmentHouseOn, off: this._environmentHouseOff });
    setHouseState(this._houseLights);
    this._brightnessUp = Visualizer.asBrightness(
      source.houseLuxUp,
      DEFAULT_PREFERENCES.HOUSE_LUX_UP,
    );
    this._brightnessDown = Visualizer.asBrightness(
      source.houseLuxDown,
      DEFAULT_PREFERENCES.HOUSE_LUX_DOWN,
    );
    this._evUp = Visualizer.asBrightness(source.houseEVUp, DEFAULT_PREFERENCES.HOUSE_EV_UP);
    this._evDown = Visualizer.asBrightness(source.houseEVDown, DEFAULT_PREFERENCES.HOUSE_EV_DOWN);
    // The lux-to-level conversion depends on the environment, which loads
    // asynchronously and can be changed; the level follows it.
    if (!this._followsRoom) {
      this._followsRoom = true;
      onRoomChange(() => this.applyBrightness());
    }
    this.applyBrightness();
    // One call, and the conversion from stored percentages lives in the room
    // rather than being repeated in four setters here.
    SceneEnv.adopt(source);
    this.snapEnabled = source.snapEnabled !== false;
    this.snapSpacing = source.snapSpacing;
    this.showGrid = source.showGrid;
    this.reflections = source.reflections;
    this.gridOpacity = source.gridOpacity;
    this.gridLineWidth = source.gridLineWidth;
    this.showAxes = source.showAxes;
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
   * Whether glossy surfaces reflect what is on screen. Off, they reflect only
   * the environment image, and the displays their rectangle.
   *
   * @type {Boolean}
   */
  set reflections(on) {
    this._reflections = on !== false;
    Preferences.set('reflections', this._reflections);
    if (reflectionsEffect) reflectionsEffect.setOn(this._reflections);
  }

  get reflections() {
    return this._reflections !== false;
  }

  /**
   * How strongly the reference grid draws.
   *
   * On the visualizer rather than in `grid.js` for the same reason the other
   * helper settings are: it has to survive a reload and it has to be reachable
   * from the settings panel. The grid may not exist yet when a stored value is
   * pushed, so the preference is the truth and the helper is caught up in
   * `applyGridStyle` once it does.
   *
   * @type {Number}
   */
  // eslint-disable-next-line class-methods-use-this
  set gridOpacity(value) {
    const wanted = Number(value);
    if (!Number.isFinite(wanted)) return;
    Preferences.set('gridOpacity', Math.min(Math.max(wanted, 0), 1));
    applyGridStyle();
  }

  // eslint-disable-next-line class-methods-use-this
  get gridOpacity() {
    return Preferences.get('gridOpacity');
  }

  /**
   * Grid line width, in pixels.
   *
   * @type {Number}
   */
  // eslint-disable-next-line class-methods-use-this
  set gridLineWidth(value) {
    const wanted = Number(value);
    if (!Number.isFinite(wanted)) return;
    Preferences.set('gridLineWidth', Math.min(Math.max(wanted, 0.1), 4));
    applyGridStyle();
  }

  // eslint-disable-next-line class-methods-use-this
  get gridLineWidth() {
    return Preferences.get('gridLineWidth');
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
   * Global scene fogging state
   * @type {Boolean}
   * @param {boolean} value
   */
  // eslint-disable-next-line class-methods-use-this
  set globalFoggingState(value) {
    SceneEnv.hazeEnabled = value === undefined || value === null
      ? Preferences.DEFAULTS.globalFoggingState : !!value;
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
  // eslint-disable-next-line class-methods-use-this
  set globalFoggingDensity(value) {
    SceneEnv.hazeDensity = (Number.isFinite(value)
      ? Math.min(Math.max(value, 0), 100)
      : Preferences.DEFAULTS.globalFoggingDensity) / 100;
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
   *
   * @type {Number} metres
   */
  // eslint-disable-next-line class-methods-use-this
  set globalFoggingScale(value) {
    SceneEnv.hazeScale = Number.isFinite(value)
      ? value : Preferences.DEFAULTS.globalFoggingScale;
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
    SceneEnv.hazeTurbulence = (Number.isFinite(value)
      ? Math.min(Math.max(value, 0), 100)
      : Preferences.DEFAULTS.globalFoggingTurbulences) / 100;
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
  /**
   * The house light in force, in lux on the floor.
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
    return this._houseLights ? 'houseLuxUp' : 'houseLuxDown';
  }

  /**
   * House light with the house lights up, in lux on the floor.
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
    this._brightnessUp = Visualizer.asBrightness(value, DEFAULT_PREFERENCES.HOUSE_LUX_UP);
    Preferences.set('houseLuxUp', this._brightnessUp);
    if (this._houseLights) this.applyBrightness();
  }

  get houseLightsUp() {
    return this._brightnessUp;
  }

  /**
   * House light with the house lights down, in lux on the floor.
   *
   * @type {Number}
   */
  set houseLightsDown(value) {
    this._brightnessDown = Visualizer.asBrightness(value, DEFAULT_PREFERENCES.HOUSE_LUX_DOWN);
    Preferences.set('houseLuxDown', this._brightnessDown);
    if (!this._houseLights) this.applyBrightness();
  }

  /**
   * Camera exposure with the house lights up, as EV at ISO 100.
   *
   * @type {Number}
   */
  set houseExposureUp(value) {
    this._evUp = Visualizer.asBrightness(value, DEFAULT_PREFERENCES.HOUSE_EV_UP);
    Preferences.set('houseEVUp', this._evUp);
    if (this._houseLights) this.applyBrightness();
  }

  get houseExposureUp() {
    return this._evUp;
  }

  /**
   * Camera exposure with the house lights down, as EV at ISO 100.
   *
   * @type {Number}
   */
  set houseExposureDown(value) {
    this._evDown = Visualizer.asBrightness(value, DEFAULT_PREFERENCES.HOUSE_EV_DOWN);
    Preferences.set('houseEVDown', this._evDown);
    if (!this._houseLights) this.applyBrightness();
  }

  get houseExposureDown() {
    return this._evDown;
  }

  get houseLightsDown() {
    return this._brightnessDown;
  }

  /**
   * Environment image with the house lights up.
   *
   * Held on the instance for the same reason the brightnesses are: Preferences
   * is a plain module, so a settings panel bound to it reads once and shows
   * that first answer for ever.
   *
   * @type {String}
   */
  set environmentHouseOn(value) {
    this._environmentHouseOn = value || 'room';
    Preferences.set('environmentHouseOn', this._environmentHouseOn);
    setEnvironments({ on: this._environmentHouseOn, off: this._environmentHouseOff });
  }

  get environmentHouseOn() {
    return this._environmentHouseOn || 'room';
  }

  /**
   * Environment image with the house lights down.
   *
   * @type {String}
   */
  set environmentHouseOff(value) {
    this._environmentHouseOff = value || 'room';
    Preferences.set('environmentHouseOff', this._environmentHouseOff);
    setEnvironments({ on: this._environmentHouseOn, off: this._environmentHouseOff });
  }

  get environmentHouseOff() {
    return this._environmentHouseOff || 'room';
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
    // The room changes, not just its brightness: each state names its own
    // environment image and they are swapped rather than faded.
    setHouseState(this._houseLights);
    // House up means work light, and work light means a clear view -- so the
    // haze goes with it. SceneEnv folds this into `hazeAmount`, which every
    // renderer that scatters light already reads.
    SceneEnv.houseLights = this._houseLights;
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

  /**
   * Puts whichever brightness is in force onto the light.
   *
   * @public
   */
  applyBrightness() {
    const lux = this._houseLights ? this._brightnessUp : this._brightnessDown;
    this._globalBrightness = houseLevelFor(lux);
    if (this.globalLightHandle) {
      this.globalLightHandle.intensity = this._globalBrightness * KEY_LIGHT_INTENSITY;
    }
    // The environment is fill for the same room, so it follows the same
    // control rather than being a second thing to remember to turn down.
    setHouseBrightness(this._globalBrightness);
    if (ambientHazeEffect) ambientHazeEffect.setHouseBrightness(this._globalBrightness);
    this.applyExposure();
  }

  /**
   * Puts the house state's EV onto the camera.
   *
   * @public
   */
  applyExposure() {
    if (!this.renderer) return;
    const ev = this._houseLights ? this._evUp : this._evDown;
    this.renderer.toneMappingExposure = exposureForEV(Number.isFinite(ev) ? ev : CAMERA_EV);
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
    Controls.flyTo(
      new THREE.Vector3(DEFAULT_VIEW.position.x, DEFAULT_VIEW.position.y, DEFAULT_VIEW.position.z),
      new THREE.Vector3(DEFAULT_VIEW.target.x, DEFAULT_VIEW.target.y, DEFAULT_VIEW.target.z),
    );
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
    this.globalLightHandle = new THREE.DirectionalLight('white', this._globalBrightness * KEY_LIGHT_INTENSITY);
    this.globalLightHandle.castShadow = false;
    this.globalLightHandle.position.copy(KEY_LIGHT_POSITION);

    Light.prepareInstanciation(this.camera, SceneManager);

    // The beams have their uniforms from `SceneEnv` as they are built, so
    // there is nothing to push at them here. The bloom is this side's business
    // and follows the room from now on.
    this.applyFogToBloom();
    SceneEnv.on('changed', () => this.applyFogToBloom());

    AnimationManager.add((t) => {
      Light.update(t);
      // Gobo and disc cells drawn since the last frame, uploaded before drawing.
      flushGoboCells(this.renderer);
      Animation.flush(this.renderer);
      LEDField.update(t);
      // The strobes' flash trains, before the field packs them and before the
      // wash reads what they did to the camera.
      Strobe.update(t);
      if (strobeWashEffect) {
        strobeWashEffect.setWash(Strobe.cameraWash(this.camera, strobeWash));
      }
      // After the heads have moved, so what is packed is where they now point
      // rather than where they were a frame ago.
      LightField.update();
      // The floor's contact shadows, after anything that moves casters has had
      // its turn this frame. Redraws only when a caster has moved, and only
      // with the house lights up: they are a placing aid, not part of the show.
      ContactShadows.update(this.renderer, SceneManager, SceneEnv.houseLights);
      // Once per drawn frame, not once per frame received: a 60 fps sender
      // into a busy renderer would otherwise pay for uploads nobody sees.
      VideoFeed.updateAll();
      // Unpacked straight after the upload, into a texture that can actually be
      // filtered -- see `video_decode.js`. Before the screens are told about it,
      // because that is what they will be drawing from.
      VideoDecode.decodeAll(this.renderer, VideoFeed.all());
      Display.syncAll();
      // Each display's picture averaged, for the light it throws.
      Display.updateLight(this.renderer);
      // Rebuild each laser's beam from the points its DAC has played since the
      // last frame. Stream-fed like the video devices, not DMX-driven, so it
      // updates here rather than through setChannel.
      Laser.update(t, this.renderer);
      // Each laser's depth from its aperture, so the beam stops at the first
      // surface rather than running through it. Drawn before the frame, like the
      // projectors' depth pass above.
      Laser.renderDepth(this.renderer, SceneManager);
      // Each lit mover beam's depth from its lens, the same way, within a
      // per-frame tile budget; see `Light.renderDepth`.
      Light.renderDepth(this.renderer, SceneManager);
      Laser.renderFigures(this.renderer);
      const laserProjections = laserEffect ? Laser.projections() : [];
      const projections = projectorEffect ? Projector.collect() : [];
      // The surface colours, once, for whichever passes put light on surfaces.
      const albedo = projections.length || laserProjections.length
        ? SurfaceAlbedo.render(this.renderer, SceneManager, this.camera) : null;
      if (laserEffect) {
        laserEffect.setLasers(
          laserProjections, Laser.figureTexture(), Laser.depthTexture(), Laser.depthFar(),
        );
        laserEffect.setAlbedo(albedo);
      }
      // Each projector's own view of the scene, drawn before the frame is, so
      // the pass can ask whether a surface is actually visible from the lens.
      // Nothing to do at all when no projector is throwing anything.
      if (projectorEffect) {
        if (projections.length) {
          // Redraws only the tiles that would come out different -- a still
          // machine in a still room costs nothing. The atlas works that out
          // itself, per tile; see `DepthAtlas.render`.
          ProjectorDepth.render(this.renderer, SceneManager, projections);
        }
        projectorEffect.setAlbedo(projections.length ? albedo : null);
        // Each projector its own input's picture.
        projections.forEach((projection) => {
          const feed = VideoRouter.feedFor(projection.inputId);
          projection.picture = feed ? feed.displayTexture : null;
        });
        projectorEffect.setProjections(projections);
      }
    });

    // Read from Preferences rather than from Controls: this runs unawaited
    // from init(), so it may get here before the stored settings have been
    // pushed onto the visualizer -- but Preferences.load() is the first thing
    // init() waits for, so the number is already in hand.
    const spacing = Preferences.get('snapSpacing') || 1;
    // One spacing, not two: the helper draws a tenth of it and ten of it as
    // well, and decides which you can see from how big the cells land on
    // screen. See the note in `grid.js`.
    const gridHelper = new InfiniteGridHelper(spacing);
    gridHelper.rotateX(Math.PI / 2.0);
    // Just above the floor rather than below it. The floor is an ordinary
    // plane at z = 0, so a hair above it keeps the grid on top where it can do
    // its job, and anything genuinely standing on the stage still occludes it
    // because the depth test is untouched.
    gridHelper.position.setZ(0.01);
    // Drawn after the floor, so it overlays rather than fighting it for the
    // same depth. The material declines to write depth of its own.
    gridHelper.renderOrder = 1;
    helpers.grid = gridHelper;
    applyGridStyle();
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

    // The floor is an object in the show, not a fixture of the renderer --
    // see `DEFAULT_FLOOR` -- so it can be moved, resized, replaced or deleted,
    // and the item list shows it.
    //
    // The global light needs something to aim at, and not the floor: aiming
    // at an object the user is allowed to delete would put the
    // key light wherever that object last stood. An empty node at the origin
    // is what a directional light actually wants -- only its direction is
    // read, and the origin is the one point a show cannot move.
    const globalLightTarget = new THREE.Object3D();
    this.globalLightHandle.target = globalLightTarget;

    SceneManager.add(this.globalLightHandle, globalLightTarget, axesHelper);

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

    // Nothing is built into the field up front, so the watermark that
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
      // False on the library's own advice: canvas MSAA "only applies to the
      // canvas", and nothing is drawn there -- every frame goes through the
      // EffectComposer, whose own `multisampling` option is where the real
      // antialiasing happens. True here bought nothing and paid for a
      // multisampled canvas nobody rendered into.
      // https://github.com/pmndrs/postprocessing/wiki/Antialiasing
      antialias: false,
    });

    this.renderer.autoClear = true;
    // Shadow casting is driven by the fixtures' spot lights; without `enabled`
    // the map is never rendered and `autoUpdate` alone does nothing.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.physicallyCorrectLights = true;
    // One device pixel per drawing-buffer pixel. This ran at 0.8 for a while --
    // the comment on it claimed to be forcing 1 -- which renders the viewport
    // at 64% of the pixels and lets the compositor stretch it back by 1.25.
    // That stretch is not free: a non-integer resample of detail that already
    // reaches the buffer's Nyquist limit beats against the output grid, and on
    // anything finely detailed (a video wall especially) the beat reads as a
    // regular hatch -- moire that no shader or texture filter can answer,
    // because it happens after both.
    this.renderer.setPixelRatio(1);
    // Tone mapping moves into the composer. Left on the renderer it is applied
    // per material, clamping emitters to white before bloom can tell that they
    // are brighter than white.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.prepareComposer();
    // Needs the renderer, so it cannot run any earlier than this.
    installAmbient(this.renderer, SceneManager);
    Perf.init(this.renderer);
    // Reported beside the timings: it is the number you read off while
    // moving around to work out how far away something is.

    // Anything the debug panel was left holding, put back. Here rather than
    // beside `Preferences.load()` because half of these targets -- the bloom,
    // the ambient haze -- are made by `prepareComposer` and `installAmbient`
    // immediately above, and applying to a target that does not exist yet
    // would silently restore nothing.
    const restored = Tuning.applyStored(this);
    if (restored) console.log(`[tuning] restored ${restored} stored values`);
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
      // Without this every edge in the scene is aliased, `antialias: true` on
      // the renderer notwithstanding: that flag applies to the default
      // framebuffer, and nothing is drawn there -- the scene goes into the
      // composer's own render target, which defaults to no multisampling.
      //
      // It shows worst on the beams, because they are additive and because the
      // sRGB curve is near-vertical at the bottom: a cone's silhouette steps
      // 26 -> 38 in one pixel, and where that hard edge falls *inside* another
      // beam it reads as a line ruled across it. That is the dark line where
      // two beams cross -- not shading, not geometry, just an un-antialiased
      // silhouette on top of something bright.
      multisampling: MSAA_SAMPLES,
    });

    renderPass = new RenderPass(SceneManager, this.camera);
    finalComposer.addPass(renderPass);

    if (USE_BLOOM) {
      bloomEffect = new BloomEffect({
        blendFunction: BlendFunction.ADD,
        intensity: GLARE_STRENGTH,
        luminanceThreshold: 0,
        luminanceSmoothing: 0,
        mipmapBlur: true,
        radius: GLARE_RADIUS,
        kernelSize: KernelSize.LARGE,
      });
    }

    this.applyExposure();
    toneMappingEffect = new ToneMappingEffect({
      mode: ToneMappingMode[CAMERA_TONE_CURVE],
    });
    const toneMapping = toneMappingEffect;

    // Before bloom and tone mapping: the air is part of the image, so it has
    // to be there when glare and the tone curve are worked out. It reads the
    // depth buffer, which is why it cannot be a plain material on geometry.
    ambientHazeEffect = new AmbientHazeEffect(this.camera);

    // The beams' light scattered a second time, the glow beside each beam.
    // Light in the air, so before the room's haze veils it and before bloom
    // and the tone curve; it holds only the beams. See beam_halo.js.
    beamHaloEffect = new BeamHaloEffect(this.camera);

    // Before the haze, because a projected image is light arriving at a surface
    // and the air in front of it should veil it like anything else. Before
    // bloom for the same reason a lamp is: a bright projection on stone glares.
    projectorEffect = new ProjectorEffect(this.camera);
    laserEffect = new LaserEffect(this.camera);
    // Before bloom and tone mapping, so a flash at the eye is an add in linear
    // light that the tone curve takes to white, rather than a grey veil.
    strobeWashEffect = new StrobeWashEffect();

    // The laser figure gets a pass of its own, ahead of the rest.
    //
    // Everything in one EffectPass is merged into a single shader, but bloom
    // does its blur in `update()` -- before that shader runs -- over the pass's
    // *input*, which is the scene as the RenderPass left it. So anything added
    // inside the merged shader is invisible to bloom: the beam in the air
    // glows, being real geometry, while a figure painted in the merged shader
    // cannot, however far its gain is pushed. A laser line without bloom reads
    // as matte paint rather than light. Landing it in an earlier pass puts it
    // into the buffer bloom then samples.
    //
    // The projector deliberately stays behind bloom: its brightness is
    // calibrated in lux against a real rig, and a glow would change how every
    // mapping show looks.
    laserPass = new EffectPass(this.camera, laserEffect);
    finalComposer.addPass(laserPass);
    // A pass of its own: the trace reads the frame at other pixels than its
    // own, which a merged effect cannot. After the scene and the laser figure,
    // before the projector, the air and the tone curve, so a reflection is
    // veiled by the haze in front of it and goes through bloom like any light.
    reflectionsEffect = new ReflectionsEffect(SceneManager, this.camera);
    reflectionsPass = new EffectPass(this.camera, reflectionsEffect);
    reflectionsEffect.pass = reflectionsPass;
    reflectionsEffect.setOn(this._reflections !== false);
    finalComposer.addPass(reflectionsPass);
    // Last, after the tone curve: the outline is a mark on the picture, not
    // light in the scene, and its orange is the orange it is drawn in.
    selectionOutlineEffect = new SelectionOutlineEffect(this.camera);
    const effects = bloomEffect
      ? [projectorEffect, beamHaloEffect, ambientHazeEffect, strobeWashEffect, bloomEffect, toneMapping]
      : [projectorEffect, beamHaloEffect, ambientHazeEffect, strobeWashEffect, toneMapping];
    effects.push(selectionOutlineEffect);
    mainPass = new EffectPass(this.camera, ...effects);
    finalComposer.addPass(mainPass);

    // A depth-reading effect -- the ambient haze, here -- makes the composer
    // build a third render target and blit the scene's depth into it every
    // frame for the effect to sample. It builds its three depth textures as
    // one `new DepthTexture()` and two `clone()`s of it, and `Texture.copy`
    // assigns `this.source = source.source`: a clone shares the original's
    // `Source` by reference. three keys its GPU textures by `Source` plus a
    // parameter cache key, so identical clones resolve to a single
    // `WebGLTexture` -- the composer attaches the same image to the buffer it
    // reads from and the target it writes to, and the driver rejects the blit:
    //
    //   GL_INVALID_OPERATION: glBlitFramebuffer: Read and write depth stencil
    //   attachments cannot be the same image.
    //
    // Sixty times a second, from the first frame the visualizer draws. Nothing
    // looks wrong, because the failed copy's destination already *is* its
    // source and the effect reads the right depth by accident. The flood is
    // the damage: Chromium caps how many GL errors it reports per context,
    // this exhausts the cap within seconds, and every other GL error in the
    // session is silently dropped from then on -- a standing hiding place for
    // the next real bug, and very nearly one for the beam shader's NaNs.
    //
    // Giving the stable depth texture a `Source` of its own is enough to tell
    // the two apart. Upstream's to fix properly; this is postprocessing 6.39.3
    // against three 0.170.0.
    const stableDepth = finalComposer.stableDepthTexture;
    if (stableDepth) {
      stableDepth.source = new THREE.Source(stableDepth.image);
    }
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

  }

  /**
   * The camera's exposure and tone curve, for comparing settings; not stored.
   *
   * @public
   * @param {Object} camera `{ ev, curve }`, curve a `ToneMappingMode` name
   */
  setCamera({ ev, curve } = {}) {
    if (Number.isFinite(ev)) this.renderer.toneMappingExposure = exposureForEV(ev);
    if (curve && toneMappingEffect && ToneMappingMode[curve] !== undefined) {
      toneMappingEffect.mode = ToneMappingMode[curve];
    }
  }

  /** @public @returns {Object} the camera as set */
  get cameraSettings() {
    const mode = toneMappingEffect ? toneMappingEffect.mode : null;
    const curve = Object.keys(ToneMappingMode).find((k) => ToneMappingMode[k] === mode) || null;
    const ev = Math.log2(1 / (1.2 * SCENE_PER_NIT * this.renderer.toneMappingExposure));
    return { ev, curve };
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
    this.camera = new THREE.PerspectiveCamera(ORTHO_REFERENCE_FOV, aspect, 0.01, 1000);
    this.camera.up.set(0, 0, 1);
    this.perspectiveCamera = this.camera;
    // Made on first use, and kept: see `orthographic`.
    this.orthoCamera = null;
    // Only where the camera sits for the instant before a show is framed:
    // `frameDefault` decides the real opening view from what the show actually
    // contains, rather than from a rig that happened to be here once.
    this.camera.position.set(4.6, -4.6, 3);
    this.camera.lookAt(0, 0, 1);
  }

  /**
   * Builds the corner navigation gizmo. It has a canvas of its own, so its
   * clicks never reach the scene's picking.
   *
   * @public
   */
  prepareNavGizmo() {
    // Never proxied: the visualizer handle hangs off the reactive show, so
    // anything assigned to it is wrapped.
    this.navGizmo = markRaw(new NavGizmo(this.camera, this.domElement, {
      pick: (hit) => Controls.setView(hit.view),
      orbit: (dx, dy) => this.orbitBy(dx, dy),
    }));
  }

  /**
   * Turns the view about the orbit centre by a pointer drag, as dragging the
   * scene does: the same rate and direction, and the same limits. The cube
   * sits on its own canvas, so its drags do not reach the orbit control.
   *
   * @public
   * @param {Number} dx pixels across
   * @param {Number} dy pixels down
   */
  orbitBy(dx, dy) {
    const orbit = Controls.controlHandle;
    if (!orbit) return;
    cancelAnimationFrame(Controls.rafID);
    Controls.flying = false;
    const rate = ((2 * Math.PI) / (this.domElement.clientHeight || 1)) * (orbit.rotateSpeed || 1);
    const offset = this.camera.position.clone().sub(orbit.target);
    const radius = offset.length();
    if (radius < 1e-6) return;
    const minPolar = Math.max(orbit.minPolarAngle || 0, 1e-3);
    const maxPolar = Math.min(orbit.maxPolarAngle ?? Math.PI, Math.PI - 1e-3);
    const azimuth = Math.atan2(offset.y, offset.x) - dx * rate;
    const polar = THREE.MathUtils.clamp(Math.acos(offset.z / radius) - dy * rate, minPolar, maxPolar);
    offset.set(
      radius * Math.sin(polar) * Math.cos(azimuth),
      radius * Math.sin(polar) * Math.sin(azimuth),
      radius * Math.cos(polar),
    );
    this.camera.position.copy(orbit.target).add(offset);
    this.camera.lookAt(orbit.target);
    orbit.update();
  }

  /**
   * The drags held by hand: the middle-drag pan, and the two shift adds --
   * turn the view, and lift the whole rig.
   *
   * Every one of them holds the pointer while it runs (pointer lock): the
   * cursor is hidden and the drag reads the mouse's own movement, so it has
   * no screen edge to stop at. On release the cursor is back where it was
   * pressed.
   *
   * A right-drag orbits about whatever is under the pointer when it is
   * pressed, and that point stays under the pointer -- see `orbitAbout`. The
   * controls' own orbit turns about their target, which sits on the optical
   * axis: off screen once the lens is shifted.
   *
   * Ctrl and middle-drag walks: the camera moves along the floor at its
   * height and angle, and the spot grabbed stays under the pointer -- see
   * `walkTo`. Grabbed near the horizon, a short drag covers a long way;
   * near the feet, a little. This is the way down a long street.
   *
   * A middle-drag slides the picture in screen space, as if it were 2D: a
   * lens shift. The camera neither moves nor turns, so nothing changes but
   * where the picture sits in the panel -- see `shiftLens`. In studio mode,
   * where the picture is the recording and a shift would not be kept, it pans
   * the camera in the screen plane instead, the grabbed point under the
   * pointer.
   *
   * Shift and right-drag turns the view without moving the camera; shift and
   * middle-drag translates it vertically. Both are held by hand because the
   * controls cannot express either one -- see below.
   *
   * **Why this is not a pan.** An `OrbitControls` pan translates the camera and
   * its target together, so the view direction it leaves behind is the one it
   * started with -- a pan can cross a room but it cannot raise your eyes. And
   * the camera always looks at the target, so the only way to look up at a
   * truss from standing height is to put the target above the camera. That is
   * this: the look-at point swings around the camera on the sphere it already
   * sits on, which is an orbit with the two ends swapped.
   *
   * **Why the press is taken on `window`, in the capture phase.** Because
   * `OrbitControls` reads a modifier as a *mode swap*, not as a passthrough:
   * shift on a pan-mapped button starts a rotate, and shift on a rotate-mapped
   * one starts a pan (`OrbitControls.js`, `_onMouseDown`). Any modifier gesture
   * laid over its own bindings therefore comes out as the other binding. The
   * event is caught before it reaches the canvas and stopped there, so the
   * controls never see the press and have nothing to swap. They stay enabled
   * throughout, which is what keeps them suppressing the context menu the
   * right button would otherwise raise on release.
   *
   * The target is left wherever the look ends, so the next ordinary right-drag
   * orbits about the thing you just turned to face.
   *
   * @public
   */
  prepareLookAround() {
    this.lookingFrom = null;

    window.addEventListener('pointerdown', (event) => {
      if (event.target !== this.domElement) return;
      let mode = null;
      if (event.shiftKey) {
        mode = (event.button === RIGHT_BUTTON && DRAG_LOOK)
          || (event.button === MIDDLE_BUTTON && DRAG_LIFT);
      } else if (event.button === RIGHT_BUTTON) {
        mode = DRAG_ORBIT;
        const press = { clientX: event.clientX, clientY: event.clientY, currentTarget: this.domElement };
        if (!Controls.scenePointAt(press, orbitPivot)) {
          // At the sky: a point along the pointer's ray, as far as the target.
          const rect = this.domElement.getBoundingClientRect();
          orbitNdc.set(
            (((event.clientX - rect.left) / (rect.width || 1)) * 2) - 1,
            (-((event.clientY - rect.top) / (rect.height || 1)) * 2) + 1,
          );
          orbitRay.setFromCamera(orbitNdc, this.camera);
          orbitRay.ray.at(this.camera.position.distanceTo(this.controls.target), orbitPivot);
        }
      } else if (event.button === MIDDLE_BUTTON && (event.ctrlKey || event.metaKey)) {
        if (this.grabFloor(event)) {
          mode = DRAG_WALK;
          this.walkCursor = { x: event.clientX, y: event.clientY };
        }
      } else if (event.button === MIDDLE_BUTTON) {
        mode = DRAG_PAN;
        // A camera pan moves at the depth of what is under the pointer, so
        // that is what follows it exactly.
        if (this.recordFrame) {
          Controls.setPivotFromPointer({
            clientX: event.clientX,
            clientY: event.clientY,
            currentTarget: this.domElement,
          });
        }
      }
      if (!mode) return;
      cancelAnimationFrame(Controls.rafID);
      Controls.flying = false;
      this.lookingFrom = { x: event.clientX, y: event.clientY, mode };
      this.holdPointer();
      event.stopPropagation();
      event.preventDefault();
    }, true);

    window.addEventListener('pointermove', (event) => {
      if (!this.lookingFrom) return;
      const height = this.domElement.clientHeight || 1;
      // Held, the cursor does not move, and the mouse's movement is the drag.
      const held = document.pointerLockElement === this.domElement;
      const pixelsX = held ? event.movementX : event.clientX - this.lookingFrom.x;
      const pixels = held ? event.movementY : event.clientY - this.lookingFrom.y;
      const dx = (pixelsX / height) * LOOK_TURN_PER_HEIGHT;
      const dy = (pixels / height) * LOOK_TURN_PER_HEIGHT;
      this.lookingFrom.x = event.clientX;
      this.lookingFrom.y = event.clientY;
      if (this.lookingFrom.mode === DRAG_WALK) {
        // The pointer is held still, so where it would be is kept here.
        this.walkCursor.x += pixelsX;
        this.walkCursor.y += pixels;
        this.walkTo(this.walkCursor);
      } else if (this.lookingFrom.mode === DRAG_LOOK && this.orthographic) {
        this.orbitAbout(this.controls.target.clone(), pixelsX, pixels);
      } else if (this.lookingFrom.mode === DRAG_LOOK) this.lookAround(dx, dy);
      else if (this.lookingFrom.mode === DRAG_ORBIT) this.orbitAbout(orbitPivot, pixelsX, pixels);
      else if (this.lookingFrom.mode === DRAG_PAN && this.recordFrame) this.panView(pixelsX, pixels);
      else if (this.lookingFrom.mode === DRAG_PAN) this.shiftLens(pixelsX, pixels);
      else this.liftView(pixels);
      event.stopPropagation();
    }, true);

    window.addEventListener('pointerup', () => {
      if (!this.lookingFrom) return;
      this.lookingFrom = null;
      if (document.pointerLockElement === this.domElement) document.exitPointerLock();
    }, true);
  }

  /**
   * Holds the pointer for a camera drag. Where it cannot be held the drag
   * still runs, from the cursor's position, and stops at the screen's edge.
   *
   * @private
   */
  holdPointer() {
    try {
      const held = this.domElement.requestPointerLock();
      if (held && held.catch) held.catch(() => {});
    } catch (err) {
      // Not available here; the drag reads the cursor instead.
    }
  }

  /**
   * Swings the look-at point around a camera that stays where it is.
   *
   * Signs follow the orbit drag rather than a game's mouse-look: dragging down
   * looks down, dragging right turns the way an orbit drag right turns.
   *
   * @public
   * @param {Number} dx radians of yaw
   * @param {Number} dy radians of pitch
   */
  lookAround(dx, dy) {
    lookVector.copy(this.controls.target).sub(this.camera.position);
    const radius = lookVector.length();
    // A target sitting on the camera has no direction to turn.
    if (radius < 1e-6) return;

    // Azimuth about world up, which is +Z here, and polar measured from it: a
    // small polar angle is a target overhead, which is the view looking up.
    const theta = Math.atan2(lookVector.y, lookVector.x) - dx;
    const polar = Math.acos(THREE.MathUtils.clamp(lookVector.z / radius, -1, 1)) + dy;
    const phi = THREE.MathUtils.clamp(polar, LOOK_MIN_POLAR, LOOK_MAX_POLAR);

    const flat = Math.sin(phi) * radius;
    this.controls.target.set(
      this.camera.position.x + flat * Math.cos(theta),
      this.camera.position.y + flat * Math.sin(theta),
      this.camera.position.z + Math.cos(phi) * radius,
    );
    this.controls.update();
  }

  /**
   * Lifts the camera and its target together, straight up the world.
   *
   * A plain middle-drag pans in the screen plane, which tilts with the view.
   * This is the move straight up the world, whatever the view's angle.
   *
   * The rate is the one `OrbitControls` pans at -- the world distance a pixel
   * covers at the target's depth -- so a lift and a pan move ground under the
   * pointer at the same speed. Dragging down raises the camera, the same
   * grab-the-world direction as the pan.
   *
   * @public
   * @param {Number} pixels vertical drag since the last move
   */
  liftView(pixels) {
    const height = this.domElement.clientHeight || 1;
    const perPixel = this.orthographic
      ? (2 * (this.camera.top / (this.camera.zoom || 1))) / height
      : (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)
        * this.camera.position.distanceTo(this.controls.target)) / height;
    const lift = pixels * perPixel;
    this.camera.position.z += lift;
    this.controls.target.z += lift;
    this.controls.update();
  }

  /**
   * The wheel: moves the camera toward whatever is under the cursor, or away
   * from it, along the cursor's own line of sight.
   *
   * The point under the cursor stays under it and the view keeps its angle.
   * Each step covers a share of the distance left, so the camera can get as
   * close as wanted and never passes through. Pointing at the sky, it aims at
   * the orbit target's depth. The target is then put at the depth of the
   * point aimed at, on the view's axis, so the navigation gizmo's drag and the
   * controls' own sums have something sensible to turn about.
   *
   * @public
   */
  prepareWheel() {
    this.domElement.addEventListener('wheel', (event) => {
      event.preventDefault();
      cancelAnimationFrame(Controls.rafID);
      Controls.flying = false;
      const pixels = event.deltaY * (event.deltaMode === 1 ? WHEEL_LINE_PX : 1);
      this.wheelToward(event, pixels);
    }, { passive: false });
  }

  /**
   * One wheel move, toward the point under the pointer.
   *
   * @public
   * @param {Object} event wheel event
   * @param {Number} pixels wheel travel, positive away from the scene
   */
  wheelToward(event, pixels) {
    const press = { clientX: event.clientX, clientY: event.clientY, currentTarget: this.domElement };
    const rect = this.domElement.getBoundingClientRect();
    orbitNdc.set(
      (((event.clientX - rect.left) / (rect.width || 1)) * 2) - 1,
      (-((event.clientY - rect.top) / (rect.height || 1)) * 2) + 1,
    );
    if (this.orthographic) {
      this.zoomOrtho(orbitNdc, pixels);
      return;
    }
    orbitRay.setFromCamera(orbitNdc, this.camera);
    if (!Controls.scenePointAt(press, wheelPoint)) {
      orbitRay.ray.at(Math.max(this.camera.position.distanceTo(this.controls.target), 1), wheelPoint);
    }
    const distance = this.camera.position.distanceTo(wheelPoint);
    if (!(distance > 1e-6)) return;
    // Nearer by a share of what is left; further by the share that undoes it.
    const keep = Math.exp(pixels * WHEEL_RATE);
    const next = Math.min(distance * keep, this.controls.maxDistance || Infinity);
    wheelStep.subVectors(wheelPoint, this.camera.position).multiplyScalar(1 - next / distance);
    this.camera.position.add(wheelStep);
    this.camera.updateMatrixWorld();
    wheelForward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const depth = Math.max(wheelForward.dot(wheelStep.subVectors(wheelPoint, this.camera.position)), 0.05);
    this.controls.target.copy(this.camera.position).addScaledVector(wheelForward, depth);
    this.controls.update();
  }

  /**
   * The wheel in orthographic: moving nearer changes nothing there, so the
   * frustum is made smaller or larger instead, about the point under the
   * cursor, which stays where it is on screen.
   *
   * @private
   * @param {THREE.Vector2} ndc the cursor, -1..1
   * @param {Number} pixels wheel travel, positive away from the scene
   */
  zoomOrtho(ndc, pixels) {
    const camera = this.camera;
    camera.updateMatrixWorld();
    const before = new THREE.Vector3(ndc.x, ndc.y, 0).unproject(camera);
    const half = camera.top / (camera.zoom || 1);
    const next = THREE.MathUtils.clamp(half * Math.exp(pixels * WHEEL_RATE), ORTHO_MIN_HALF, ORTHO_MAX_HALF);
    setOrthoHalfHeight(camera, next * (camera.zoom || 1));
    camera.updateMatrixWorld();
    const after = new THREE.Vector3(ndc.x, ndc.y, 0).unproject(camera);
    const shift = before.sub(after);
    camera.position.add(shift);
    this.controls.target.add(shift);
    this.controls.update();
  }

  /**
   * Whether the view is orthographic: parallel projection, as a technical
   * drawing's elevation or plan, with nothing shrinking with distance.
   *
   * Setting it swaps the camera for the other kind, looking the same way at
   * the same orbit target, with the picture the same size there: the
   * orthographic frustum is as tall as the perspective view at the target.
   * Studio and recording are perspective only, so it cannot be set while a
   * recording frame is held.
   *
   * @type {Boolean}
   */
  get orthographic() {
    return !!(this.camera && this.camera.isOrthographicCamera);
  }

  set orthographic(on) {
    const want = !!on;
    if (want === this.orthographic || !this.camera || !this.controls) return;
    if (want && this.recordFrame) return;
    Controls.cancelFly();
    const from = this.camera;
    const { target } = this.controls;
    from.updateMatrixWorld();
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(from.quaternion);
    const tan = Math.tan(THREE.MathUtils.degToRad(ORTHO_REFERENCE_FOV) / 2);
    const width = this.domElement.offsetWidth || 1;
    const height = this.domElement.clientHeight || 1;
    const aspect = width / height;
    const view = from.view && from.view.enabled ? { ...from.view } : null;

    let to;
    if (want) {
      if (!this.orthoCamera) {
        this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, ORTHO_STANDOFF * 10);
        this.orthoCamera.up.set(0, 0, 1);
      }
      to = this.orthoCamera;
      const half = Math.max(from.position.distanceTo(target), 0.05) * tan;
      to.top = half;
      to.bottom = -half;
      to.left = -half * aspect;
      to.right = half * aspect;
      to.zoom = 1;
      to.position.copy(target).addScaledVector(forward, -ORTHO_STANDOFF);
    } else {
      to = this.perspectiveCamera;
      const distance = (from.top / (from.zoom || 1)) / tan;
      to.aspect = aspect;
      to.position.copy(target).addScaledVector(forward, -distance);
    }
    to.quaternion.copy(from.quaternion);
    // The lens shift goes with the view.
    if (view) {
      from.clearViewOffset();
      to.setViewOffset(view.fullWidth, view.fullHeight, view.offsetX, view.offsetY, view.width, view.height);
    } else if (to.view && to.view.enabled) {
      to.clearViewOffset();
    }
    to.updateProjectionMatrix();
    to.updateMatrixWorld();
    this.useCamera(to);
    this.controls.update();
  }

  /**
   * Hands a camera to everything that draws or moves through one.
   *
   * @private
   * @param {THREE.Camera} camera
   */
  useCamera(camera) {
    this.camera = camera;
    Controls.cameraHandle = camera;
    if (Controls.handle) Controls.handle.camera = camera;
    this.controls.object = camera;
    Light.setCamera(camera);
    if (this.navGizmo) this.navGizmo.camera = camera;
    [renderPass, laserPass, reflectionsPass, mainPass].forEach((pass) => {
      if (pass) pass.mainCamera = camera;
    });
    [ambientHazeEffect, beamHaloEffect, projectorEffect, laserEffect, selectionOutlineEffect,
      reflectionsEffect].forEach((effect) => {
      if (effect) effect.camera = camera;
    });
  }

  /**
   * Keeps an orthographic camera at its standoff behind the orbit target.
   * Along its own axis an orthographic camera can stand anywhere without the
   * picture changing, so this costs nothing to look at and keeps the scene
   * clear of the near plane whatever the moves before it did.
   *
   * @private
   */
  keepOrthoStandoff() {
    if (!this.orthographic) return;
    const forward = orbitForward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.camera.position.copy(this.controls.target).addScaledVector(forward, -ORTHO_STANDOFF);
  }

  /**
   * The editor's perspective field of view, whichever camera is in use.
   *
   * @type {Number} degrees
   */
  get fov() {
    return this.perspectiveCamera ? this.perspectiveCamera.fov : ORTHO_REFERENCE_FOV;
  }

  /**
   * Picks the spot a walk holds on to: what is under the pointer, on a level
   * plane through it -- the floor, or the top of whatever stands there.
   *
   * @private
   * @param {Object} event the press
   * @returns {Boolean} false at the sky, where there is nothing to hold
   */
  grabFloor(event) {
    const press = { clientX: event.clientX, clientY: event.clientY, currentTarget: this.domElement };
    if (!Controls.scenePointAt(press, walkGrab)) return false;
    walkPlane.constant = -walkGrab.z;
    return true;
  }

  /**
   * Moves the camera along the floor so the grabbed spot sits under the
   * pointer. Only the camera's place changes, never its height or angle. A
   * pointer above the horizon, or one that would reach past the farthest the
   * camera may be, leaves the camera where it is.
   *
   * @public
   * @param {Object} cursor `{ x, y }`, client pixels
   */
  walkTo(cursor) {
    const rect = this.domElement.getBoundingClientRect();
    orbitNdc.set(
      (((cursor.x - rect.left) / (rect.width || 1)) * 2) - 1,
      (-((cursor.y - rect.top) / (rect.height || 1)) * 2) + 1,
    );
    this.camera.updateMatrixWorld();
    orbitRay.setFromCamera(orbitNdc, this.camera);
    if (!orbitRay.ray.intersectPlane(walkPlane, walkMeet)) return;
    if (this.camera.position.distanceTo(walkMeet) > (this.controls.maxDistance || Infinity)) return;
    walkStep.subVectors(walkGrab, walkMeet);
    walkStep.z = 0;
    this.camera.position.add(walkStep);
    this.controls.target.add(walkStep);
    this.controls.update();
  }

  /**
   * Turns the camera rigidly about a point: yaw about the world's up, pitch
   * about the camera's own horizontal. The point keeps its place in the
   * camera's frame, so it stays under the pointer, and the horizon stays
   * level. The rate and directions are the orbit control's; pitch stops short
   * of straight up and straight down.
   *
   * @public
   * @param {Object} pivot THREE.Vector3, world
   * @param {Number} pixelsX horizontal drag since the last move
   * @param {Number} pixelsY vertical drag since the last move
   */
  orbitAbout(pivot, pixelsX, pixelsY) {
    const rate = ((2 * Math.PI) / (this.domElement.clientHeight || 1)) * (this.controls.rotateSpeed || 1);
    const turn = (axis, angle) => {
      orbitTurn.setFromAxisAngle(axis, angle);
      this.camera.position.sub(pivot).applyQuaternion(orbitTurn).add(pivot);
      this.controls.target.sub(pivot).applyQuaternion(orbitTurn).add(pivot);
      this.camera.quaternion.premultiply(orbitTurn);
    };
    turn(WORLD_UP, -pixelsX * rate);
    // Pitch about the camera's horizontal, unless it would carry the view
    // past the limits the orbit control keeps.
    orbitAxis.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const pitch = -pixelsY * rate;
    orbitTurn.setFromAxisAngle(orbitAxis, pitch);
    orbitForward.set(0, 0, -1).applyQuaternion(this.camera.quaternion).applyQuaternion(orbitTurn);
    const polar = Math.acos(THREE.MathUtils.clamp(orbitForward.z, -1, 1));
    if (polar > LOOK_MIN_POLAR && polar < LOOK_MAX_POLAR) turn(orbitAxis, pitch);
    this.camera.updateMatrixWorld();
    this.controls.update();
  }

  /**
   * Slides the picture by a drag, in screen pixels: a lens shift.
   *
   * The camera's frustum is offset rather than the camera moved, so every
   * pixel is projected exactly as before and only the window onto the picture
   * moves. Picking, zoom and every pass read the same projection, so they keep
   * lining up. Any flight of the camera clears it -- a view-cube face, a
   * frame, a recalled view -- since those aim the camera afresh.
   *
   * @public
   * @param {Number} pixelsX horizontal drag since the last move
   * @param {Number} pixelsY vertical drag since the last move
   */
  shiftLens(pixelsX, pixelsY) {
    const width = this.domElement.clientWidth || 1;
    const height = this.domElement.clientHeight || 1;
    const { view } = this.camera;
    const shifted = view && view.enabled;
    const x = (shifted ? (view.offsetX * width) / view.fullWidth : 0) - pixelsX;
    const y = (shifted ? (view.offsetY * height) / view.fullHeight : 0) - pixelsY;
    this.camera.setViewOffset(width, height, x, y, width, height);
  }

  /**
   * Moves the camera and its target together in the screen plane, so the
   * scene follows the pointer at the target's depth and the view keeps its
   * angle.
   *
   * @public
   * @param {Number} pixelsX horizontal drag since the last move
   * @param {Number} pixelsY vertical drag since the last move
   */
  panView(pixelsX, pixelsY) {
    const height = this.domElement.clientHeight || 1;
    const distance = this.camera.position.distanceTo(this.controls.target);
    const perPixel = (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)
      * distance) / height;
    this.camera.updateMatrixWorld();
    panRight.setFromMatrixColumn(this.camera.matrixWorld, 0);
    panUp.setFromMatrixColumn(this.camera.matrixWorld, 1);
    panStep.copy(panRight).multiplyScalar(-pixelsX * perPixel)
      .addScaledVector(panUp, pixelsY * perPixel);
    this.camera.position.add(panStep);
    this.controls.target.add(panStep);
    this.controls.update();
  }

  /**
   * Prepares Visualizer's camera controls
   *
   * @public
   */
  prepareControls() {
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    // The wheel is done by hand -- see `prepareWheel`. The controls' zoom
    // closes on their target, and stops dead once it is reached.
    this.controls.enableZoom = false;
    // Weight. Without damping every drag stops dead on mouse-up, which reads as
    // twitchy on a large scene; the update loop that makes it work is already
    // running below.
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    // Below the wheel's own nearest target depth, so the controls never push
    // the camera back off something it has been brought close to.
    this.controls.minDistance = 0.01;
    // Far enough out for a building being mapped: a hundred metres is inside
    // a big room.
    this.controls.maxDistance = 400;
    this.controls.target.set(0, 0, 4.1);
    // Fixtures aimed downward can only be seen from underneath, so the camera
    // has to be able to get below them; stopping just short of the pole avoids
    // the gimbal flip at straight-up.
    this.controls.maxPolarAngle = Math.PI * 0.98;
    // Left is reserved for picking and rubber-band selection, so the camera
    // moves on the other two, both by hand in `prepareLookAround`: right
    // orbits about the point under the pointer, middle shifts the picture.
    // The controls keep the wheel.
    this.controls.mouseButtons = {
      LEFT: null,
      MIDDLE: null,
      RIGHT: null,
    };

    this.prepareLookAround();
    this.prepareWheel();
    this.controls.autoRotate = this.autoRotate;
    this.controls.autoRotateSpeed = 2.5
    AnimationManager.add(() => {
      this.controls.update();
      this.keepOrthoStandoff();
    });
  }

  /**
   * Resize handler.
   * Handles renderer's resizing and ensures preservation of screen aspect ratio.
   *
   * @public
   */
  resize() {
    // A pinned frame owns the drawing buffer. Letterboxing changes the
    // element's own size, so leaving this running would immediately overwrite
    // the recording size with whatever the panel had shrunk the canvas to --
    // and the take would come out a size nobody asked for, with no error.
    if (this.recordFrame) return;
    const width = this.domElement.offsetWidth;
    const height = this.domElement.clientHeight;
    const aspect = width / height;
    if (this.width !== width || this.height !== height) {
      this.width = width;
      this.height = height;
      // Buffer only, never the canvas's own style. setSize writes inline
      // width and height by default, and a ResizeObserver is watching this
      // very element -- so each resize would restyle what it measures, while
      // the stylesheet's `!important` sizing overrides it again. The buffer
      // and the displayed size would disagree for a frame on every frame of a
      // drag: flicker. CSS sizes the canvas; this only sizes what is drawn.
      this.renderer.setSize(width, height, false);
      // Sized to the drawing buffer, so the depth texture it carries lines up
      // with `gl_FragCoord` in the beam shader without a scale factor.
      if (finalComposer) finalComposer.setSize(width, height);
      if (this.orthographic) {
        const half = this.camera.top;
        this.camera.left = -half * aspect;
        this.camera.right = half * aspect;
      } else {
        this.camera.aspect = aspect;
      }
      // A lens shift is kept in proportion to the panel.
      const { view } = this.camera;
      if (view && view.enabled) {
        this.camera.setViewOffset(
          width,
          height,
          (view.offsetX * width) / view.fullWidth,
          (view.offsetY * height) / view.fullHeight,
          width,
          height,
        );
      }
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Where the camera is and what it orbits, as plain numbers.
   *
   * Plain objects rather than `Vector3` on purpose: this crosses into a Vue
   * reactive store, and a proxied three.js object is the recurring fault in
   * this codebase -- it stops handing its own properties back. Numbers cannot
   * be broken that way.
   *
   * The target is `OrbitControls`' own, which *is* the look-at point: the
   * camera is always pointed at it, so storing the pair is enough to restore a
   * view exactly.
   *
   * @type {{position: {x: Number, y: Number, z: Number},
   *         target: {x: Number, y: Number, z: Number}}}
   */
  get viewpoint() {
    // Orthographic: where a perspective camera would stand to show the same,
    // so a viewpoint is always one a studio camera can use.
    const p = this.orthographic && this.controls
      ? this.controls.target.clone().addScaledVector(
        orbitForward.set(0, 0, -1).applyQuaternion(this.camera.quaternion),
        -Controls.orthoDistance(),
      )
      : this.camera.position;
    const t = this.controls ? this.controls.target : { x: 0, y: 0, z: 0 };
    // A middle-drag's lens shift, as fractions of the panel so it lands the
    // same in a window of another size.
    const { view } = this.camera;
    const shift = view && view.enabled && view.fullWidth && view.fullHeight
      ? { x: view.offsetX / view.fullWidth, y: view.offsetY / view.fullHeight }
      : null;
    return {
      position: { x: p.x, y: p.y, z: p.z },
      target: { x: t.x, y: t.y, z: t.z },
      shift,
      orthographic: this.orthographic,
    };
  }

  set viewpoint(value) {
    if (!value || !this.camera) return;
    // A view set outright ends any flight still under way, which would
    // otherwise carry on and land somewhere else.
    Controls.cancelFly();
    // The projection first: switching it moves the camera onto the other one,
    // and the position and target below then apply to that.
    if (typeof value.orthographic === 'boolean') this.orthographic = value.orthographic;
    // A recalled view is aimed afresh, so any lens shift goes with it unless
    // the view carries its own.
    Controls.clearLensShift();
    const { position, target } = value;
    if (position) this.camera.position.set(position.x, position.y, position.z);
    if (target && this.controls) this.controls.target.set(target.x, target.y, target.z);
    // `update` is what re-derives the camera's orientation from the target, so
    // without it the camera moves but goes on facing wherever it faced before.
    if (this.controls) this.controls.update();
    // Orthographic: the distance becomes the frustum's size.
    if (this.orthographic && this.controls) {
      const distance = this.camera.position.distanceTo(this.controls.target);
      setOrthoHalfHeight(this.camera, distance * Math.tan(THREE.MathUtils.degToRad(ORTHO_REFERENCE_FOV) / 2));
      this.keepOrthoStandoff();
      this.controls.update();
    }
    const { shift } = value;
    if (shift && Number.isFinite(shift.x) && Number.isFinite(shift.y) && (shift.x || shift.y)) {
      const width = this.domElement.clientWidth || 1;
      const height = this.domElement.clientHeight || 1;
      this.camera.setViewOffset(width, height, shift.x * width, shift.y * height, width, height);
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * The live bloom settings, for the debug panel.
   *
   * Null when bloom is not in the chain, which is how the panel knows whether
   * to offer the folder at all.
   *
   * @public
   * @returns {Object|null} `{ intensity, threshold, radius, manual }`
   */
  // eslint-disable-next-line class-methods-use-this
  get bloom() {
    if (!bloomEffect) return null;
    return {
      intensity: bloomEffect.intensity,
      threshold: bloomEffect.luminanceMaterial.threshold,
      radius: bloomEffect.mipmapBlurPass.radius,
      manual: bloomManual,
    };
  }

  /**
   * Sets one bloom value by hand and stops the haze follower touching it.
   *
   * @public
   * @param {String} key `intensity`, `threshold` or `radius`
   * @param {Number} value
   */
  // eslint-disable-next-line class-methods-use-this
  /**
   * Switches the beams' halo, for comparing with and without and as a
   * rollback. Not stored.
   *
   * @public
   * @param {Boolean} on
   */
  // eslint-disable-next-line class-methods-use-this
  setBeamHalo(on) {
    if (beamHaloEffect) beamHaloEffect.on = !!on;
  }

  setBloom(key, value) {
    if (!bloomEffect) return;
    bloomManual = true;
    if (key === 'intensity') bloomEffect.intensity = value;
    else if (key === 'threshold') bloomEffect.luminanceMaterial.threshold = value;
    else if (key === 'radius') bloomEffect.mipmapBlurPass.radius = value;
  }

  /** Gives the bloom back to the haze follower. @public */
  // eslint-disable-next-line class-methods-use-this
  releaseBloom() {
    bloomManual = false;
  }

  /**
   * Flies to a viewpoint instead of jumping to it.
   *
   * The counterpart of the `viewpoint` setter: same destination, taken over
   * time. `Controls.flyTo` does the work, so this and the view buttons share
   * one animator -- see the note there.
   *
   * @public
   * @param {Object} viewpoint `{ position, target }`
   * @param {Object} [options] `{ seconds, easing, fov, onDone }`
   */
  flyToViewpoint(viewpoint, options = {}) {
    if (!viewpoint || !this.camera) return;
    const { position, target } = viewpoint;
    if (!position || !target) return;
    Controls.flyTo(position, target, {
      ms: Math.max(0, (options.seconds ?? 1) * 1000),
      easing: options.easing || 'inOut',
      fov: options.fov,
      onDone: options.onDone,
    });
  }

  /** @returns {Boolean} whether a camera move is in progress */
  get flying() {
    return !!Controls.flying;
  }

  /**
   * Pins the drawing buffer to a recording's frame.
   *
   * The canvas is the recording -- `captureStream` copies the drawing buffer,
   * so the buffer has to be exactly the frame the user asked for. Two things
   * make that less obvious than it sounds:
   *
   * - `setPixelRatio(0.8)` runs the viewport under-sampled for speed, and it
   *   multiplies whatever `setSize` is given. Left alone, a 1920 x 1080
   *   recording comes out 1536 x 864, silently.
   * - `resize()` would put the panel's own size straight back, so it stands
   *   down for as long as this is set.
   *
   * Called when the record widget opens, not when recording starts, so the shot
   * can be framed against the real crop before anything is written.
   *
   * @public
   * @param {Object} frame
   * @param {Number} frame.width pixels
   * @param {Number} frame.height pixels
   * @param {Number} frame.fov vertical field of view, degrees
   */
  beginRecordingFrame({ width, height, fov }) {
    if (!this.renderer || !this.camera) return;
    // A recording is perspective.
    this.orthographic = false;
    const previous = this.recordFrame;
    if (!previous) {
      this.beforeRecord = {
        fov: this.camera.fov,
        pixelRatio: this.renderer.getPixelRatio(),
      };
    }
    // Only when the frame really changed. Every `setSize` reallocates the
    // composer's buffers, and FOV is adjustable *during* a take -- pulling the
    // whole chain down and rebuilding it to change a projection angle would
    // hitch the footage for no reason.
    const resized = !previous || previous.width !== width || previous.height !== height;
    this.recordFrame = { width, height, fov };
    // The recording is never shifted.
    Controls.clearLensShift();

    if (resized) {
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(width, height, false);
      if (finalComposer) finalComposer.setSize(width, height);
      this.camera.aspect = width / height;
    }
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Releases the frame and gives the viewport back to the panel.
   *
   * @public
   */
  endRecordingFrame() {
    if (!this.recordFrame) return;
    const restore = this.beforeRecord;
    this.recordFrame = null;
    this.beforeRecord = null;
    if (restore) {
      this.renderer.setPixelRatio(restore.pixelRatio);
      this.camera.fov = restore.fov;
    }
    // Forces `resize` to act: it compares against the size it last applied,
    // which is still the recording's, so without this the canvas would keep the
    // recording size until the panel happened to be dragged.
    this.width = null;
    this.height = null;
    this.resize();
  }

  /**
   * Clears the scene of everything that is not the show.
   *
   * Grid, axes, navigation gizmo, the selection gizmo and its bounding box are aids
   * for working, and every one of them would be burned into the footage. The
   * selection goes with them because the gizmo is drawn from it.
   *
   * Nothing here is persisted -- see `helpers.recording`. Stopping puts the
   * user's own grid and axes settings back exactly as they were.
   *
   * @public
   * @param {Boolean} active whether a take is running
   */
  setRecordingMode(active) {
    helpers.recording = !!active;
    if (active) Controls.deselectAll();
    applyHelperVisibility();
  }

  /**
   * Whether a take is running.
   *
   * @public
   * @returns {Boolean}
   */
  get recordingMode() {
    return helpers.recording;
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
      // on the wire would upload 7.5 MB/s into a texture with no readers,
      // because the store accepts every universe on the wire and has no notion
      // of a show. `refresh` returns early on the same condition; this is the
      // upload that feeds it.
      DMXStore.flush(this.renderer, LEDPanel.hasReaders());
      LEDPanel.refresh(this.renderer);
      // Objects are instanced, so the gizmo cannot drag one directly -- it
      // drags a plain node and this copies it into the buffer. Only while
      // something is selected: with nothing picked, no instance can be moving.
      if (Controls.pooledInstances && Controls.pooledInstances.length) {
        SceneObjects.syncFromOwners();
      }
      // Handed over per frame, not once at build time: the composer creates
      // its stable depth texture lazily, so at build time there is nothing to
      // bind. An unbound depth reads 0, which the beam shader treats as no
      // depth at all rather than as a surface at the near plane.
      //
      // It is last frame's depth. A shader cannot sample the depth buffer it
      // is writing into, and the beams are drawn in the same pass as the
      // geometry they end against, so the blit is always one frame behind.
      // Invisible, and free, where a depth prepass costs 10 ms on the
      // 100-mover ring -- the extra target switch, not fill rate, since
      // halving its resolution changes nothing.
      //
      // Only opaque geometry is in it: beams write no depth, so they never
      // end against each other, which is right. A beam is air, not a wall.
      if (finalComposer && finalComposer.stableDepthTexture) {
        Light.setSceneDepth(finalComposer.stableDepthTexture, this.camera);
      }
      if (finalComposer) {
        finalComposer.render();
      } else {
        this.renderer.render(SceneManager, this.camera);
      }
    }
    Perf.end();

    // The finished picture, before anything is drawn over it. The recorder
    // takes it only when its own clock has reached the next frame slot.
    Recorder.frameDrawn();
    Screenshot.frameDrawn(this.renderer.domElement);

    // Over the finished image, and after Perf.end() so their own cost is not
    // counted against the scene it is reporting on. The move gizmo is not
    // drawn while recording: it is an aid, and would sit in the footage. The
    // navigation gizmo has its own canvas, so it is never in the footage.
    if (!helpers.recording) Controls.renderGizmo(this.renderer);
    if (this.navGizmo) this.navGizmo.render();
  }
}

export default Visualizer;
