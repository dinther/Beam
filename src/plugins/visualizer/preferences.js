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
  globalBrightness: 100,
  /** Global brightness with the house lights down. */
  brightnessHouseOff: 30,
  /** Which of the two is in force. */
  houseLights: true,
  /**
   * Grid spacing, in metres, and the distance the gizmo snaps by. One number
   * for all three axes: a grid that reads as squares and a snap that lands on
   * the lines you can see are the same setting wearing two hats.
   */
  snapSpacing: 0.5,
  /** Whether the gizmo snaps at all. */
  snapEnabled: true,
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

/**
 * What is worth writing down: everything that differs from the default.
 *
 * Writing the merged set instead meant that the first time anything was saved,
 * every default was written with it -- and a stored value always beats a
 * default, so from then on no default could ever reach that installation
 * again. Changing one in a new version did nothing for anybody who had ever
 * touched a setting.
 *
 * A value the user chose that happens to equal the default is left out too, so
 * it would follow the default if that ever moved. That is the trade for a file
 * that only records decisions.
 *
 * Keys the defaults do not know about are kept as they are: they belong to a
 * version that did know, and dropping them would lose that setting on a
 * downgrade.
 *
 * @returns {Object} the settings to store
 */
function departures() {
  const changed = {};
  Object.keys(values).forEach((key) => {
    if (values[key] !== DEFAULTS[key]) changed[key] = values[key];
  });
  return changed;
}

/** Queues a write, collapsing rapid changes into one. */
function save() {
  // Before the first load a write would persist defaults over whatever is on
  // disk, so nothing is saved until the stored values are actually in hand.
  if (!loaded || !available()) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    window.jsonStore.write(STORE_NAME, JSON.stringify(departures(), null, 2));
  }, SAVE_DELAY);
}

/**
 * Writes any pending change immediately.
 *
 * Saving is debounced because these are driven by sliders, which is right
 * until something is about to take the page away -- reloading for a new
 * project throws away a queued write, and the setting silently reverts. Anyone
 * changing a preference and then reloading has to wait for this.
 *
 * @async
 * @returns {Promise} resolved once the file is written
 */
async function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!loaded || !available()) return;
  await window.jsonStore.write(STORE_NAME, JSON.stringify(departures(), null, 2));
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
  load, get, set, all, flush, DEFAULTS,
};
