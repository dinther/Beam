import { EventEmitter } from 'events';

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
 */

/**
 * How wide a haze feature is, in metres, before anything says otherwise.
 *
 * @constant {Number}
 */
const DEFAULT_HAZE_SCALE = 4;

/**
 * Smallest and largest haze feature, in metres.
 *
 * Room-sized. Finer grains than this read as noise on the beam rather than as
 * air, and the range was set by eye against real beams a few metres long.
 */
const MIN_HAZE_SCALE = 2;
const MAX_HAZE_SCALE = 15;

class SceneEnvironment extends EventEmitter {
  constructor() {
    super();
    this._hazeEnabled = false;
    this._hazeDensity = 0;
    this._hazeTurbulence = 0;
    this._hazeScale = DEFAULT_HAZE_SCALE;
    this._houseLights = false;
  }

  /** @type {Boolean} */
  set hazeEnabled(enabled) {
    this._hazeEnabled = !!enabled;
    this.emit('changed', this);
  }

  get hazeEnabled() {
    return this._hazeEnabled;
  }

  /** @type {Number} 0..1 */
  set hazeDensity(density) {
    this._hazeDensity = Math.min(Math.max(Number(density) || 0, 0), 1);
    this.emit('changed', this);
  }

  get hazeDensity() {
    return this._hazeDensity;
  }

  /** @type {Number} 0..1, how much the haze churns */
  set hazeTurbulence(turbulence) {
    this._hazeTurbulence = Math.min(Math.max(Number(turbulence) || 0, 0), 1);
    this.emit('changed', this);
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
    this._hazeScale = Number.isFinite(metres)
      ? Math.min(Math.max(metres, MIN_HAZE_SCALE), MAX_HAZE_SCALE)
      : DEFAULT_HAZE_SCALE;
    this.emit('changed', this);
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
