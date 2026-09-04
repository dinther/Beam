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

/**
 * Ids for the cameras a user places.
 *
 * A counter rather than anything derived from the name or the position: both
 * of those change, and a camera has to keep its identity when they do.
 */
let nextCameraId = 0;

/**
 * How a placed camera is named before anyone renames it.
 *
 * Numbered from one, and past whatever numbers are already taken rather than
 * off the length of the list -- deleting Camera 2 of three should not make the
 * next one a second Camera 3.
 *
 * @param {Array} cameras
 * @returns {String}
 */
function numberedName(cameras) {
  const taken = cameras
    .map((camera) => /^Camera (\d+)$/.exec(camera.name))
    .filter(Boolean)
    .map((match) => Number(match[1]));
  return `Camera ${taken.length ? Math.max(...taken) + 1 : 1}`;
}

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
   * Record the desktop audio mix alongside the picture.
   *
   * On by default: a take of a show is nearly always wanted with the track on
   * it, and a silent file is the surprising outcome, not the safe one.
   */
  recordAudio: true,
  /**
   * How long a fly takes.
   *
   * There is no mode beside it. Cut and fly are BUTTONS on each camera rather
   * than a setting, because live you are choosing how to get to this camera
   * at the moment you go -- setting a mode first and then picking a camera is
   * two actions where the job is one, and the mode is invisible by the time it
   * matters.
   */
  transition: { seconds: 1.5 },
  /**
   * Whether the change now in flight was asked to fly.
   *
   * Transient: written immediately before `activeCameraId` changes and read by
   * the watcher that acts on it. It is not a setting and is never persisted.
   */
  flyRequested: false,
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
  /**
   * Which camera the details widget is editing.
   *
   * Separate from `activeCameraId`, because they answer different questions:
   * one is what the viewport is showing, the other is what you are working on.
   * Live, you need to adjust a camera you are about to cut to WITHOUT going to
   * it first -- tying the two together means every glance at a camera's numbers
   * puts it on screen.
   */
  selectedCameraId: SCENE_CAMERA_ID,
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
   * The camera being edited. Never null, same as `activeCamera`.
   *
   * @returns {Object}
   */
  get selectedCamera() {
    return state.cameras.find((camera) => camera.id === state.selectedCameraId)
      || this.activeCamera;
  },

  /** @returns {Boolean} whether the camera being edited is the one on screen */
  get editingLive() {
    return state.selectedCameraId === state.activeCameraId;
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
    if (state.cameras.some((camera) => camera.id === id)) state.selectedCameraId = id;
  },

  /**
   * Locks or unlocks a camera.
   *
   * A locked camera stops following the view. You can still orbit while it is
   * live -- the viewport moves as it always did -- but the camera keeps the
   * framing it was locked at, so cutting away and back returns to it. That is
   * the whole point: without it, looking around while a camera is live silently
   * rewrites the shot you set up.
   *
   * @public
   * @param {String} id camera id
   * @returns {Boolean} whether it is now locked
   */
  toggleCameraLock(id) {
    const camera = state.cameras.find((entry) => entry.id === id);
    if (!camera) return false;
    camera.locked = !camera.locked;
    return camera.locked;
  },

  /**
   * @public
   * @param {String} id camera id
   * @returns {Boolean} whether that camera is locked
   */
  isCameraLocked(id) {
    const camera = state.cameras.find((entry) => entry.id === id);
    return !!(camera && camera.locked);
  },

  /**
   * Cuts to a camera, making it live.
   *
   * @public
   * @param {String} id camera id
   */
  cutToCamera(id) {
    if (!state.cameras.some((camera) => camera.id === id)) return;
    state.flyRequested = false;
    state.activeCameraId = id;
  },

  /**
   * Makes a camera live, travelling to it rather than cutting.
   *
   * @public
   * @param {String} id camera id
   */
  flyToCamera(id) {
    if (!state.cameras.some((camera) => camera.id === id)) return;
    if (id === state.activeCameraId) return;
    state.flyRequested = true;
    state.activeCameraId = id;
  },

  /**
   * @public
   * @param {Number} seconds how long a fly takes
   */
  setTransitionSeconds(seconds) {
    const wanted = Number(seconds);
    if (!Number.isFinite(wanted)) return;
    state.transition.seconds = Math.min(20, Math.max(0.1, wanted));
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
   * Places a camera where the view is now.
   *
   * The viewport is the viewfinder: you fly to what you want to look at and
   * keep it, which needs no placement tool and no second way of describing a
   * position. `position` and `target` are what `OrbitControls` is already
   * holding, so the camera restores the view exactly rather than approximately.
   *
   * The new camera becomes live. In studio mode that cuts to it, which is a
   * cut to the view already on screen and so shows nothing; in editor mode it
   * only decides which camera studio mode will open on.
   *
   * A camera is static for now. Dolly moves belong on the camera rather than
   * beside it -- a move is a property of a shot, not a second kind of object --
   * so they will arrive as a field here and everything that reads `position`
   * will read where the move has got to instead.
   *
   * @public
   * @param {Object} viewpoint `{ position, target, fov }` from the visualizer
   * @returns {Object} the camera that was placed
   */
  addCamera(viewpoint) {
    const source = viewpoint || {};
    const fov = Number(source.fov);
    const camera = {
      id: `camera:${(nextCameraId += 1)}`,
      name: numberedName(state.cameras),
      fov: Number.isFinite(fov)
        ? Math.min(Math.max(fov, LIMITS.minFov), LIMITS.maxFov)
        : this.activeCamera.fov,
      // Falls back to wherever the live camera is, so a caller with no
      // visualizer to ask still gets a camera rather than one at the origin
      // pointing at itself.
      position: { ...(source.position || this.activeCamera.position) },
      target: { ...(source.target || this.activeCamera.target) },
      locked: false,
    };
    state.cameras.push(camera);
    state.activeCameraId = camera.id;
    state.selectedCameraId = camera.id;
    return camera;
  },

  /**
   * Removes a placed camera.
   *
   * The editor camera cannot go: it is the view itself rather than a stored
   * one, and every fallback in here lands on it. Deleting whatever is live
   * falls back to it too, so there is never a moment with no camera.
   *
   * @public
   * @param {String} id camera id
   * @returns {Boolean} whether one was removed
   */
  removeCamera(id) {
    if (id === SCENE_CAMERA_ID) return false;
    const at = state.cameras.findIndex((camera) => camera.id === id);
    if (at < 0) return false;
    state.cameras.splice(at, 1);
    if (state.activeCameraId === id) state.activeCameraId = SCENE_CAMERA_ID;
    if (state.selectedCameraId === id) state.selectedCameraId = state.activeCameraId;
    return true;
  },

  /**
   * The placed cameras, as the show stores them.
   *
   * Without the editor camera, which is live: storing where it happened to be
   * when the file was written would restore a view nobody chose, and it is
   * recreated at startup anyway.
   *
   * Ids are left out. They identify a camera for as long as the app is running
   * and nothing else in the file refers to one, so writing them down would
   * only invite a stale id from one show to answer for another -- which is
   * exactly how an object's geometry cache started handing shows each other's
   * shapes.
   *
   * @public
   * @returns {Array<Object>}
   */
  get showData() {
    // The editor camera is written too, flagged so it can be told apart on the
    // way back in. It is the view the project was left at, and reopening a
    // project to a different view than the one it was closed at loses work
    // that was never anywhere else -- unlike a placed camera, the editor view
    // has no other home.
    //
    // A file written before this carries no flagged record, and `loadCameras`
    // then leaves the current view alone exactly as it always did.
    return state.cameras.map((camera) => ({
      name: camera.name,
      fov: camera.fov,
      position: { ...camera.position },
      target: { ...camera.target },
      ...(camera.locked ? { locked: true } : {}),
      ...(camera.id === SCENE_CAMERA_ID ? { editor: true } : {}),
    }));
  },

  /**
   * Replaces the placed cameras with a show's own.
   *
   * The editor camera is kept as it stands -- it is the view, and a show
   * loading does not move it. Everything else goes, because these belong to
   * the show that was open and not to the one arriving.
   *
   * @public
   * @param {Array} records what `showData` wrote, or nothing
   */
  loadCameras(records) {
    const editor = state.cameras.find((camera) => camera.id === SCENE_CAMERA_ID)
      || state.cameras[0];

    // The show's own editor view, when it has one. Adopted into the existing
    // editor camera rather than replacing it, so its id stays `scene` and
    // everything holding that id keeps working.
    const stored = (records || []).find((record) => record && record.editor);
    if (stored) {
      const fov = Number(stored.fov);
      if (Number.isFinite(fov)) {
        editor.fov = Math.min(Math.max(fov, LIMITS.minFov), LIMITS.maxFov);
      }
      if (stored.position) editor.position = { ...stored.position };
      if (stored.target) editor.target = { ...stored.target };
      editor.locked = !!stored.locked;
    }

    const others = (records || []).filter((record) => !(record && record.editor));
    const placed = others.map((record) => {
      const fov = Number((record || {}).fov);
      nextCameraId += 1;
      return {
        id: `camera:${nextCameraId}`,
        name: String((record || {}).name || '').trim() || 'Camera',
        fov: Number.isFinite(fov)
          ? Math.min(Math.max(fov, LIMITS.minFov), LIMITS.maxFov)
          : editor.fov,
        position: { ...((record || {}).position || editor.position) },
        target: { ...((record || {}).target || editor.target) },
        locked: !!(record || {}).locked,
      };
    });
    state.cameras = [editor, ...placed];
    // A project always opens in editor mode, looking through the editor
    // camera, whatever was live in the show that just closed.
    state.active = false;
    state.activeCameraId = SCENE_CAMERA_ID;
    state.selectedCameraId = SCENE_CAMERA_ID;
    return !!stored;
  },

  /**
   * Moves the live camera.
   *
   * @public
   * @param {String} axis 'x', 'y' or 'z'
   * @param {Number} value metres
   */
  setSelectedPosition(axis, value) {
    const wanted = Number(value);
    if (!Number.isFinite(wanted)) return;
    this.selectedCamera.position = { ...this.selectedCamera.position, [axis]: wanted };
  },

  /**
   * Renames the camera being edited, which is not necessarily the live one.
   *
   * @public
   * @param {String} name
   */
  setSelectedName(name) {
    const wanted = String(name || '').trim();
    if (wanted) this.selectedCamera.name = wanted;
  },

  /**
   * @public
   * @param {Number} fov degrees, clamped to `LIMITS`
   */
  setSelectedFov(fov) {
    const wanted = Math.min(Math.max(Number(fov) || 0, LIMITS.minFov), LIMITS.maxFov);
    this.selectedCamera.fov = wanted;
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
