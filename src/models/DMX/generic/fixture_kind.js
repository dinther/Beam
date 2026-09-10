/**
 * @file The kinds of generic fixture Beam can make, as objects.
 *
 * A kind is a generator built into the app: an LED bar, a projector, a display,
 * a laser. Everything the rest of the app asks about one -- which builder
 * makes its profile, how to recognise a profile it made, which Settings class
 * holds a placement's parameters, what icon stands for it, what it is called
 * in a list -- is answered here by the kind itself, not by a switch on a
 * string at each call site: the create dialog's `create()`,
 * `Show.createGeneratedProfile`, the `Fixture` constructor, `fixtureIcon` and
 * the type list all ask the kind. Adding a kind is one entry in
 * {@link FIXTURE_KINDS}.
 *
 * The kind modules themselves (`led_bar.js`, `projector.js` ...) are pure
 * functions and constants that know nothing about each other. This
 * file is the one place that knows about all of them, which is why it -- and
 * not `kinds.js`, whose job is to have no imports -- holds the registry.
 */

import { GENERIC_KINDS } from './kinds';
import { DEFAULT_BAR_PARAMS, buildLedBarProfile } from './led_bar';
import {
  DEFAULT_PROJECTOR_PARAMS,
  CONTROL_DEFS as PROJECTOR_CONTROL_DEFS,
  buildProjectorProfile,
  isProjectorProfile,
} from './projector';
import {
  DEFAULT_DISPLAY_PARAMS,
  CONTROL_DEFS as DISPLAY_CONTROL_DEFS,
  buildDisplayProfile,
  isDisplayProfile,
} from './display';
import {
  DEFAULT_LASER_PARAMS,
  CONTROL_DEFS as LASER_CONTROL_DEFS,
  buildLaserProfile,
  isLaserProfile,
} from './laser';
import ProjectorSettings from '../projector_settings';
import DisplaySettings from '../display_settings';
import LaserSettings from '../laser_settings';

/**
 * One kind of generic fixture.
 */
export class FixtureKind {
  /**
   * @param {Object} spec
   * @param {String} spec.id one of {@link GENERIC_KINDS}
   * @param {String} spec.label what a list calls it
   * @param {String} spec.icon a uikit icon name
   * @param {String} spec.paramsKey where the profile keeps this kind's
   *   parameters: `profile.asls[paramsKey]`
   * @param {Object} spec.defaults the parameters a new one starts from
   * @param {Array} [spec.controlDefs] its controllable parameters -- see
   *   `device_control.js`; empty for a kind whose channels are pixel data
   * @param {Function} spec.build `(params) => profile`
   * @param {Function} spec.matches `(profile) => Boolean`
   * @param {Function} [spec.Settings] the DeviceSettings subclass that holds a
   *   placement's parameters, for a kind that has any
   */
  constructor({
    id, label, icon, paramsKey, defaults, controlDefs = [], build, matches, Settings = null,
  }) {
    this.id = id;
    this.label = label;
    this.icon = icon;
    this.paramsKey = paramsKey;
    this.defaults = defaults;
    this.controlDefs = controlDefs;
    this._build = build;
    this._matches = matches;
    this.Settings = Settings;
  }

  /**
   * Whether a placement of this kind carries parameters of its own -- a
   * dimmer, a zoom, a source. A bar does not: its channels are pixel data and
   * the shader reads them straight from the DMX texture.
   *
   * @readonly
   * @type {Boolean}
   */
  get hasDevice() { return !!this.Settings; }

  /**
   * Builds an OFL-shaped profile from parameters.
   *
   * @param {Object} params
   * @returns {Object}
   */
  buildProfile(params) { return this._build(params); }

  /**
   * Whether a profile was made by this kind.
   *
   * Asked of the profile's own contents -- what it carries under `asls` --
   * rather than of a category string, which says nothing about what the thing
   * is.
   *
   * @param {Object} profile
   * @returns {Boolean}
   */
  isProfile(profile) { return !!profile && this._matches(profile); }

  /**
   * This kind's parameters, as a profile carries them.
   *
   * @param {Object} profile
   * @returns {Object|null}
   */
  paramsOf(profile) {
    return (profile && profile.asls && profile.asls[this.paramsKey]) || null;
  }

  /**
   * A placement's parameters, for a kind that has any.
   *
   * @param {Object} profile the placement's profile
   * @param {Object} [data] what the show stored for this placement
   * @returns {DeviceSettings|null}
   */
  settingsFor(profile, data) {
    if (!this.Settings) return null;
    return new this.Settings(this.paramsOf(profile) || {}, data);
  }
}

/**
 * Every kind, in the order a list offers them.
 *
 * @constant {Array}
 */
export const FIXTURE_KINDS = [
  new FixtureKind({
    id: GENERIC_KINDS.BAR,
    label: 'LED bar',
    icon: 'ledbar',
    paramsKey: 'bar',
    defaults: DEFAULT_BAR_PARAMS,
    build: buildLedBarProfile,
    matches: (profile) => !!(profile.asls && profile.asls.bar),
  }),
  new FixtureKind({
    id: GENERIC_KINDS.PROJECTOR,
    label: 'Projector',
    icon: 'projector',
    paramsKey: 'projector',
    defaults: DEFAULT_PROJECTOR_PARAMS,
    controlDefs: PROJECTOR_CONTROL_DEFS,
    build: buildProjectorProfile,
    matches: isProjectorProfile,
    Settings: ProjectorSettings,
  }),
  new FixtureKind({
    id: GENERIC_KINDS.DISPLAY,
    label: 'Display',
    // No display glyph in the icon set yet; a projector is the nearest thing
    // that says "video". Draw one and change this line.
    icon: 'projector',
    paramsKey: 'display',
    defaults: DEFAULT_DISPLAY_PARAMS,
    controlDefs: DISPLAY_CONTROL_DEFS,
    build: buildDisplayProfile,
    matches: isDisplayProfile,
    Settings: DisplaySettings,
  }),
  new FixtureKind({
    id: GENERIC_KINDS.LASER,
    label: 'Laser',
    // Likewise: no laser glyph yet.
    icon: 'movinghead',
    paramsKey: 'laser',
    defaults: DEFAULT_LASER_PARAMS,
    controlDefs: LASER_CONTROL_DEFS,
    build: buildLaserProfile,
    matches: isLaserProfile,
    Settings: LaserSettings,
  }),
];

const BY_ID = Object.fromEntries(FIXTURE_KINDS.map((kind) => [kind.id, kind]));

/**
 * The kind with this id, or null.
 *
 * @public
 * @param {String} id one of {@link GENERIC_KINDS}
 * @returns {FixtureKind|null}
 */
export function kindById(id) {
  return BY_ID[id] || null;
}

/**
 * The kind that made a profile, or null for a library profile.
 *
 * @public
 * @param {Object} profile
 * @returns {FixtureKind|null}
 */
export function kindOf(profile) {
  if (!profile) return null;
  return FIXTURE_KINDS.find((kind) => kind.isProfile(profile)) || null;
}

/**
 * The icon that stands for a fixture in a list or a widget header.
 *
 * One answer for the patch bay and the widget above it, because an icon that
 * disagrees between the two reads as two different fixtures. A library fixture
 * -- anything no kind here made -- is a moving head, which is what the shipped
 * library mostly holds.
 *
 * @public
 * @param {Object} fixture
 * @returns {String} an icon name from the uikit set
 */
export function fixtureIcon(fixture) {
  const kind = fixture ? kindOf(fixture.OFLData) : null;
  return kind ? kind.icon : 'movinghead';
}

export default FIXTURE_KINDS;
