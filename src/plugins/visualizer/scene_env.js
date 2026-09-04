import { EventEmitter } from 'events';
import Preferences from './preferences';

/**
 * @file Scene-wide rendering environment.
 *
 * Conditions that belong to the room rather than to any fixture -- haze being
 * the one that matters so far. Kept here because it was previously stored in
 * the moving-head beam shader's uniforms, which meant anything else needing to
 * know how hazy the room was had to reach into one fixture type's material,
 * and anything created afterwards missed the value entirely.
 *
 * Renderers subscribe and read; nothing keeps its own copy.
 *
 * **It is also where these values come from.** They used to have three sets of
 * defaults -- one here, one in `visualizer.js`, one in `preferences.js` -- that
 * disagreed with each other (turbulence 0, 100 and 70 respectively), and which
 * one you got depended on the order things happened to be built in. The room
 * now reads its own defaults from `Preferences.DEFAULTS`, adopts the stored
 * settings through `adopt`, and writes every change back itself, so there is
 * one answer to "where does this number come from" and it is this file.
 *
 * Percentages live at the edges. A preference file and a slider both talk in
 * 0..100 because that is what a person reads; everything in here is 0..1, and
 * `STORED` is the only place the two meet.
 */

/**
 * How wide a haze feature is, in metres, before anything says otherwise.
 *
 * Taken from the preference rather than written again here: a second copy of a
 * default is a second answer to the same question.
 *
 * @constant {Number}
 */
const DEFAULT_HAZE_SCALE = Preferences.DEFAULTS.globalFoggingScale;

/**
 * Smallest and largest haze feature, in metres.
 *
 * Room-sized. Finer grains than this read as noise on the beam rather than as
 * air, and the range was set by eye against real beams a few metres long.
 */
const MIN_HAZE_SCALE = 2;
const MAX_HAZE_SCALE = 15;

/**
 * Each stored value: which preference holds it, and how it converts.
 *
 * `from` reads a preference into the room's own units, `to` writes it back.
 * Nothing else in the codebase should divide or multiply one of these by a
 * hundred -- if it does, that is the bug this table exists to prevent.
 *
 * @constant {Object}
 */
const STORED = {
  hazeEnabled: {
    key: 'globalFoggingState',
    from: (value) => value !== 0 && value !== false,
    to: (value) => (value ? 1 : 0),
  },
  hazeDensity: {
    key: 'globalFoggingDensity',
    from: (value) => Number(value) / 100,
    to: (value) => value * 100,
  },
  hazeTurbulence: {
    key: 'globalFoggingTurbulences',
    from: (value) => Number(value) / 100,
    to: (value) => value * 100,
  },
  hazeScale: {
    key: 'globalFoggingScale',
    from: (value) => Number(value),
    to: (value) => value,
  },
};

/**
 * A stored setting in the room's units, falling back to its default.
 *
 * @param {String} field
 * @param {Object} [source] a preference set; the defaults when absent
 * @returns {*}
 */
function stored(field, source) {
  const { key, from } = STORED[field];
  const raw = source && source[key] !== undefined ? source[key] : Preferences.DEFAULTS[key];
  return from(raw);
}

class SceneEnvironment extends EventEmitter {
  constructor() {
    super();
    // Built at the defaults rather than at zero. A panel or a renderer that
    // reads the room before the stored settings arrive now gets the value it
    // would have had anyway, instead of a blank scene it then reports back.
    this._hazeEnabled = stored('hazeEnabled');
    this._hazeDensity = stored('hazeDensity');
    this._hazeTurbulence = stored('hazeTurbulence');
    this._hazeScale = stored('hazeScale');
    this._houseLights = false;
  }

  /**
   * Takes the stored settings, or the defaults where a setting is missing.
   *
   * Called once the preference file is in hand. Assigning through the setters
   * is deliberate: they clamp, they announce, and the write-back they do is a
   * no-op for a value that already matches what is on disk.
   *
   * @public
   * @param {Object} [source] a preference set; the defaults when absent
   */
  adopt(source) {
    this.hazeEnabled = stored('hazeEnabled', source);
    this.hazeDensity = stored('hazeDensity', source);
    this.hazeTurbulence = stored('hazeTurbulence', source);
    this.hazeScale = stored('hazeScale', source);
  }

  /**
   * Records one value and tells everyone, in that order.
   *
   * @private
   * @param {String} field
   * @param {*} value already in the room's own units
   */
  publish(field, value) {
    this[`_${field}`] = value;
    Preferences.set(STORED[field].key, STORED[field].to(value));
    this.emit('changed', this);
  }

  /** @type {Boolean} */
  set hazeEnabled(enabled) {
    this.publish('hazeEnabled', !!enabled);
  }

  get hazeEnabled() {
    return this._hazeEnabled;
  }

  /** @type {Number} 0..1 */
  set hazeDensity(density) {
    this.publish('hazeDensity', Math.min(Math.max(Number(density) || 0, 0), 1));
  }

  get hazeDensity() {
    return this._hazeDensity;
  }

  /** @type {Number} 0..1, how much the haze churns */
  set hazeTurbulence(turbulence) {
    this.publish('hazeTurbulence', Math.min(Math.max(Number(turbulence) || 0, 0), 1));
  }

  get hazeTurbulence() {
    return this._hazeTurbulence;
  }

  /**
   * How wide a haze feature is, in metres.
   *
   * Size, not amount. Density says how much haze there is; this says how
   * coarsely it clumps -- a small value gives fine wisps, a large one slow
   * billows. The two were one control until 2026-08-24, which is why turning
   * the haze up used to change its grain instead of its strength.
   *
   * @type {Number} metres
   */
  set hazeScale(scale) {
    const metres = Number(scale);
    this.publish('hazeScale', Number.isFinite(metres)
      ? Math.min(Math.max(metres, MIN_HAZE_SCALE), MAX_HAZE_SCALE)
      : DEFAULT_HAZE_SCALE);
  }

  get hazeScale() {
    return this._hazeScale;
  }

  /**
   * Whether the house lights are up.
   *
   * Folded into `hazeAmount` rather than kept as a separate thing renderers
   * have to remember to ask about -- see the note there.
   *
   * @type {Boolean}
   */
  set houseLights(on) {
    this._houseLights = !!on;
    this.emit('changed', this);
  }

  get houseLights() {
    return this._houseLights;
  }

  /**
   * Effective haze, folding the on/off switch and the house lights into the
   * density.
   *
   * The single number renderers actually want.
   *
   * **The house lights are deliberately not folded in here.** They were, for
   * about ten minutes, and it was wrong: it killed the beams too. A beam is a
   * fixture scattering light in its own cone and stays visible under work
   * light; what goes is the *room* air between fixtures. So `houseLights` is
   * published separately and only the renderers that draw room air read it --
   * see `roomHaze`.
   *
   * @readonly
   * @type {Number} 0..1
   */
  get hazeAmount() {
    return this._hazeEnabled ? this._hazeDensity : 0;
  }

  /**
   * Haze in the room's air, as distinct from haze a fixture lights.
   *
   * Zero with the house up. Work light is for seeing the rig clearly and you
   * cannot do that through a hazy room -- but the beams themselves still have
   * to read, or the visualiser stops showing what the fixtures are doing.
   *
   * @readonly
   * @type {Number} 0..1
   */
  get roomHaze() {
    return this._houseLights ? 0 : this.hazeAmount;
  }
}

export default new SceneEnvironment();
