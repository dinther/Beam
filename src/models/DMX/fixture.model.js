import { markRaw } from 'vue';
import {
  Proxify,
} from '../utils/proxify.utils';
import Channel from './channel.model';
import BarChannels from './bar_channels';
import PatchSingleton, { DMX_UNIVERSE_LENGTH, channelAddress } from './patch.model';
import Light from '../../plugins/visualizer/light';
import MovingHead from '../../plugins/visualizer/moving_head';
import LedBar from '../../plugins/visualizer/led_bar';
import Projector from '../../plugins/visualizer/projector';
import Display from '../../plugins/visualizer/display';
import VideoRouter from '../../plugins/visualizer/video_router';
import Laser from '../../plugins/visualizer/laser';
import { buildLaserProfile } from './generic/laser';
import { laserParams } from './gdtf/laser_parts';
import Strobe from '../../plugins/visualizer/strobe';
import { kindOf } from './generic/fixture_kind';
import withBeamSection from './generic/beam_section';
import Controls from '../../plugins/visualizer/controls';
import withTransform from './scene_item.transform';
import { SCENE_ITEM_KINDS } from './scene_item';
import { itemLabel, splitSavedName } from './item_naming';
import ViewFilter from './view_filter';
import { formatAddress } from './address_format';
import translateOfl from './gdtf/ofl_to_gdtf';
import DmxEngine from './gdtf/dmx_engine';
import HeadDispatch from './gdtf/head_dispatch';
import {
  channelRows, fixtureCategory, headInputs, wheelsForHead,
} from './gdtf/fixture_parts';
import { normaliseOverwrites, applyOverwrites, resolveImage } from './wheel_overwrites';
import GOBOS from '../../plugins/visualizer/gobo_manifest';
import GDTF_GOBOS from '../../plugins/visualizer/gdtf_gobos';
import STOCK_DISCS, { ANIMATION_URL } from '../../plugins/visualizer/stock_discs';
import UserGobos from '../../plugins/visualizer/user_gobos';
import { goboThumbnail, GOBO_URL } from '../../plugins/visualizer/gobo_pick';

/**
 * OFL profiles translated into the GDTF model, by profile key. A definition
 * is never edited, so one translation serves every fixture of it.
 */
const translations = new Map();

/** An OFL profile in the GDTF model, translated once per key. */
function translated(key, profile) {
  const cached = translations.get(key);
  if (cached && cached.source === profile.name) return cached.type;
  const { fixtureType } = translateOfl(profile);
  translations.set(key, { source: profile.name, type: fixtureType });
  return fixtureType;
}

/**
 * A GDTF channel's role, as the MadMapper export reads roles: a colour, pan,
 * tilt, intensity, or something else.
 */
function roleOf(attribute, label) {
  if (/^Color(Add|Sub)_/.test(attribute)) return { type: 'ColorIntensity', color: label };
  if (attribute === 'Pan') return { type: 'Pan' };
  if (attribute === 'Tilt') return { type: 'Tilt' };
  if (attribute === 'Dimmer') return { type: 'Intensity' };
  return { type: 'Generic' };
}

/**
 * What a GDTF fixture's listings and exports read: its name, its modes as
 * lists of channel names, so channel counts agree with the patch, and each
 * channel's role and fine byte, for the MadMapper export. Nothing here drives
 * the fixture.
 */
function listingFor(type) {
  // A laser is listed as Beam's own laser, its parameters read from the file,
  // so the laser renderer and its settings take it as they take one made here.
  const laser = laserParams(type);
  if (laser) {
    const colour = type.laserBody && type.laserBody.colour;
    return {
      ...buildLaserProfile(colour ? { ...laser, bodyColor: colour } : laser),
      name: type.name,
      categories: ['Laser'],
    };
  }
  const availableChannels = {};
  const modes = type.modes.map((mode) => {
    const rows = channelRows(new DmxEngine(type, mode));
    rows.forEach((row) => {
      if (row.isFine || !row.engineChannel || availableChannels[row.name]) return;
      const label = row.name.slice(row.engineChannel.instanceOf
        ? row.engineChannel.instanceOf.length + 1 : 0);
      availableChannels[row.name] = {
        fineChannelAliases: row.fineChannels.map((fine) => fine.name),
        capability: roleOf(row.attribute, label),
      };
    });
    return { name: mode.name, channels: rows.map((row) => row.name) };
  });
  return {
    name: type.name,
    categories: [fixtureCategory(type)],
    modes,
    availableChannels,
    wheels: {},
    physical: {},
  };
}

/**
 * Splitting pattern for parsing fine channels
 *
 * @constant
 * @type {String}
 * @default
 */
const FINE_CHANNEL_SPLIT_PATERN = ' fine';

/**
 * Fine channel terminology to be used for fine channel detection
 *
 * @constant
 * @type {String}
 * @default
 */
const FINE_CHANNEL_TERMINOLOGY = 'Fine';

/**
 * OFL Fixture category definitions for parsing fixture type
 *
 * @constant
 * @type {Object}
 * @default
 */
const FIXTURE_TYPES = {
  MOVING_HEAD: 'Moving Head',
  // A light that neither pans nor tilts; drawn by the moving head's renderer
  // standing still.
  STATIC: 'Static',
};

/** Categories the moving head's renderer draws. */
const HEAD_CATEGORIES = [FIXTURE_TYPES.MOVING_HEAD, FIXTURE_TYPES.STATIC];

/** Fallback bulb colour temperature, for profiles that omit one. */
const DEFAULT_COLOR_TEMP = 8000;

/**
 * The distances a hand-focused lens is set to, in metres: where a new one
 * starts, and the range it takes. The nearest is the lens's nearest focus;
 * at the farthest the blur is under a hundredth of a pool at any throw, which
 * is infinity in all but name.
 *
 * @constant {Number}
 */
const DEFAULT_FOCUS_DISTANCE = 5;
const FOCUS_DISTANCE_MIN = 2.5;
const FOCUS_DISTANCE_MAX = 100;

/**
 * A hand-focused lens's distance, held to the range.
 *
 * @param {*} metres
 * @returns {Number}
 */
function focusDistanceOf(metres) {
  const value = Number(metres);
  if (!Number.isFinite(value)) return FOCUS_DISTANCE_MAX;
  return Math.min(Math.max(value, FOCUS_DISTANCE_MIN), FOCUS_DISTANCE_MAX);
}

/**
 * The distance a show saved as a percentage meant: 0 the nearest focus to
 * 100 infinity, evenly in 1 / distance, as a focus channel runs.
 *
 * @param {Number} percent
 * @returns {Number} metres
 */
function focusDistanceFromPercent(percent) {
  const share = Math.min(Math.max(Number(percent) || 0, 0), 100) / 100;
  return focusDistanceOf(share >= 1 ? Infinity : FOCUS_DISTANCE_MIN / (1 - share));
}

/**
 * Stand-in for a fixture the renderer has no model for.
 *
 * Such a fixture still patches, addresses and holds channel values -- it simply
 * draws nothing. Throwing instead would make patching any of the 360
 * non-moving-head profiles in the library break the app rather than show an
 * unlit fixture.
 *
 * @returns {Object} an inert 3D model accepting the same writes
 */
function unsupportedModel() {
  return {
    unsupported: true,
    colorPreset: null,
    colorIntensity: null,
    colorWheelSlot: 0,
    goboWheelSlot: 0,
    intensity: 0,
    pan: 0,
    tilt: 0,
    panFine: 0,
    tiltFine: 0,
    shutter: 1,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
  };
}

/**
 * Default fixture name
 *
 * @constant
 * @type {Object}
 * @default
 */
const DEFAULT_FIXTURE_NAME = 'Unknown Fixture';

const RGB_CHANNELS = ['Red', 'Green', 'Blue'];
const CMY_CHANNELS = ['Cyan', 'Magenta', 'Yellow'];

/**
 * Default fixture constructor data
 *
 * @constant
 * @type {Object}
 * @default
 */
const DEFAULT_FIXTURE_DATA = {
  OFLData: undefined,
  manufacturer: undefined,
  model: undefined,
  modeName: undefined,
  id: 0,
  chStart: 0,
  universe: 0,
  position: {
    x: 0,
    y: 0,
    z: 0,
  },
  rotation: {
    x: 0,
    y: 0,
    z: 0,
  },
};

