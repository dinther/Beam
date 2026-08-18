/**
 * @file Application preferences.
 *
 * Settings that belong to the installation rather than to a show: how the
 * scene is rendered, which reference objects are drawn. They persist to their
 * own file in the application data directory, so opening someone else's show
 * does not rearrange your workspace, and your workspace does not travel inside
 * a file you send to someone else.
 *
 * Writes are debounced: these are driven by sliders and checkboxes, and there
 * is no reason to touch the disk on every frame of a drag.
 */

const STORE_NAME = 'preferences';
const SAVE_DELAY = 400;

const DEFAULTS = {
  globalFoggingState: 1,
  globalFoggingDensity: 18,
  globalFoggingTurbulences: 50,
  /**
   * Global brightness with the house lights up. The scene keeps two, because
   * looking at a rig and looking at a show want different rooms, and the one
   * you are not in should not have to be dialled back every time.
   */
  globalBrightness: 60,
  /** Global brightness with the house lights down. */
  brightnessHouseOff: 2,
  /** Which of the two is in force. */
  houseLights: true,
  showGrid: true,
  showAxes: true,
  showFloor: true,
  /** Whether the frame timings and the shader tuning panel are on screen. */
  debug: false,
  /** Scene background, as a hex string. Matches SceneManager's own default. */
  backgroundColor: '#0C0D0A',
};

let values = { ...DEFAULTS };
let saveTimer = null;
let loaded = false;

/** Whether a native store is present, i.e. running under Electron. */
function available() {
  return typeof window !== 'undefined' && !!window.jsonStore;
}

/**
 * Loads preferences from disk, falling back to defaults.
 *
 * @async
 * @returns {Object} the loaded preferences
 */
async function load() {
  if (available()) {
    const stored = await window.jsonStore.read(STORE_NAME);
    if (stored) values = { ...DEFAULTS, ...stored };
  }
  loaded = true;
  return values;
}

/** Queues a write, collapsing rapid changes into one. */
function save() {
  // Before the first load a write would persist defaults over whatever is on
  // disk, so nothing is saved until the stored values are actually in hand.
  if (!loaded || !available()) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    window.jsonStore.write(STORE_NAME, JSON.stringify(values, null, 2));
  }, SAVE_DELAY);
}

/**
 * @param {String} key
 * @returns {*} the stored value, or its default
 */
function get(key) {
  return key in values ? values[key] : DEFAULTS[key];
}

/**
 * @param {String} key
 * @param {*} value
 */
function set(key, value) {
  if (values[key] === value) return;
  values[key] = value;
  save();
}

/** @returns {Object} a copy of every preference */
function all() {
  return { ...values };
}

export default {
  load, get, set, all, DEFAULTS,
};
