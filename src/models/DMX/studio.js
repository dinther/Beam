import { reactive } from 'vue';

/**
 * @file Studio mode: what is being filmed, and with which camera.
 *
 * Two fragments have to agree about this and neither owns the other. The
 * visualizer header toggles the mode and the visualizer canvas letterboxes to
 * the frame; the widget bar at the bottom of the window shows the controls. So
 * the state lives here and both of them read it, the same arrangement
 * `selection.js` settled on for the same reason -- two copies of one fact drift
 * the first time something changes only one of them.
 *
 * The recording itself is **not** here. A take is owned by the widget that
 * started it, because it holds an open file handle and a running encoder, and
 * that is not state to be read casually from across the app. What is here is
 * the single flag saying whether one is running, which is all anybody else
 * needs to know -- the mode toggle, to stop it.
 */

/**
 * Frame sizes worth one click, all 16:9 and all landscape.
 *
 * Orientation is a separate control rather than more entries here. A vertical
 * crop of every size would double the list to say one thing, and the two
 * questions are genuinely separate: how big, and which way up.
 */
const PRESETS = [
  { label: '720p', width: 1280, height: 720 },
  { label: '1080p', width: 1920, height: 1080 },
  { label: '1440p', width: 2560, height: 1440 },
  { label: '4K', width: 3840, height: 2160 },
];

/** Bounds on what a camera and a frame will accept. */
const LIMITS = {
  minSize: 64,
  maxSize: 7680,
  minFov: 5,
  maxFov: 120,
};

/**
 * The camera that always exists: the view you are orbiting in the editor.
 *
 * Live rather than a stored position, which is what makes it impossible to
 * break -- there is nothing to set up and nothing to go stale. Cameras the user
 * places join the list beside it, each carrying its own position and target as
 * well as a FOV, and selecting one mid-take cuts to it.
 */
const SCENE_CAMERA_ID = 'scene';

const state = reactive({
  /** Whether the app is in studio mode rather than editor mode. */
  active: false,
  /** Whether a take is running. Written by the recording widget. */
  recording: false,
  /** The frame being recorded, in pixels. */
  frame: { width: 1920, height: 1080 },
  /** Frames per second. */
  fps: 30,
  /** Key into the recorder's quality table. */
  quality: 'medium',
  /**
   * Every camera, the scene camera first.
   *
   * `fov` sits on the camera rather than on the frame because it is a property
   * of the viewpoint: switching cameras mid-take should change the lens with
   * it, not carry one angle across all of them.
   */
  cameras: [{
    id: SCENE_CAMERA_ID,
    name: 'Editor camera',
    fov: 45,
    // Overwritten by the first capture; these only cover the instant before
    // the visualizer has been asked where it is.
    position: { x: 4.6, y: -4.6, z: 3 },
    target: { x: 0, y: 0, z: 4.1 },
  }],
  /** Which camera is live. */
  activeCameraId: SCENE_CAMERA_ID,
});

export default {
  state,
  PRESETS,
  LIMITS,
  SCENE_CAMERA_ID,

  /** @returns {Boolean} whether studio mode is on */
  get active() {
    return state.active;
  },

  /** @returns {Boolean} whether a take is running */
  get recording() {
    return state.recording;
  },

  /**
   * The live camera.
   *
   * Never null: an id that names nothing falls back to the scene camera, which
   * cannot be removed. A widget reading this always has something to edit.
   *
   * @returns {Object} `{ id, name, fov }`
   */
  get activeCamera() {
    return state.cameras.find((camera) => camera.id === state.activeCameraId)
      || state.cameras[0];
  },

  /**
   * The frame and lens the visualizer should compose for.
   *
   * @returns {{width: Number, height: Number, fov: Number}}
   */
  get shot() {
    return {
      width: Math.round(state.frame.width),
      height: Math.round(state.frame.height),
      fov: this.activeCamera.fov,
    };
  },

  /** @returns {String} the frame as a CSS `aspect-ratio` value */
  get aspect() {
    return `${Math.round(state.frame.width)} / ${Math.round(state.frame.height)}`;
  },

  /**
   * Turns studio mode on or off.
   *
   * @public
   * @param {Boolean} value
   */
  setActive(value) {
    state.active = !!value;
  },

  /**
   * @public
   * @param {String} id camera id
   */
  selectCamera(id) {
    if (state.cameras.some((camera) => camera.id === id)) state.activeCameraId = id;
  },

  /**
   * Whether the frame is taller than it is wide.
   *
   * @returns {Boolean}
   */
  get portrait() {
    return state.frame.height > state.frame.width;
  },

  /**
   * Swaps the frame's two dimensions.
   *
   * A swap rather than a stored flag: the frame is the only thing that decides
   * orientation, so a flag beside it would be a second version of the same
   * fact and they would disagree the moment a size was typed by hand.
   *
   * @public
   * @param {Boolean} wantPortrait
   */
  setPortrait(wantPortrait) {
    if (!!wantPortrait === this.portrait) return;
    const { width, height } = state.frame;
    state.frame.width = height;
    state.frame.height = width;
  },

  /**
   * Reads a camera's stored viewpoint.
   *
   * @public
   * @param {String} id camera id
   * @returns {Object|null} `{ position, target }`, or null when unknown
   */
  viewpointOf(id) {
    const camera = state.cameras.find((entry) => entry.id === id);
    if (!camera) return null;
    return { position: { ...camera.position }, target: { ...camera.target } };
  },

  /**
   * Stores a viewpoint on a camera.
   *
   * Copied rather than assigned: the visualizer hands back a fresh plain object
   * each time, but a caller that held on to one could otherwise mutate what the
   * store believes without the store hearing about it.
   *
   * @public
   * @param {String} id camera id
   * @param {Object} viewpoint `{ position, target }`
   */
  captureInto(id, viewpoint) {
    const camera = state.cameras.find((entry) => entry.id === id);
    if (!camera || !viewpoint) return;
    if (viewpoint.position) camera.position = { ...viewpoint.position };
    if (viewpoint.target) camera.target = { ...viewpoint.target };
  },

  /**
   * Moves the live camera.
   *
   * @public
   * @param {String} axis 'x', 'y' or 'z'
   * @param {Number} value metres
   */
  setActivePosition(axis, value) {
    const wanted = Number(value);
    if (!Number.isFinite(wanted)) return;
    this.activeCamera.position = { ...this.activeCamera.position, [axis]: wanted };
  },

  /**
   * Renames the live camera.
   *
   * @public
   * @param {String} name
   */
  setActiveName(name) {
    const wanted = String(name || '').trim();
    if (wanted) this.activeCamera.name = wanted;
  },

  /**
   * @public
   * @param {Number} fov degrees, clamped to `LIMITS`
   */
  setActiveFov(fov) {
    const wanted = Math.min(Math.max(Number(fov) || 0, LIMITS.minFov), LIMITS.maxFov);
    this.activeCamera.fov = wanted;
  },

  /**
   * @public
   * @param {Number} width pixels
   * @param {Number} height pixels
   */
  setFrame(width, height) {
    const clamp = (value) => Math.round(
      Math.min(Math.max(Number(value) || 0, LIMITS.minSize), LIMITS.maxSize),
    );
    state.frame.width = clamp(width);
    state.frame.height = clamp(height);
  },
};