/**
 * @class
 * @classdesc Definition of a DMX512 Fixture model
 */
class Fixture extends withTransform(Proxify) {
  /**
   * @param {Object} data Fixture initialisation data
   * @param {Object} data.OFLData OFL Object fixture configuration
   * @param {Object} data.id Fixture's unique identifier
   * @param {Object} data.universe Fixture's DMX512 Universe
   * @param {Object} data.manufacturer Fixture manufacturer name as described in fixture_list.json
   * @param {Object} data.model Manufacturer's fixture model name as described in fixture_list.json
   * @param {Object} data.modeName Mode name of the fixture's selected running mode
   * @param {Object} data.wheels Fixture's wheels data
   * @param {Object} data.category Fixture category as parsed from OFL data
   * @param {Object} data.chStart FIxture's universe address/starting channel
   * @param {Object} data.position Fixture's position in 3D space
   * @param {Object} data.OFLData Fixture's rotation in 3D space
   */
  constructor(data = DEFAULT_FIXTURE_DATA) {
    super();
    /** What this is, for everything that treats scene items alike. */
    // Kind and uid together: both are the scene-item identity, and every kind
    // stamps it the same way. See scene_item.js.
    this.initSceneItem(SCENE_ITEM_KINDS.FIXTURE);
    if (!data.isStub) {
      /**
       * The fixture's GDTF fixture type, when it comes from a .gdtf: read
       * once by the show and shared by every fixture of that type.
       */
      this.fixtureType = data.fixtureType ? markRaw(data.fixtureType) : null;
      this.OFLData = withBeamSection(data.OFLData)
        || (this.fixtureType ? listingFor(this.fixtureType) : null);
      this.id = parseInt(data.id, 10);
      // Read before the address: patching lays the channels out according to
      // this, so it has to be known by the time the address is claimed.
      //
      // Whether pixels are kept whole is a property of the model, not of one
      // patch of it -- the same strip behaves the same wherever it is
      // addressed -- so an instance that says nothing inherits the profile's
      // answer, and only an explicit value overrides it.
      this._universeAligned = data.universeAligned === undefined
        ? Fixture.profileKeepsPixelsWhole(this.OFLData)
        : !!data.universeAligned;
      // One absolute address is the truth; universe and chStart are views of
      // it. Older shows carry the pair instead, so accept either.
      if (data.address !== undefined) {
        this.address = parseInt(data.address, 10);
      } else {
        this.address = (parseInt(data.universe, 10) || 0) * DMX_UNIVERSE_LENGTH
          + (parseInt(data.chStart, 10) || 0);
      }
      this.manufacturer = data.manufacturer;
      this.model = data.model;
      this.modeName = data.mode;
      this.wheels = {};
      this.name = data.name || DEFAULT_FIXTURE_NAME;
      /**
       * Beam's number for this item among others of its kind with the same
       * name; see item_naming.js. Given when the item joins the show.
       */
      this.instance = Number.isInteger(data.instance) ? data.instance : null;
      if (this.instance === null) {
        // Saved before instances existed: the number was part of the name.
        const split = splitSavedName(this.name, [data.baseName, data.model]);
        this.name = split.name;
        this.instance = split.instance;
      }
      this.category = data.category;
      this.channels = [];
      this.quickChannelsAccessors = {};
      this._3DModel = null;
      /** Owning group, or null when the fixture sits at the root. */
      this.group = null;
      /**
       * Owning structure, or null when the fixture is a scene item in its own
       * right. A fixture inside one still holds absolute coordinates -- the
       * structure writes them -- but they are the structure's to set.
       */
      this.structure = null;
      /**
       * Gobos and discs swapped into this placement's wheels; see
       * wheel_overwrites.js. The definition's own wheels stay as they are.
       */
      this._overwrites = normaliseOverwrites(data.overwrites);
      /** Where a hand-set lens is focused: see `focusDistance`. */
      this._focusDistance = DEFAULT_FOCUS_DISTANCE;
      if (data.focusDistance != null && Number.isFinite(Number(data.focusDistance))) {
        this._focusDistance = focusDistanceOf(data.focusDistance);
      } else if (data.focus != null && Number.isFinite(Number(data.focus))) {
        this._focusDistance = focusDistanceFromPercent(data.focus);
      }
      /** Hidden from the scene: see `hidden`. */
      this._hidden = !!data.hidden;
      /**
       * What this device is set to, or null for a fixture that is neither a
       * projector nor a display.
       *
       * On the placement rather than the profile: the profile says what the
       * model can do, this says where inside that it is set. Built before the
       * channels are, because `setChannel` routes into it.
       *
       * `deviceKind` rather than an `instanceof`, because the panel and the
       * renderer both ask which kind this is and a string travels.
       */
      this.device = null;
      this.deviceKind = null;
      /**
       * Channel values set by hand, by index.
       *
       * A library fixture has no `device`, and its channels carry what DMX
       * last said, which is not saved -- so without these a light placed to
       * try an idea is dark until it is patched and a console is talking to
       * it. These are what it shows until DMX does -- and only these travel in
       * the show, never what the wire
       * happens to be saying, which is the line the app already draws for the
       * generic devices.
       *
       * Sparse on purpose: a channel nobody has touched is absent rather than
       * zero, so a profile default is not silently overwritten by one.
       */
      this._parkedChannels = { ...(data.channelValues || {}) };
      // Read from `device`, falling back to `projector`, the key older shows
      // store a projector's settings under -- without it they load with every
      // projector's zoom and source lost.
      const deviceData = data.device || data.projector;
      // The kind that made the profile says which Settings hold its
      // parameters; a library profile was made by none and has no device.
      const kind = kindOf(this.OFLData);
      if (kind && kind.hasDevice) {
        this.device = kind.settingsFor(this.OFLData, deviceData);
        this.deviceKind = kind.id;
      }
      /** Transform relative to that group or structure, held by the owner. */
      this.localTransform = null;
      this._rotation = {
        x: 0,
        y: 0,
        z: 0,
      };
      this._position = data.position || {
        x: 0,
        y: 0,
        z: 0,
      };
      this.position = data.position || {
        x: this.id,
        y: this.universe,
        z: 10,
      };
      this.rotation = data.rotation || {
        x: 180,
        y: 0,
        z: 0,
      };
      this.parseFromOFLData();
      if (this.channels instanceof BarChannels) {
        this.channels.fill(0);
      } else {
        this.channels.forEach((channel) => {
          // A device's values are already restored from the show; writing
          // zeros through it would put every driven one back at level 0.
          if (this.device) channel.value = 0; // eslint-disable-line no-param-reassign
          else this.setChannel(channel.id - 1, 0);
        });
      }
      // After the zeroing, or a saved value would be wiped by it.
      this.applyParkedChannels();
      // A device's held bytes went through it too; its saved values, which
      // a hand may have set after them, are the last word.
      if (this.device) this.device.restore(deviceData);
      // A channel left at its default is never reported by a write, so the
      // head hears every channel once.
      if (this._dispatch) this._dispatch.applyAll();
    }
    return this.proxify(['_3DModel']);
  }

  /** *******************************************
   * DESCRIPTION MODIFIERS                     *
   ******************************************** */

  set model(model) {
    this._model = model?.replace('.json', '');
  }

  get model() {
    return this._model;
  }

  /**
   * Whether this fixture is an emitter bar rather than a head.
   *
   * Asked of the generated profile that carries the emitter geometry, the same
   * test `prepare3DModelInstance` makes -- a category string like 'Matrix'
   * says nothing about where the emitters actually are.
   *
   * @readonly
   * @type {Boolean}
   */
  get isBar() {
    return !!(this.OFLData && this.OFLData.beam && this.OFLData.beam.bar);
  }

  /**
   * How the fixture is shown and exported: its name and instance, `name N`.
   *
   * @readonly
   * @type {String}
   */
  get label() {
    return itemLabel(this.name, this.instance);
  }

  get listable() {
    return {
      name: this.label,
      icon: this.isBar ? 'ledbar' : 'movinghead',
      id: this.id,
      universe: this.universe,
      more: this.address > -1 ? formatAddress(this.address) : 'unpatched',
    };
  }

