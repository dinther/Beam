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
class SceneEnvironment extends EventEmitter {
  constructor() {
    super();
    this._hazeEnabled = false;
    this._hazeDensity = 0;
    this._hazeTurbulence = 0;
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
   * Effective haze, folding the on/off switch into the density.
   *
   * The single number renderers actually want.
   *
   * @readonly
   * @type {Number} 0..1
   */
  get hazeAmount() {
    return this._hazeEnabled ? this._hazeDensity : 0;
  }
}

export default new SceneEnvironment();
