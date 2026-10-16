import { reactive } from 'vue';
import { SCENE_ITEM_KINDS, kindOf } from './scene_item';

/**
 * @file What the view leaves out: objects, structures, fixture types, and
 * which measurements are drawn. Saved with the project.
 *
 * The filter sits on top of each item's own hide flag and never writes it. An
 * item is drawn when its own flag, its structure or group, and the filter all
 * allow it, so a fixture hidden by hand stays hidden when its type is shown
 * again. Items read `hides` from their `isHidden`; the show pushes the result
 * to the renderers when the filter changes.
 */

export const MEASURE_FILTERS = {
  ALL: 'all',
  SELECTION: 'selection',
  NONE: 'none',
};

const state = reactive({
  objects: true,
  structures: true,
  /** Profile keys of the fixture types left out. */
  hiddenTypes: [],
  measurements: MEASURE_FILTERS.ALL,
});

const listeners = new Set();

function changed() {
  listeners.forEach((listener) => listener());
}

/**
 * Whether the filter leaves an item out. Only the item's own kind and type are
 * asked; a member of a filtered structure is hidden through the structure.
 *
 * @param {Object} item a fixture, object or structure
 * @returns {Boolean}
 */
function hides(item) {
  switch (kindOf(item)) {
    case SCENE_ITEM_KINDS.OBJECT: return !state.objects;
    case SCENE_ITEM_KINDS.STRUCTURE: return !state.structures;
    case SCENE_ITEM_KINDS.FIXTURE: return state.hiddenTypes.includes(item.profileKey);
    default: return false;
  }
}

/**
 * @param {String} key `objects` or `structures`
 * @param {Boolean} shown
 */
function setShown(key, shown) {
  if (state[key] === !!shown) return;
  state[key] = !!shown;
  changed();
}

/**
 * @param {String} profileKey a fixture type, `manufacturer/model`
 * @param {Boolean} shown
 */
function setTypeShown(profileKey, shown) {
  const hidden = state.hiddenTypes.includes(profileKey);
  if (hidden === !shown) return;
  state.hiddenTypes = shown
    ? state.hiddenTypes.filter((key) => key !== profileKey)
    : [...state.hiddenTypes, profileKey];
  changed();
}

/** @param {String} mode one of `MEASURE_FILTERS` */
function setMeasurements(mode) {
  if (!Object.values(MEASURE_FILTERS).includes(mode) || state.measurements === mode) return;
  state.measurements = mode;
  changed();
}

/** Shows everything again. */
function showAll() {
  if (!isFiltering()) return; // eslint-disable-line no-use-before-define
  load(null); // eslint-disable-line no-use-before-define
  changed();
}

/** @returns {Boolean} whether anything is left out */
function isFiltering() {
  return !state.objects || !state.structures || state.hiddenTypes.length > 0
    || state.measurements !== MEASURE_FILTERS.ALL;
}

/**
 * The filter as a project saves it, or undefined when nothing is left out.
 *
 * @returns {Object|undefined}
 */
function toJSON() {
  if (!isFiltering()) return undefined;
  return {
    objects: state.objects,
    structures: state.structures,
    hiddenTypes: [...state.hiddenTypes],
    measurements: state.measurements,
  };
}

/**
 * Takes on a project's filter; anything missing or unreadable shows.
 * Listeners are not told: the load pushes visibility itself.
 *
 * @param {Object} [data] as `toJSON` writes it
 */
function load(data) {
  const d = data && typeof data === 'object' ? data : {};
  state.objects = d.objects !== false;
  state.structures = d.structures !== false;
  state.hiddenTypes = Array.isArray(d.hiddenTypes) ? d.hiddenTypes.filter((k) => typeof k === 'string') : [];
  state.measurements = Object.values(MEASURE_FILTERS).includes(d.measurements)
    ? d.measurements : MEASURE_FILTERS.ALL;
}

/**
 * @param {Function} listener called after every change made through this module
 * @returns {Function} removes the listener
 */
function onChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export default {
  state,
  hides,
  setShown,
  setTypeShown,
  setMeasurements,
  showAll,
  isFiltering,
  toJSON,
  load,
  onChange,
};