  /**
   * Fixture's exportable show data chunk
   *
   * @readonly
   * @type {Object}
   */
  get showData() {
    return {
      id: this.id,
      model: this.model,
      category: this.category,
      manufacturer: this.manufacturer,
      name: this.name,
      instance: this.instance || undefined,
      address: this.address,
      universeAligned: this.universeAligned,
      universe: this.universe,
      chStart: this.chStart,
      // modeName, not modeNam: the typo meant every save wrote an undefined
      // mode and every load fell back to the profile's first one.
      mode: this.modeName,
      position: this.position,
      rotation: this.rotation,
      groupId: this.group ? this.group.id : undefined,
      structureId: this.structure ? this.structure.id : undefined,
      focusDistance: this.hasManualFocus ? this._focusDistance : undefined,
      overwrites: this._overwrites && this._overwrites.length
        ? this._overwrites.map((o) => ({ ...o })) : undefined,
      hidden: this._hidden || undefined,
      // Only the parked values, never what DMX happens to be saying -- the
      // same line the app already draws between an address and the wire.
      device: this.device ? this.device.showData : undefined,
      channelValues: Object.keys(this._parkedChannels || {}).length
        ? { ...this._parkedChannels } : undefined,
    };
  }

  /**
   * A coordinate the renderer can actually use, or the one already held.
   *
   * @static
   * @param {*} value candidate coordinate
   * @param {Number} fallback value to keep when the candidate is unusable
   * @return {Number} a finite number
   */
  static usableCoordinate(value, fallback) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
    return Number.isFinite(fallback) ? fallback : 0;
  }

  /**
   * Fixture's position in 3D space (meter)
   *
   * @type {Object}
   */
  /**
   * A fixture is drawn by its 3D model, so a changed transform has to reach it.
   *
   * Only the field that moved is pushed. Writing both on every keystroke would
   * re-assert a rotation the head may have animated away from since.
   *
   * @param {String} field `'_position'`, `'_rotation'`, or undefined for both
   */
  applyTransform(field) {
    if (!this._3DModel) return;
    if (field !== '_rotation') this._3DModel.position = this._position;
    if (field !== '_position') this._3DModel.rotation = this._rotation;
  }

  set position(positionData) {
    // A non-finite coordinate is not a position, it is a fixture that stops
    // being drawn: NaN reaches the renderer, poisons the world matrix, and the
    // fixture silently disappears while still sitting in the patch bay. Keeping
    // the last good value turns a lost fixture into a rejected keystroke.
    this._position = {
      x: Fixture.usableCoordinate(positionData.x, this._position.x),
      y: Fixture.usableCoordinate(positionData.y, this._position.y),
      z: Fixture.usableCoordinate(positionData.z, this._position.z), // Math.max(z, 0)
    };
    if (this._3DModel) {
      this._3DModel.position = this._position;
    }
  }

  get position() {
    return {
      x: this._position.x,
      y: this._position.y,
      z: this._position.z,
    };
  }

  /**
   * Fixture's rotation in 3D space (meter)
   *
   * @type {Object}
   */
  set rotation(rotationData) {
    // Same rule as position: a NaN angle blanks the fixture rather than
    // turning it. See usableCoordinate.
    this._rotation = {
      x: Fixture.degToRad(Fixture.usableCoordinate(rotationData.x, this.rotation.x)),
      y: Fixture.degToRad(Fixture.usableCoordinate(rotationData.y, this.rotation.y)),
      z: Fixture.degToRad(Fixture.usableCoordinate(rotationData.z, this.rotation.z)),
    };
    if (this._3DModel) {
      this._3DModel.rotation = this._rotation;
    }
  }

  get rotation() {
    return {
      x: Fixture.radToDeg(this._rotation.x),
      y: Fixture.radToDeg(this._rotation.y),
      z: Fixture.radToDeg(this._rotation.z),
    };
  }

  /** *******************************************************************
   * CHANNELS MODIFIERS                                                *
   * TODO: remove unused content following quickChannelAccessor update *
   ******************************************************************** */

  /**
   * Fixture's mode index for channel setting/parsing mode
   *
   * @type {Number}
   */
  set modeIndex(modeIndex) {
    this.channels = [];
    this.quickChannelsAccessors = {};
    this.modeName = this.modeNames[modeIndex];
    if (this.fixtureType && !this.isGdtfLaser) {
      const inputs = this.applyGdtfMode();
      if (this._dispatch) {
        // A static light's lenses are its mode's: built again for this one.
        if (this._lightSpec) {
          this.createLamps({ ...this._lightSpec, lumens: inputs.lumens }, this.fixtureType.body);
        }
        this._3DModel.setModeInputs({
          maxPan: inputs.panSpan,
          maxTilt: inputs.tiltSpan,
          minAngle: inputs.minAngle,
          maxAngle: inputs.maxAngle,
          edgePenumbra: inputs.edgePenumbra,
          lumens: inputs.lumens,
        });
        this._dispatch = this.dispatchFor();
      }
    } else {
      this.prepareChannels();
      this.setupFineChannels();
      this.setupQuickAccessors();
      // A moving head reads DMX through the new mode's translation; the
      // lens is the profile's whatever the mode.
      if (this._engine) {
        const type = translated(this.profileKey, this.OFLData);
        const mode = type.modes[this.modeIndex] || type.modes[0];
        const inputs = headInputs(type, mode);
        this._3DModel.setModeInputs({ maxPan: inputs.panSpan, maxTilt: inputs.tiltSpan });
        this._engine = markRaw(new DmxEngine(type, mode));
        this._dispatch = this.dispatchFor();
      }
    }
    // As a new fixture starts: every channel at nought, then what was set
    // by hand, then every channel told to the head, which the mode change
    // has put back to how a new head starts.
    if (this.hasManualFocus && this._3DModel) this._3DModel.focusDistance = this._focusDistance;
    this.channels.forEach((channel) => {
      this.setChannel(channel.id - 1, 0);
    });
    this.applyParkedChannels();
    if (this._dispatch) this._dispatch.applyAll();
  }

  get modeIndex() {
    // The patch dialog chooses a mode by its place in the list.
    if (Number.isInteger(this.modeName)) {
      return this.modeName >= 0 && this.modeName < this.modeNames.length ? this.modeName : 0;
    }
    const modeIndex = this.modeNames.indexOf(this.modeName);
    return modeIndex > -1 ? modeIndex : 0;
  }

  /**
   * Simplified channel object. does not contain capability(ies) data
   *
   * @type {Object}
   */
  set simplifiedChannels(channels) {
    channels.forEach((channel, index) => {
      this.setChannel(index, channel.value);
    });
  }

  get simplifiedChannels() {
    return this.channels.map((channel) => ({
      color: channel.color,
      type: channel.type,
      id: channel.id + this.chStart,
      value: channel.value.DMX,
      active: channel.active,
      qaIndex: channel.qaIndex,
    }));
  }

  /**
   * Fixture's pan&tilt channels values (0-255)/(0-255)
   *
   * @type {Number}
   */
  set panTilt(value) {
    this.setQuickAccessor({
      type: 'Pan',
    }, value.pan);
    this.setQuickAccessor({
      type: 'Tilt',
    }, value.tilt);
    this.setQuickAccessor({
      type: 'PanFine',
    }, value.panFine);
    this.setQuickAccessor({
      type: 'TiltFine',
    }, value.tiltFine);
  }

  get panTilt() {
    return {
      pan: this.hasQuickAccessor({
        type: 'Pan',
      }) ? this.getQuickAccessor({
          type: 'Pan',
        }).value.DMX : 0,
      panFine: this.hasQuickAccessor({
        type: 'PanFine',
      }) ? this.getQuickAccessor({
          type: 'PanFine',
        }).value.DMX : 0,
      tilt: this.hasQuickAccessor({
        type: 'Tilt',
      }) ? this.getQuickAccessor({
          type: 'Tilt',
        }).value.DMX : 0,
      tiltFine: this.hasQuickAccessor({
        type: 'TiltFine',
      }) ? this.getQuickAccessor({
          type: 'TiltFine',
        }).value.DMX : 0,
    };
  }

  /**
   * Fixture's color channels values.
   * Only RGB color suppoprtded at the moment.
   * @todo Implement other color changer types (HSB...). Should do for the alpha
   * @todo, this causes massive slowdowns, this should be refactpred and optimized
   * @type {Number}
   */
  set color(rgbValue) {
    if (this.hasColor) {
      this.quickChannelsAccessors.Color.forEach((channel) => {
        if (RGB_CHANNELS.includes(channel.color)) {
          const value = rgbValue[RGB_CHANNELS.indexOf(channel.color)];
          this.setChannel(channel.id - 1, value);
        } else if (CMY_CHANNELS.includes(channel.color)) {
          const value = 255 - rgbValue[CMY_CHANNELS.indexOf(channel.color)];
          this.setChannel(channel.id - 1, value);
        }
      });
    }
  }

  get color() {
    const colorValues = [0, 0, 0];
    if (this.hasColor) {
      this.quickChannelsAccessors.Color.forEach((colorChannel) => {
        if (RGB_CHANNELS.includes(colorChannel.color)) {
          colorValues[RGB_CHANNELS.indexOf(colorChannel.color)] = colorChannel.value.DMX;
        } else if (CMY_CHANNELS.includes(colorChannel.color)) {
          colorValues[CMY_CHANNELS.indexOf(colorChannel.color)] = 255 - colorChannel.value.DMX;
        }
      });
    }
    return colorValues;
  }

  /**
   * List of fixture's mode names
   *
   * @type {Array<String>}
   * @readonly
   */
  get modeNames() {
    return this.modes.map((mode) => mode.name);
  }

  /**
   * Whether the fixture has dimmer capabilities or not
   *
   * @type {Object}
   * @readonly
   */
  get hasDimmer() {
    return this.quickChannelsAccessors.Dimmer !== undefined;
  }

  /**
   * Whether the fixture has zoom capabilities or not
   *
   * @type {Object}
   * @readonly
   */
  get hasZoom() {
    return this.quickChannelsAccessors.Zoom !== undefined;
  }

  /**
   * Whether the fixture has pan capabilities or not
   *
   * @type {Object}
   * @readonly
   */
  get hasPan() {
    return this.quickChannelsAccessors.Pan !== undefined;
  }

  /**
   * Whether the fixture has tilt capabilities or not
   *
   * @type {Object}
   * @readonly
   */
  get hasTilt() {
    return this.quickChannelsAccessors.Tilt !== undefined;
  }

  /**
   * Whether the fixture has color capabilities or not
   *
   * @type {Object}
   * @readonly
   */
  get hasColor() {
    return this.quickChannelsAccessors.Color !== undefined;
  }

  /**
   * The fixture's stop address as defined by it's universe configuration
   *
   * @type {Number}
   * @readonly
   */
  /**
   * The fixture's absolute DMX address: a single channel offset into the
   * show's whole address space, not a channel within a universe.
   *
   * @type {Number}
   */
  set address(value) {
    const parsed = parseInt(value, 10);
    const next = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    if (this._address === next) return;

    // A patched fixture's claim on the address space is keyed by its address,
    // so moving one without re-patching leaves inbound frames feeding the
    // channels it used to occupy.
    if (!PatchSingleton.isPatched(this)) {
      this._address = next;
      this.notifyRepatched();
      return;
    }
    const previous = this._address;
    PatchSingleton.unpatchFixture(this);
    this._address = next;
    try {
      PatchSingleton.patchFixture(this);
      this.notifyRepatched();
    } catch (err) {
      // Something already holds the requested range: stay put.
      this._address = previous;
      PatchSingleton.patchFixture(this);
      this.notifyRepatched();
    }
  }

  get address() {
    return this._address || 0;
  }

  /**
   * Whether the fixture keeps its pixels whole within a universe.
   *
   * Only meaningful for a fixture long enough to cross a boundary. Changing it
   * re-lays the channels, so a patched fixture has to be re-patched.
   *
   * @type {Boolean}
   */
  /**
   * Channels one pixel of this fixture occupies.
   *
   * A generated bar says so directly. Anything else is a single pixel as far
   * as this is concerned -- which is also how MadMapper describes a mover: one
   * pixel, one by one, as many channels wide as the mode is.
   *
   * @readonly
   * @type {Number}
   */
  get channelsPerPixel() {
    const { components } = this.OFLData.beam || {};
    if (components && components.length) return components.length;
    return this.channels.length || 1;
  }

  /**
   * Pixel size to lay this fixture's channels out with.
   *
   * One means channels run on across universe boundaries, which is what a
   * fixture that does not care looks like to `channelAddress`.
   *
   * @readonly
   * @type {Number}
   */
  get alignmentPixelSize() {
    return this.universeAligned ? this.channelsPerPixel : 1;
  }

  set universeAligned(value) {
    const next = !!value;
    if (this._universeAligned === next) return;
    if (!PatchSingleton.isPatched(this)) {
      this._universeAligned = next;
      return;
    }
    PatchSingleton.unpatchFixture(this);
    this._universeAligned = next;
    try {
      PatchSingleton.patchFixture(this);
      this.notifyRepatched();
    } catch (err) {
      // The new layout collides with something: keep the old one.
      this._universeAligned = !next;
      PatchSingleton.patchFixture(this);
      this.notifyRepatched();
    }
  }

  get universeAligned() {
    return !!this._universeAligned;
  }

  /**
   * Key this fixture's profile is stored under.
   *
   * @readonly
   * @type {String}
   */
  get profileKey() {
    return `${this.manufacturer}/${this.model}`;
  }

  /**
   * How tall the real fixture is, in metres, or null when the profile does not
   * say. OFL keeps dimensions as width, height and depth in millimetres.
   *
   * @readonly
   * @type {Number|null}
   */
  get bodyHeight() {
    const { dimensions } = (this.OFLData || {}).physical || {};
    const height = Array.isArray(dimensions) ? Number(dimensions[1]) : NaN;
    return height > 0 ? height / 1000 : null;
  }

  /**
   * Absolute address of one of the fixture's channels.
   *
   * @public
   * @param {Number} index channel index within the fixture
   * @return {Number} absolute address
   */
  addressOf(index) {
    return channelAddress(this.address, index, this.alignmentPixelSize);
  }

  /**
   * Absolute address one past the fixture's last channel.
   *
   * @readonly
   * @type {Number}
   */
  get addressStop() {
    if (!this.channels.length) return this.address;
    return this.addressOf(this.channels.length - 1) + 1;
  }

  /**
   * Which universe the fixture's first channel falls in. Derived: a fixture is
   * not owned by a universe, and its channels may run on into the next one.
   *
   * @type {Number}
   */
  set universe(value) {
    const parsed = parseInt(value, 10);
    const universe = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    this.address = universe * DMX_UNIVERSE_LENGTH + this.chStart;
  }

  get universe() {
    return Math.floor(this.address / DMX_UNIVERSE_LENGTH);
  }

  /**
   * The fixture's start channel within its first universe.
   *
   * @type {Number}
   */
  set chStart(value) {
    const parsed = parseInt(value, 10);
    const chStart = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    this.address = this.universe * DMX_UNIVERSE_LENGTH + chStart;
  }

  get chStart() {
    return this.address % DMX_UNIVERSE_LENGTH;
  }

  get chStop() {
    return this.chStart + this.channels.length;
  }

  get highlighted() {
    return this._3DModel.highlighted;
  }

  setQuickAccessor(channel, value) {
    if (this.hasQuickAccessor(channel)) {
      this.setChannel(this.getQuickAccessor(channel).id - 1, value);
    }
  }

  hasQuickAccessor(channel) {
    return this.quickChannelsAccessors[channel.type] !== undefined
      && this.quickChannelsAccessors[channel.type][channel.qaIndex || 0] !== undefined;
  }

  getQuickAccessor(channel) {
    if (this.hasQuickAccessor(channel)) {
      return this.quickChannelsAccessors[channel.type][channel.qaIndex || 0];
    }
    return null;
  }

  /**
   *
   * @param {Object} fixtureData
   * @todo check and remove this, it's not used anymore.
   */
  init(fixtureData) {
    this.parseFromOFLData(fixtureData);
  }

  /**
   * Whether this fixture can take a block of channels in one call.
   *
   * True only for a generated bar, whose channels are a byte range and whose
   * emitters read the DMX texture rather than these values. Anything else
   * means something per channel -- a capability lookup, a 3D model write --
   * and has to go through `setChannel` one at a time.
   *
   * @readonly
   * @type {Boolean}
   */
  get takesChannelRange() {
    return this.channels instanceof BarChannels;
  }

  /**
   * Writes a contiguous block of channels, when `takesChannelRange` allows it.
   *
   * An inbound universe is already bytes in channel order, so a bar takes it
   * as a memcpy. Falls back to one `setChannel` per byte otherwise, so callers
   * need not branch -- but a caller in a hot loop should check
   * `takesChannelRange` and keep its own diffing on the slow path.
   *
   * @param {Number} index 0-based channel index to start at
   * @param {Uint8Array} source bytes in channel order
   */
  setChannelRange(index, source) {
    if (this.channels instanceof BarChannels) {
      this.channels.setRange(index, source);
      return;
    }
    for (let i = 0; i < source.length; i += 1) this.setChannel(index + i, source[i]);
  }

  /**
   * The value a channel holds now, whoever wrote it last.
   *
   * @param {Number} index 0-based channel index
   * @returns {Number} 0-255
   */
  channelValue(index) {
    if (this.channels instanceof BarChannels) return this.channels.valueAt(index);
    const channel = this.channels && this.channels[index];
    return channel ? (Number(channel.value.DMX) || 0) : 0;
  }

  /**
   * Sets a channel by hand, and remembers it.
   *
   * The value takes effect at once and is written into the show. It is not
   * protected from DMX: a patched fixture whose console is talking will have
   * this overwritten on the next frame, which is the honest behaviour --
   * whoever is driving, drives. What this buys is a fixture that does
   * something *before* anyone is driving it, which is the whole point of
   * placing a light to see where it lands.
   *
   * @public
   * @param {Number} index 0-based channel index
   * @param {Number} value 0-255
   */
  parkChannel(index, value) {
    const clamped = Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
    this._parkedChannels[index] = clamped;
    this.setChannel(index, clamped);
  }

  /**
   * Forgets a hand-set channel, leaving whatever is driving it.
   *
   * @public
   * @param {Number} index
   */
  unparkChannel(index) {
    delete this._parkedChannels[index];
  }

  /**
   * The value set by hand for a channel, or undefined.
   *
   * @public
   * @param {Number} index
   * @returns {Number|undefined}
   */
  parkedChannel(index) {
    return this._parkedChannels[index];
  }

  /** @public @returns {Object} every hand-set channel, by index */
  get parkedChannels() {
    return { ...this._parkedChannels };
  }

  /**
   * Writes every remembered value into its channel.
   *
   * Called once the channels exist, and again after a repatch, since neither
   * rebuilds what a person set.
   *
   * @public
   */
  applyParkedChannels() {
    Object.entries(this._parkedChannels || {}).forEach(([index, value]) => {
      this.setChannel(Number(index), value);
    });
  }

  /**
   * Sets specified channel value for given fixture channel index.
   *
   * @param {Number} id fixture's channel index
   * @param {Number} value channel value (0-255)
   */
  /* eslint-disable max-len */
  setChannel(id, value) {
    // A bar's channel is a byte in a range. Everything below -- the fine
    // channel recursion, the capability lookup, the 3D model fan-out -- is
    // answering questions a bar has already answered in its geometry, and its
    // emitters read the DMX texture directly rather than these values.
    if (this.channels instanceof BarChannels) {
      this.channels.setValueAt(id, Math.ceil(Math.min(Math.max(value, 0), 255)));
      return;
    }

    // A projector's channels are routed by position rather than through the
    // capability fan-out below. Its attributes have no OFL vocabulary -- lens
    // shift is the clearest case, where `BeamPosition` would write `pan` *and*
    // `tilt` for a single axis and two shift channels would overwrite each
    // other. The order is the profile's own, so it survives a model gaining a
    // channel where a hard-coded offset would not.
    if (this.device) {
      const clamped = Math.ceil(Math.min(Math.max(value, 0), 255));
      if (this.channels[id]) this.channels[id].value = clamped;
      this.device.writeChannel(id, clamped);
      if (this._3DModel && this._3DModel.refresh) this._3DModel.refresh();
      return;
    }

    const clamped = Math.ceil(Math.min(Math.max(value, 0), 255));
    if (this.channels[id]) this.channels[id].value = clamped;
    // A moving head, from either kind of profile: the engine reads the byte in
    // GDTF terms and the dispatcher acts on what changed. Any other fixture
    // has no renderer yet and only keeps the value for the panels.
    if (this._engine) {
      const changed = this._engine.write(id, clamped);
      if (this._dispatch) this._dispatch.apply(changed);
    }
  }
  /* eslint-disable max-len */

  /**
   * Whether this is a laser read from a GDTF file. It keeps its fixture type,
   * for what the file says about it, and is drawn and driven as Beam's own
   * laser, from the parameters `listingFor` read out of the file.
   *
   * @readonly
   * @type {Boolean}
   */
  get isGdtfLaser() {
    return !!(this.fixtureType && this.OFLData && this.OFLData.beam && this.OFLData.beam.laser);
  }

  /**
   * Parses OFL data and rpepares fixture parameters and channels
   *
   * @public
   * @todo improve error handling.
   * @todo Implement other fixure categories
   */
  parseFromOFLData() {
    if (this.fixtureType && !this.isGdtfLaser) {
      this.parseFromGdtf();
      return;
    }
    // eslint-disable-next-line prefer-destructuring
    this.category = this.OFLData.categories[0]; // We're only interested in the first category asset ATM.
    // The profile's wheels, and the placement's with its swaps in them.
    this._definitionWheels = this.OFLData.wheels || {};
    this.wheels = this.overwrittenWheels();
    this.bulb = (this.OFLData.physical || {}).bulb; // Isolating and setting fixture's bulb configuration from OFL data
    this._name = this.OFLData.name; // Isolating and setting fixture's default name from OFL data
    this.modes = this.OFLData.modes; // Isolating and setting fixture's modes configuration from OFL data
    this.prepareChannels(); // Prepare fixture's channels
    this.setupFineChannels();
    this.setupQuickAccessors();
    this.prepare3DModelInstance();
    this.applyHidden();
  }

  /**
   * Tells the renderer its addressing moved. Only emitter arrays care: they
   * read the DMX texture directly, so every emitter's texel index shifts with
   * the fixture's address.
   *
   * @public
   */
  /**
   * Builds the fixture from its GDTF fixture type: one channel row per
   * address the mode occupies, read by the DMX engine, and a moving head
   * driven through the dispatcher.
   *
   * @public
   */
  parseFromGdtf() {
    const type = this.fixtureType;
    this.modes = type.modes;
    this._name = type.name;
    const inputs = this.applyGdtfMode();
    this.category = inputs.category;
    this._definitionWheels = wheelsForHead(type);
    this.wheels = this.overwrittenWheels();
    if (HEAD_CATEGORIES.includes(inputs.category)) {
      const moving = inputs.category === FIXTURE_TYPES.MOVING_HEAD;
      const spec = {
        minAngle: inputs.minAngle || 10,
        maxAngle: inputs.maxAngle || 25,
        edgePenumbra: inputs.edgePenumbra,
        minTilt: 0,
        maxTilt: inputs.tiltSpan || 0,
        minPan: 0,
        maxPan: inputs.panSpan || 0,
        colorTemp: inputs.colorTemp || DEFAULT_COLOR_TEMP,
        lumens: inputs.lumens,
        bodyHeight: inputs.bodyHeight,
        wheels: this.wheels,
        // Null where the file has no RealFade; the head then uses its own.
        panSpeed: inputs.panSpeed,
        tiltSpeed: inputs.tiltSpeed,
        // The file's own body, read when the type was loaded; the shipped
        // one where a moving head's file has no meshes.
        body: type.body || null,
        // The lens the file states, which the shipped body draws and the
        // lens's blur is measured in; null where the file leaves the
        // spec's default, so the shipped lens scales with the body.
        lensRadius: inputs.beam && inputs.beam.explicit.includes('BeamRadius')
          ? inputs.beam.beamRadius : null,
      };
      this.createLight(spec, moving);
      this._lightSpec = moving ? null : spec;
      if (!moving) this.createLamps(spec, type.body);
      this._dispatch = this.dispatchFor();
    } else {
      // No renderer for this type yet: patch it, address it, draw nothing.
      this._3DModel = markRaw(unsupportedModel());
    }
    this.applyHidden();
  }

  /**
   * Sets up the current mode of a GDTF fixture: its channel rows and the
   * engine that reads them.
   *
   * @private
   * @returns {Object} the head's inputs in this mode; see `headInputs`
   */
  applyGdtfMode() {
    const type = this.fixtureType;
    this.mode = type.modes[this.modeIndex] || type.modes[0];
    // Kept by name from here on, which is what the show saves.
    this.modeName = this.mode.name;
    // Kept out of Vue's reactivity: it is written on every DMX packet.
    this._engine = markRaw(new DmxEngine(type, this.mode));
    this.channels = channelRows(this._engine);
    this.setupQuickAccessors();
    return headInputs(type, this.mode);
  }

  /**
   * Builds the light, from either kind of profile: a moving head, or a light
   * that stands still.
   *
   * @public
   * @param {Object} spec angles, output, wheels and body, and a moving
   *   head's travel and speeds
   * @param {Boolean} moving whether it pans and tilts
   */
  createLight(spec, moving) {
    const data = {
      ...spec,
      colorWheel: spec.wheels && spec.wheels['Color Wheel'] ? spec.wheels['Color Wheel'].slots : [],
      intensity: 0.0,
    };
    const light = moving
      ? new MovingHead({
        ...data,
        // At the centre of its travel, where the yoke and head are not turned.
        pan: (spec.maxPan || 0) / 2,
        tilt: (spec.maxTilt || 0) / 2,
      })
      : new Light(data);
    light.position = this._position;
    light.rotation = this._rotation;
    // Kept out of Vue's reactivity: three.js cannot be handed an Object3D
    // reached through a reactive proxy.
    this._3DModel = markRaw(light);
    // Reverse link, so a ray hitting the 3D model can name its fixture.
    light.fixtureHandle = this;
    if (this.hasManualFocus) light.focusDistance = this._focusDistance;
  }

  /**
   * A light for each further lens of a static light in its mode: lamps, hung
   * from the first, each lit with its own beam's share of the fixture's
   * output. The lenses are those of the geometry the mode names, the first
   * light's lens moved to the first of them. A fixture with one lens has
   * none.
   *
   * @public
   * @param {Object} spec what the first light was built from
   * @param {Object|null} body the fixture type's body
   */
  createLamps(spec, body) {
    const first = this._3DModel;
    first.removeLamps();
    this._lenses = null;
    const sets = (body && body.lensSets) || {};
    const lenses = sets[this.mode && this.mode.geometry] || (body && body.lenses) || [];
    // A beam the file types None or Glow draws no beam; its geometry glows.
    const glows = (lens) => ['None', 'Glow'].includes(lens.beam && lens.beam.beamType);
    if (lenses.length) {
      first.placeLens(lenses[0]);
      first.glow = glows(lenses[0]);
    }
    if (lenses.length < 2) {
      first.share = 1;
      return;
    }
    const flux = lenses.map((lens) => Number(lens.beam && lens.beam.luminousFlux) || 0);
    const total = flux.reduce((sum, f) => sum + f, 0);
    const shareOf = (i) => (total > 0 ? flux[i] / total : 1 / lenses.length);
    first.share = shareOf(0);
    this._lenses = [{ head: first, path: lenses[0].path }];
    lenses.slice(1).forEach((lens, k) => {
      const lamp = new Light({
        ...spec,
        colorWheel: spec.wheels && spec.wheels['Color Wheel'] ? spec.wheels['Color Wheel'].slots : [],
        intensity: 0.0,
        body: null,
        bodyHeight: null,
        lamp: true,
        lens: { frame: lens.frame, radius: lens.radius, face: lens.face },
        share: shareOf(k + 1),
        lumens: spec.lumens * shareOf(k + 1),
        glow: glows(lens),
      });
      lamp.fixtureHandle = this;
      first.attachLamp(markRaw(lamp));
      this._lenses.push({ head: lamp, path: lens.path });
    });
  }

  /**
   * The dispatch that drives this fixture's light from its engine, through
   * every lens it has.
   *
   * @private
   * @returns {HeadDispatch}
   */
  dispatchFor() {
    return markRaw(new HeadDispatch(this._3DModel, this._engine, this._lenses || null));
  }

  /**
   * What a GDTF fixture's panels read until they read the GDTF model; see
   * `listingFor`.
   *
   * @public
   * @param {Object} type a GDTF fixture type
   * @returns {Object}
   */
  static gdtfListing(type) {
    return listingFor(type);
  }

  notifyRepatched() {
    if (this._3DModel && this._3DModel.repatch) this._3DModel.repatch();
  }

  /**
   * Absolute texel indices one pixel's components read from.
   *
   * An address in this show is already `universe * 512 + channel`, which is
   * exactly how the DMX texture is laid out, so `addressOf` doubles as the
   * texel index -- and it applies the skip-511-512 rule for free.
   *
   * @public
   * @param {Number} pixel position in the chain, 0-based
   * @returns {Array} [r, g, b, w], -1 for a component this fixture lacks
   */
  pixelTexels(pixel) {
    const components = (this.OFLData.beam || {}).components || [];
    const perPixel = components.length;
    if (!perPixel) return [-1, -1, -1, -1];
    return ['R', 'G', 'B', 'W'].map((letter) => {
      const offset = components.indexOf(letter);
      return offset < 0 ? -1 : this.addressOf(pixel * perPixel + offset);
    });
  }

  /**
   * The same addressing as `pixelTexels`, as numbers rather than as answers.
   *
   * `pixelTexels` resolves one pixel at a time, which is the right shape for a
   * strip and the wrong one for a tile: a 256 x 256 grid would ask it 65,536
   * times per rebuild. The rule it applies is closed-form integer arithmetic
   * over these four values, so handing them over lets the panel shader derive
   * any pixel's address itself and the CPU derive none of them.
   *
   * @public
   * @returns {Object} `{ address, pixelSize, channelsPerPixel, componentOffsets }`
   */
  get pixelAddressing() {
    const components = (this.OFLData.beam || {}).components || [];
    return {
      address: this.address,
      pixelSize: this.alignmentPixelSize,
      channelsPerPixel: components.length,
      // Offsets from the pixel's first channel, -1 for a component it lacks --
      // the wire order, which is the fixture's own business.
      componentOffsets: ['R', 'G', 'B', 'W'].map((letter) => components.indexOf(letter)),
    };
  }

  /**
   * Handles instanciation of 3D model to be bound to fixture instance
   *
   * @pulic
   * @todo implement every fixture type
   */
  prepare3DModelInstance() {
    // Asked of the geometry, for the same reason the bar below is: a projector's
    // category is 'Other', which says nothing at all, and a projector with no
    // DMX has no channels to recognise it by either.
    if (this.OFLData.beam && this.OFLData.beam.projector) {
      // Never proxied, for the same reason as the bar: three.js cannot be
      // handed an Object3D reached through a reactive proxy.
      this._3DModel = markRaw(new Projector({
        params: this.OFLData.beam.projector,
        // Read rather than copied: the panel edits the settings object in
        // place and the renderer has to see the new value on its next refresh.
        settingsAt: () => this.device,
        // The input this machine throws, resolved the same way a display's is.
        inputAt: () => VideoRouter.input(this.device && this.device.value('source')),
      }));
      this._3DModel.fixtureHandle = this;
      this._3DModel.position = this._position;
      this._3DModel.rotation = this._rotation;
      return;
    }
    if (this.OFLData.beam && this.OFLData.beam.display) {
      this._3DModel = markRaw(new Display({
        params: this.OFLData.beam.display,
        settingsAt: () => this.device,
        // The input this display shows, resolved through the router so nothing
        // in the model layer has to reach for the show.
        inputAt: () => VideoRouter.input(this.device && this.device.value('source')),
      }));
      this._3DModel.fixtureHandle = this;
      this._3DModel.position = this._position;
      this._3DModel.rotation = this._rotation;
      return;
    }
    if (this.OFLData.beam && this.OFLData.beam.laser) {
      // A box with an aperture, drawn like the projector's chassis so a laser
      // is visible and placeable. The renderer reads the settings in place,
      // the way the projector does.
      this._3DModel = markRaw(new Laser({
        params: this.OFLData.beam.laser,
        settingsAt: () => this.device,
        // A GDTF laser's own model, in place of the box.
        body: this.fixtureType ? this.fixtureType.laserBody : null,
      }));
      this._3DModel.fixtureHandle = this;
      this._3DModel.position = this._position;
      this._3DModel.rotation = this._rotation;
      return;
    }
    if (this.OFLData.beam && this.OFLData.beam.strobe) {
      // A box with a lamp face. Its channels are routed to the settings by
      // position, like a projector's, and the renderer reads them each frame.
      this._3DModel = markRaw(new Strobe({
        params: this.OFLData.beam.strobe,
        settingsAt: () => this.device,
      }));
      this._3DModel.fixtureHandle = this;
      this._3DModel.position = this._position;
      this._3DModel.rotation = this._rotation;
      return;
    }
    // A generated profile carries the geometry OFL cannot express. Its presence
    // is what identifies the fixture, rather than a category string, because
    // 'Matrix' says nothing about where the emitters actually are.
    if (this.OFLData.beam && this.OFLData.beam.bar) {
      // Never proxied: the show is reactive, and a renderer reached through a
      // reactive fixture would be handed to three.js as a proxy, which cannot
      // return Object3D internals like modelViewMatrix unchanged.
      this._3DModel = markRaw(new LedBar({
        params: this.OFLData.beam.bar,
        components: this.OFLData.beam.components,
        texelAt: this.pixelTexels.bind(this),
        // Read rather than bound: a repatch changes the address, and the panel
        // has to see the new one on the rebuild that follows.
        addressingAt: () => this.pixelAddressing,
      }));
      this._3DModel.fixtureHandle = this;
      this._3DModel.position = this._position;
      this._3DModel.rotation = this._rotation;
      return;
    }
    // Matched against every category, not just the first: a number of movers
    // are listed as e.g. ["Color Changer", "Moving Head"], and testing only
    // categories[0] rejected them.
    const categories = this.OFLData.categories || [];
    const renderable = categories.includes(FIXTURE_TYPES.MOVING_HEAD)
      && !!this.OFLData.physical;

    switch (renderable ? FIXTURE_TYPES.MOVING_HEAD : null) {
      case FIXTURE_TYPES.MOVING_HEAD: {
        const { lens, bulb } = this.OFLData.physical;
        // DMX reaches the head through the profile's GDTF translation, the
        // same path a .gdtf takes. Modes keep their order in translation.
        const type = translated(this.profileKey, this.OFLData);
        const mode = type.modes[this.modeIndex] || type.modes[0];
        // The travel across every pan and tilt function of the mode, as a
        // GDTF fixture's is found.
        const inputs = headInputs(type, mode);
        // Before the light, which asks the mode whether the lens is wound by hand.
        this._engine = markRaw(new DmxEngine(type, mode));
        this.createLight({
          minAngle: lens ? lens.degreesMinMax[0] : 10,
          maxAngle: lens ? lens.degreesMinMax[1] : 25,
          minTilt: 0,
          maxTilt: inputs.tiltSpan || 0,
          minPan: 0,
          maxPan: inputs.panSpan || 0,
          // Not every profile carries a bulb block; a daylight-ish default is
          // better than refusing to build the fixture.
          colorTemp: (bulb || {}).colorTemperature || DEFAULT_COLOR_TEMP,
          lumens: Light.lumensOf(this.OFLData.physical),
          bodyHeight: this.bodyHeight,
          // Every wheel the profile has, by name, with this placement's swaps:
          // the head sorts them into colour, gobo and prism wheels by what
          // their slots hold, however many of each there are.
          wheels: this.wheels || this.OFLData.wheels || {},
        }, true);
        this._dispatch = this.dispatchFor();
        break;
      }
      default: {
        // No renderer for this type yet: patch it, address it, draw nothing.
        this._3DModel = markRaw(unsupportedModel());
        break;
      }
    }
  }

  /**
   * Prepare fixture's channel from provided OFL configuration data
   *
   * @public
   */
  prepareChannels() {
    const { OFLData } = this;
    this.mode = OFLData.modes[this.modeIndex] || OFLData.modes[0]; // Parsing and setting fixture channel mode
    // Kept by name from here on, which is what the show saves: the patch
    // dialog hands over a place in the list.
    if (this.mode && this.mode.name) this.modeName = this.mode.name;

    // A generated bar's channels are a range, not a collection of objects:
    // every one of them is the same colour intensity under a different name,
    // and all of that is arithmetic on the index. See bar_channels.js.
    if (this.isBar) {
      this.channels = new BarChannels(OFLData.beam.bar);
      return;
    }

    this.channels = [];
    let channelId = 0; // Initialising channel index to 0
    this.mode.channels.forEach((channel) => { // Looping through channel modes
      if (channel && typeof channel === 'string') { // Making sure the OFL mode data contains a channel value
        const split = channel.split(FINE_CHANNEL_SPLIT_PATERN); // Looking for and parsing fine channel aliases
        const channelName = split[0]; // Getting channel name from split result
        const isFine = split.length > 1; // Checking if split result contains a result for fine alias
        let channelData = OFLData.availableChannels[channelName]; // Isolating channel data
        if (channelData && channelData.capability && isFine) {
          // A copy rather than a write, so a fine channel can rename its own
          // capability type without touching the shared profile. Copying the
          // two objects it needs costs nothing; deep-cloning the whole profile
          // for it would be 46% of the cost of adding a panel.
          channelData = {
            ...channelData,
            capability: {
              ...channelData.capability,
              type: `${channelName}${FINE_CHANNEL_TERMINOLOGY}`,
            },
          };
        }
        const chn = new Channel({ // Instanciating new channel
          id: ++channelId, // Channel's ID is set and incremented for the next loop occurence
          type: channelName, // Setting channel type name @see channel.model.js
          name: `${channelName}${isFine ? FINE_CHANNEL_TERMINOLOGY : ''}`, // Setting channel name and fine terminology @see channel.model.js
          OFLData: channelData, // Providing channel data
          isFine, // Setting fine flag
        });
        this.channels.push(chn); // Instanciating channel in the fixture's channel pool
      } else { // In case the OFL channel configuration is emty/undefined
        const chn = new Channel({ // Instanciating a new empty channel
          type: 'Unset',
          id: ++channelId, // Setting channel's ID and incrementing for the next loop occurence
        });
        this.channels.push(chn); // Pushing empty channel in to the fixture's channel pool
      }
    });
  }

  /**
   * Sets up fixture's quick accessors
   *
   * @public
   */
  setupQuickAccessors() {
    // A bar has one channel type across every channel, so the accessor map
    // would be a single array holding every channel -- exactly the allocation
    // the range exists to avoid. Nothing asks a bar for a quick accessor:
    // they serve Pan, Tilt and Dimmer, none of which a bar has.
    if (this.isBar) return;
    this.channels.forEach((channel) => {
      if (this.quickChannelsAccessors[channel.type]) {
        channel.qaIndex = this.quickChannelsAccessors[channel.type].length;
        this.quickChannelsAccessors[channel.type].push(channel);
      } else {
        channel.qaIndex = 0;
        this.quickChannelsAccessors[channel.type] = [channel];
      }
    });
  }

  /**
   * Sets up fine channels
   *
   * @public
   */
  setupFineChannels() {
    // No generated bar has a 16-bit channel, and the search below is a
    // `find` per channel -- quadratic if it ever did run over a range.
    if (this.isBar) return;
    this.channels.forEach((channel) => {
      if (channel.fineChannelAliases && !channel.isFine) {
        channel.fineChannels = channel.fineChannelAliases.flatMap((alias) => {
          const standardizedAlias = alias.replace(' ', '').toLowerCase();
          const fineChannel = this.channels.find((item) => item.type.replace(' ', '').toLowerCase() === standardizedAlias);
          return fineChannel || [];
        });
      }
    });
  }

  /**
   * Whether the lens is focused by hand: the mode the fixture runs in has a
   * focus channel with no DMX address. A GDTF file says so that way, and a
   * profile's translation does for `physical.lens.focus: "manual"`.
   *
   * @readonly
   * @type {Boolean}
   */
  get hasManualFocus() {
    const channels = this._engine ? this._engine.mode.channels : [];
    return channels.some((c) => !c.offsets
      && c.logicalChannels.some((l) => /^Focus\d+$/.test(l.attribute)));
  }

  /**
   * The distance a hand-focused lens is focused at, in metres: where the
   * gobo is sharp. On the placement, because each unit's lens is set on its
   * own.
   *
   * @type {Number}
   */
  /**
   * The gobos and discs swapped into this placement's wheels, as
   * `{ wheel, slot, image, rotation }`; see wheel_overwrites.js. Setting it
   * gives the light its wheels again with the new pictures.
   *
   * @type {Array<Object>}
   */
  set overwrites(list) {
    this._overwrites = normaliseOverwrites(list);
    this.wheels = this.overwrittenWheels();
    if (this._3DModel && typeof this._3DModel.setWheels === 'function') {
      this._3DModel.setWheels(this.wheels);
    }
  }

  get overwrites() {
    return (this._overwrites || []).map((o) => ({ ...o }));
  }

  /**
   * The wheels this placement may swap gobos and discs into, for the panel:
   * its gobo wheels and animation wheels, each slot with what it shows now.
   * A wheel's kind is the attributes that drive it, for a GDTF file, and its
   * slots' types for an OFL profile.
   *
   * @type {Array<Object>} `{ name, kind, slots: [{ number, name, open,
   *   image, rotation, thumbnail }] }`; `image` the swapped picture's
   *   reference or null, `thumbnail` a URL or null for an open slot
   */
  get swappableWheels() {
    const base = this._definitionWheels || {};
    const kinds = {};
    const type = this.fixtureType;
    if (type) {
      type.modes.forEach((mode) => mode.channels.forEach((c) => c.logicalChannels
        .forEach((l) => l.functions.forEach((f) => {
          if (!f.wheel || !base[f.wheel]) return;
          if (/^Animation(Wheel|System)/.test(f.attribute)) kinds[f.wheel] = 'animation';
          else if (/^Gobo\d/.test(f.attribute) && !kinds[f.wheel]) kinds[f.wheel] = 'gobo';
        }))));
    } else {
      Object.keys(base).forEach((name) => {
        const slots = (base[name] && base[name].slots) || [];
        if (slots.some((s) => s && /Animation/.test(String(s.type)))) kinds[name] = 'animation';
        else if (slots.some((s) => s && s.type === 'Gobo')) kinds[name] = 'gobo';
      });
    }
    const overwrites = this._overwrites || [];
    return Object.keys(kinds).map((name) => {
      const shown = (this.wheels && this.wheels[name]) || base[name];
      const own = base[name].slots || [];
      return {
        name,
        kind: kinds[name],
        slots: (shown.slots || []).map((slot, i) => {
          const o = overwrites.find((x) => x.wheel === name && x.slot === i + 1);
          let thumbnail = slot && slot.image ? slot.image.url : null;
          if (!thumbnail && slot && slot.type === 'Gobo') {
            const pick = goboThumbnail(shown, i + 1);
            thumbnail = pick ? pick.url : null;
          }
          const defined = own[i] || {};
          return {
            number: i + 1,
            name: String(defined.name || '').trim() || `Slot ${i + 1}`,
            open: !o && defined.type === 'Open',
            image: o ? o.image : null,
            rotation: o ? o.rotation : 0,
            thumbnail,
          };
        }),
      };
    });
  }

  /**
   * The definition's wheels with this placement's swaps applied.
   *
   * @private
   * @returns {Object}
   */
  overwrittenWheels() {
    const type = this.fixtureType;
    const where = {
      goboNames: GOBOS.map((g) => g.name),
      collectedUrl: (name) => {
        const gobo = GDTF_GOBOS.find((g) => g.name === name);
        return gobo ? GOBO_URL + gobo.file : null;
      },
      animationUrl: (name) => {
        const disc = STOCK_DISCS.find((d) => d.name === name);
        return disc ? ANIMATION_URL + disc.file : null;
      },
      libraryUrl: (file) => UserGobos.urlFor(file),
      ownImages: type && type.wheelImages ? type.wheelImages : null,
      typeKey: type ? (type.fixtureTypeId || type.name) : this.profileKey,
    };
    return applyOverwrites(this._definitionWheels || {}, this._overwrites || [], (ref) => {
      const shown = resolveImage(ref, where);
      return shown && shown.image && !shown.image.url ? null : shown;
    });
  }

  set focusDistance(value) {
    this._focusDistance = focusDistanceOf(value);
    if (this.hasManualFocus && this._3DModel && 'focusDistance' in this._3DModel) {
      this._3DModel.focusDistance = this._focusDistance;
    }
  }

  get focusDistance() {
    return this._focusDistance;
  }

  /**
   * Whether this item is hidden from the scene: not drawn, giving no light,
   * and not picked in the 3D view. Saved with the show. DMX still arrives,
   * so showing it again shows what it is doing now.
   *
   * @type {Boolean}
   */
  set hidden(state) {
    this._hidden = !!state;
    this.applyHidden();
  }

  get hidden() {
    return !!this._hidden;
  }

  /**
   * Hidden by its own flag, by the structure or group holding it, or by the
   * view filter.
   *
   * @readonly
   * @type {Boolean}
   */
  get isHidden() {
    return !!(this._hidden
      || (this.structure && this.structure.isHidden)
      || (this.group && this.group.hidden)
      || ViewFilter.hides(this));
  }

  /**
   * Pushes whether this is hidden down to what draws it.
   *
   * @public
   */
  applyHidden() {
    if (this._3DModel && 'hidden' in this._3DModel) this._3DModel.hidden = this.isHidden;
  }

  /**
   * Highlights the fixture model
   *
   * @param {Boolean} state if the fixture Model should be highlighted or not
   */
  highlight(state, centerControls = false) {
    if (this._3DModel) {
      this._3DModel.highlighted = state;
      if (centerControls) {
        if (state) {
          Controls.attach(this);
        } else {
          Controls.detach(this);
        }
      }
    }
  }

  /**
   * Highlights the fixture model while unhighlighting any other already highlighted instance
   *
   * @param {Boolean} state wheter the fixture Model should be highlighted or not
   */
  highlightSingle(state, centerControls = false) {
    // A fixture with nothing to draw has no highlight to set, but is still
    // selected.
    if (this._3DModel) {
      if (typeof this._3DModel.setSinglyHighlighted === 'function') {
        this._3DModel.setSinglyHighlighted(state);
      }
      if (state && centerControls) {
        Controls.detachAll();
        Controls.attach(this);
      } else if (!state) {
        Controls.detachAll();
        Controls.setFocus(false);
      }
    }
  }

  /**
   * Delete fixture instance by removing the model from the instanced mesh pool
   * and unreferencing each instance property.
   *
   * @param {Fixture}
   * @static
   */
  /**
   * Whether a profile wants its pixels kept whole within a universe.
   *
   * A generated profile can say so outright. When it does not -- an older one,
   * or a library fixture with nowhere to record it -- the answer follows from
   * the arithmetic: a pixel whose channel count divides 512 tiles a universe
   * exactly and can never be split, so the question is moot, while one that
   * does not divide it will eventually straddle a boundary unless told not to.
   *
   * @public
   * @param {Object} OFLData profile
   * @returns {Boolean}
   */
  static profileKeepsPixelsWhole(OFLData) {
    const section = (OFLData || {}).beam || {};
    if (section.bar && section.bar.universeAligned !== undefined) {
      return !!section.bar.universeAligned;
    }
    const perPixel = (section.components || []).length;
    return perPixel > 0 && DMX_UNIVERSE_LENGTH % perPixel !== 0;
  }

  static deleteInstance(instance) {
    const model = instance._3DModel;
    if (model instanceof LedBar) {
      LedBar.deleteInstance(model);
    } else if (HEAD_CATEGORIES.includes(instance.category)) {
      Light.deleteInstance(model);
    } else if (model && model.constructor
      && typeof model.constructor.deleteInstance === 'function') {
      // Asked of the renderer itself, so a new kind needs nothing added here.
      // A renderer that is never disposed keeps its meshes in the scene and
      // its instance in the pick list for the rest of the session.
      //
      // The two branches above cannot migrate to this: a bar is matched by
      // `instanceof` and a head by its *category*, so neither is chosen by what
      // its renderer is.
      model.constructor.deleteInstance(model);
    }
    instance = null;
  }

  /**
   * Converts a provided value from degrees into radians
   *
   * @param {Number} deg input degrees value to be converted to radians
   * @returns Result of the conversion of the provided degree value into radians
   * @todo this could go in an util.js as it might/will be used elsewhere
   */
  static degToRad(deg) {
    return deg * (Math.PI / 180);
  }

  /**
   * Converts a provided value from radians into degrees
   *
   * @param {Number} deg input radians value to be converted to degrees
   * @returns Result of the conversion of the provided radians value into degrees
   * @todo this could go in an util.js as it might/will be used elsewhere
   */
  static radToDeg(rad) {
    return rad * (180 / Math.PI);
  }
}

export default Fixture;
