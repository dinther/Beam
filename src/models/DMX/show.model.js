import * as THREE from 'three';
import fetchJson from '@/plugins/fetch_json';
import { choose } from '@/plugins/confirm';
import { markRaw, toRaw } from 'vue';
import {
  EventEmitter,
} from 'events';
import {
  ProxifySingleton,
} from '../utils/proxify.utils';
import { onSceneChange } from './scene_changes';

import PatchSingleton from './patch.model';
import migrateShowData, { SHOWFILE_VERSION } from './showfile.migrate';
import VideoInput, { migrateVideo, withTestCard, INPUT_KINDS } from './video_input';
import FixturePool from './fixture.pool.model';
import Group from './group.model';
import Structure from './structure.model';
import SceneObject from './object.model';
import { SCENE_ITEM_KINDS, kindOf } from './scene_item';
import { claimInstance, setSiblingResolver } from './item_naming';
import Live from './live.model';
import {
  expandLedBarProfile, withoutLedBarChannels,
} from './generic/led_bar';
import { kindById } from './generic/fixture_kind';
import DefinitionStore, { SHOW_SCOPE, SHOW_SCOPE_LABEL, showKey } from './definition_store';
import VideoRouter from '../../plugins/visualizer/video_router';
import Preferences from '../../plugins/visualizer/preferences';
import SceneObjects from '../../plugins/visualizer/scene_objects';
import Studio from './studio';
import { normaliseMatrixProfile } from './ofl_matrix';
import withBeamSection from './generic/beam_section';
import movedProfile from './moved_profiles';
import readGdtf, { wheelImages } from './gdtf/gdtf_reader';
import buildBody, { laserBody } from '../../plugins/visualizer/gdtf_body';
import { laserGeometry } from './gdtf/laser_parts';
import { headInputs, isLaserType } from './gdtf/fixture_parts';
import MeasureTool from '../../plugins/visualizer/measure_tool';
import ViewFilter from './view_filter';
import { CLIP_KINDS, BUILT_IN_CLIPS } from './laser_clips';
import { loadCards } from '../../plugins/visualizer/laser_cards';
import UserGobos from '../../plugins/visualizer/user_gobos';

/** The ILDA files that ship with Beam, which an export need not carry. */
const SHIPPED_CLIP_FILES = new Set(BUILT_IN_CLIPS
  .filter((clip) => clip.kind === CLIP_KINDS.FILE).map((clip) => clip.file));

const fixtureDataCache = {};

/**
 * The names the app hands out when nobody has given one.
 *
 * `untitled`, `Group`, `Structure` -- what a structure or a group is
 * called when it is made without a name. The trailing number is for names
 * saved before the instance number was kept apart from the name.
 *
 * @constant {RegExp}
 */
const PLACEHOLDER_NAME = /^(untitled|group|structure)(\s+\d+)?$/i;

/**
 * Whether a name is one somebody chose, rather than one the app made up.
 *
 * The library is a file per item named for the item, and placing a stamp again
 * means finding it by that name -- so `untitled 1` is not a name so much as
 * the absence of one, and a library of them cannot be read. This is what the
 * save paths refuse on.
 *
 * @public
 * @param {String} name
 * @returns {Boolean}
 */
export function isNamedByUser(name) {
  const wanted = String(name === undefined || name === null ? '' : name).trim();
  return !!wanted && !PLACEHOLDER_NAME.test(wanted);
}

/**
 * A model reference, folded so two spellings of one file name meet.
 *
 * Library keys are file names, and the filesystems Beam runs on do not agree
 * about whether case is part of a name -- Windows and macOS say no, Linux says
 * yes. A show carries whatever spelling was current when the object was placed,
 * so an exact compare turns a harmless rename into a show that has lost its
 * models. Folded here rather than at each call site so the reference and the
 * library are always compared the same way.
 *
 * @param {String} key a library key or model name
 * @returns {String} the key, folded for comparison only
 */
function foldModelKey(key) {
  return String(key === undefined || key === null ? '' : key).toLowerCase();
}

/**
 * Fetches a library profile, or null if there is not one to be had.
 *
 * Validated rather than merely fetched. The dev server answers an unknown path
 * with index.html and a cheerful 200, so a deleted profile arrives as a page of
 * HTML -- and the first thing to touch it dies of a type error several layers
 * away from anything that could name which profile was missing.
 *
 * @param {String} profileKey `manufacturer/model`
 * @returns {Object|null} an OFL-shaped profile, or null
 */
async function fetchProfile(profileKey) {
  try {
    const profile = await fetchJson(`${import.meta.env.VITE_STATIC_URL}fixtures/${profileKey}.json`);
    // The least a profile needs for the parser to survive it. A 404 served as
    // HTML has none of these, which is the point.
    const usable = profile
      && typeof profile === 'object'
      && Array.isArray(profile.categories)
      && Array.isArray(profile.modes);
    // A grid arrives declared rather than enumerated -- see `ofl_matrix` -- and
    // is written out here, once, so that nothing downstream has to know the
    // difference between a profile that listed its channels and one that
    // described them.
    return usable ? normaliseMatrixProfile(withBeamSection(profile)) : null;
  } catch (err) {
    return null;
  }
}

/**
 * Storage for show definitions
 * TODO: Refactor and document.
 *
 * @class Show
 * @todo Refactor whole class. it's messy
 * @extends {EventEmitter}
 */
/**
 * An item's show data with its place in the item list, when it has one.
 *
 * Written by the show rather than by each item: the place belongs to the list,
 * and a copy on the clipboard deliberately arrives without one.
 *
 * @param {Object} item a fixture, object, structure or group
 * @returns {Object} its show data
 */
function withListOrder(item) {
  const data = item.showData;
  return Number.isFinite(item.listOrder) ? { ...data, listOrder: item.listOrder } : data;
}

/**
 * Gives a loaded item back the place in the item list it was saved with.
 *
 * @param {Object} item the item just made
 * @param {Object} data the record it was made from
 */
function restoreListOrder(item, data) {
  if (item && data && Number.isFinite(data.listOrder)) item.listOrder = data.listOrder;
}

class Show extends EventEmitter {
  /**
   * Creates an instance of Show.
   */
  constructor() {
    super();
    // So an item can be named on screen -- with its number only when another
    // of its kind shares its name -- without the models reaching for the show.
    setSiblingResolver((item) => this.siblingsOf(item));
    /**
     * Absolute path of the document this show was opened from or last saved
     * to, or null when it has never been saved.
     *
     * Null is what makes a show *untitled*, and it is why Save has to become
     * Save As the first time: there is nowhere to write yet, and choosing that
     * place is the user's to do, not ours.
     */
    this.documentPath = null;
    /** The project's name -- its folder's -- or '' while untitled. */
    this.projectName = '';
    this.isSaved = true;
    this.rawOFLFixtures = [];
    /**
     * Profiles built here rather than fetched, keyed the same way. OFL cannot
     * describe an emitter array, so these are generated from parameters the
     * user chose, and saved beside the show.
     */
    this.generatedProfiles = {};
    /**
     * GDTF fixtures in the user's library, as listed by the main process:
     * `{ key, file, name, manufacturer, fixtureTypeId, dataVersion }`. The
     * files themselves are fetched from `library://profiles/<file>` when
     * they are needed.
     */
    this.gdtfFixtures = [];
    /**
     * GDTF fixture types read so far, by key. Read-only once read, so every
     * fixture of a type shares one.
     */
    this.gdtfTypes = new Map();
    /**
     * What the open document carries with it: the profiles an export
     * collected, keyed like the library. Resolved after the show's own
     * definitions and ahead of the library, so an export opened on another
     * machine shows the fixtures it was made with. Models an export carries
     * arrive through the object library instead, served by the main process.
     */
    this.collected = Show.nothingCollected();
    /**
     * Fixture definitions that belong to this show and not (yet) to the
     * library -- see `definition_store.js`. Resolved ahead of the library, so a
     * show's own definition wins over a library entry of the same name.
     */
    this.definitions = new DefinitionStore();
    this.fixturePool = new FixturePool();
    /** Groups, in list order. Membership is exclusive. */
    this.groups = [];
    /**
     * Structures standing in the scene, in list order. These are placed
     * items, not definitions: each holds real fixtures and objects and has no
     * link back to whatever it was stamped from.
     */
    this.structures = [];
    /**
     * Models standing in the scene. Held beside structures rather than in the
     * fixture pool: an object has no address and never appears in the patch
     * bay, so pooling it with things that do would mean explaining the
     * exception everywhere.
     */
    this.objects = [];
    /**
     * The pictures this show receives: NDI streams and files. A display or
     * projector names one by id. Not scene items: an input has no position
     * and nothing draws it. See `video_input.js`.
     */
    this.videoInputs = withTestCard([]);
    // Installed once: the lookups read the live array each time, so inputs
    // added or removed later are found without re-installing.
    this.publishVideoInputs();
    /**
     * The project's details, set in Project Details and printed on the patch
     * sheet: `{ author, version, notes }`, each free text.
     */
    this.details = Show.noDetails();
    /** Library models available to place, by key. Read once per load. */
    this.objectLibrary = {};
    /** Saved structure definitions, keyed by name, for placing again. */
    this.structureLibrary = {};
    /**
     * Manufacturer display names, keyed by the folder the library uses.
     *
     * The library addresses a manufacturer by a slug -- `martin`,
     * `5star-systems` -- because that is its directory. Anything shown to a
     * person, or written into a file another application will show to one,
     * wants the real name instead.
     */
    this.manufacturers = {};
    /** Showfile fixture id to instance, for the duration of a load. */
    this.loadedFixturesById = new Map();
    this.running = false;
    this.slave = false;
    this.loading = {
      state: true,
      message: 'Preparing Environment',
      percentage: 10,
    };
    this.ready = false;
    /** Tail of the load queue, so two loads can never interleave. */
    this.loadChain = Promise.resolve();
    this.artnetServerUrl = import.meta.env.VITE_APP_DMX2WS_SERVER_URL;
    this.visualizerHandle = null;
    /** An opening view waiting for the viewport's camera; see `applyOpeningView`. */
    this.pendingOpeningView = null;
    ProxifySingleton.on('changed', () => {
      this.isSaved = false;
      this.emit('saveState', this.isSaved);
    });
    // Measurements are kept by the measure tool, outside the proxied data.
    MeasureTool.onChange(() => this.touch());
    // Objects, structures and groups are not proxied; their setters report here.
    onSceneChange(() => { if (this.isSaved) this.touch(); });
    // The filter is saved with the project, so changing it is an edit.
    ViewFilter.onChange(() => {
      this.applyViewFilter();
      this.touch();
    });
    this.preloadManufacturers();
    this.preloadFixtureList();
  }

  set saveState(saveState) {
    this.isSaved = saveState;
  }

  get saveState() {
    return this.isSaved;
  }

  /**
   * Marks the show changed.
   *
   * Most edits are noticed on their own: show data goes through a proxy that
   * reports every write. Studio's cameras do not -- they live in their own
   * reactive store so two fragments can share them -- and they are show data,
   * so whatever changes them says so here. Without this you can place a
   * view, close, and be asked nothing on the way out.
   *
   * @public
   */
  touch() {
    this.isSaved = false;
    this.emit('saveState', this.isSaved);
  }

  get isSaved() {
    return this._isSaved;
  }

  set isSaved(isSaved) {
    this._isSaved = isSaved;
  }

  /**
   * Sets the project's details, marking the show changed when any differ.
   *
   * @public
   * @param {Object} details `{ author, version, notes }`; missing fields are
   *   left as they are
   */
  setDetails(details) {
    const next = { ...this.details };
    Object.keys(next).forEach((key) => {
      if (details[key] !== undefined) next[key] = String(details[key] || '');
    });
    if (Object.keys(next).every((key) => next[key] === this.details[key])) return;
    this.details = next;
    this.touch();
  }

  /**
   * Details with every field empty.
   *
   * @static
   * @returns {Object}
   */
  static noDetails() {
    return { author: '', version: '', notes: '' };
  }

  /**
   * Details as a show file holds them. Older files kept only notes, at the top
   * level as `notes` or `patchSheetNotes`.
   *
   * @static
   * @param {Object} showData
   * @returns {Object}
   */
  static detailsFrom(showData) {
    const stored = showData.details || {
      notes: showData.notes !== undefined ? showData.notes : showData.patchSheetNotes,
    };
    const details = Show.noDetails();
    Object.keys(details).forEach((key) => {
      if (typeof stored[key] === 'string') details[key] = stored[key];
    });
    return details;
  }

  // eslint-disable-next-line class-methods-use-this
  get tick() {
    return Live.tick;
  }

  /**
   * The show's DMX address space.
   *
   * @readonly
   * @type {Object}
   */
  // eslint-disable-next-line class-methods-use-this
  get patch() {
    return PatchSingleton;
  }

  get showData() {
    // Read only when the show is being written out, which is the moment the
    // editor camera has to hold the view actually on screen.
    this.captureEditorView();
    return {
      version: SHOWFILE_VERSION,
      diffInput: PatchSingleton.diffInput,
      // Addressing lives entirely on the fixtures. Universe records are
      // kept only for the name and colour the patch bay displays.
      groups: this.groups.map(withListOrder),
      structures: this.structures.map(withListOrder),
      // Keys and transforms. The geometry stays in the library until an export
      // collects it, which is the same bargain profiles make.
      objects: this.objects.map(withListOrder),
      // The show's own fixture definitions travel with it, so it opens on a
      // machine whose library has never seen them. Pruned first: a definition
      // nothing references any more is not part of this show.
      definitions: this.pruneDefinitions().toJSON(),
      fixtures: this.fixturePool.fixtures.map(withListOrder),
      // The inputs, and deliberately not which sender fills an NDI one: that
      // is a fact about one machine, and this file opens on others.
      videoInputs: this.videoInputs.map((input) => input.showData),
      // Views, not cameras: five numbers each, applied to the one camera the
      // visualizer has. They belong to the show because they are about this
      // scene -- a locked view onto a rig is how you see that a material
      // changed, and it has to survive being closed to be worth anything.
      //
      // Caught up by `captureEditorView` at the top of this getter. Nothing
      // writes the editor camera while you are working -- the 10 Hz sync only
      // runs in studio mode -- so without that, a project would remember
      // whatever the view was when studio was last left rather than the one
      // being saved.
      cameras: Studio.showData,
      studio: Studio.showSettings,
      details: Object.values(this.details).some(Boolean) ? { ...this.details } : undefined,
      measurements: MeasureTool.toJSON(),
      viewFilter: ViewFilter.toJSON(),
    };
  }

  /**
   * Pushes the view filter to everything drawn.
   *
   * @private
   */
  applyViewFilter() {
    this.fixturePool.fixtures.forEach((fixture) => fixture.applyHidden());
    this.objects.forEach((object) => object.applyHidden());
  }

  /**
   * Puts the viewport on a show's opening view: its stored editor view, or a
   * framing of what it contains when it has none.
   *
   * A show opened at launch loads before the viewport has a camera; the view
   * is then held until `visualizerReady` says there is one.
   *
   * @public
   * @param {Boolean} stored whether the show carried an editor view
   */
  applyOpeningView(stored) {
    const handle = this.visualizerHandle;
    if (!handle || !handle.camera || !handle.controls) {
      this.pendingOpeningView = { stored: !!stored };
      return;
    }
    this.pendingOpeningView = null;
    if (stored) {
      handle.viewpoint = Studio.viewpointOf(Studio.SCENE_CAMERA_ID);
    } else if (handle.frameDefault) {
      handle.frameDefault();
    }
  }

  /**
   * Called once the viewport has its camera: applies an opening view that
   * arrived before it did.
   *
   * @public
   */
  visualizerReady() {
    if (this.pendingOpeningView) this.applyOpeningView(this.pendingOpeningView.stored);
  }

  /**
   * Copies the live viewport into the editor camera.
   *
   * Only outside studio mode, where the viewport IS the editor camera. In
   * studio mode it belongs to whichever camera is live and the sync already
   * owns it -- and a locked camera must not be written over at all.
   *
   * @public
   */
  captureEditorView() {
    if (Studio.state.active) return;
    if (!this.visualizerHandle) return;
    if (Studio.isCameraLocked(Studio.SCENE_CAMERA_ID)) return;
    Studio.captureInto(Studio.SCENE_CAMERA_ID, this.visualizerHandle.viewpoint);
  }

  /**
   * Current show state
   *
   * @type {Number}
   */
  // eslint-disable-next-line class-methods-use-this
  set state(state) {
    Live.state = state;
  }

  // eslint-disable-next-line class-methods-use-this
  get state() {
    return Live.state;
  }

  /**
   * Show's BPM value as defined in the Live singleton
   *
   * @type {Number}
   */
  /**
   * Steps the undo stack back one.
   *
   * An **instance** method, not static: its caller, the Edit menu, calls
   * `this.$show.undo()`, the way everything the app asks of the show goes
   * through `$show`. Declared static, that call throws.
   *
   * @public
   */
  // eslint-disable-next-line class-methods-use-this
  undo() {
    ProxifySingleton.undo();
  }

  /**
   * Steps the undo stack forward one.
   *
   * @public
   */
  // eslint-disable-next-line class-methods-use-this
  redo() {
    ProxifySingleton.redo();
  }

  /**
   * Claims every loaded fixture's channels in the show's address space.
   *
   * @public
   */
  async patchFixtures() {
    // Forced: the file says where every fixture is, and one refused overlap
    // would throw here and leave the rest of the rig unpatched.
    this.fixturePool.fixtures.forEach((fixture) => PatchSingleton.patchFixture(fixture, true));
  }

  /**
   * Lets the scene turn an input id into the input itself.
   *
   * Installed here because this is the only object that knows both -- a
   * renderer must not reach into the show, and the show must not know what a
   * renderer wants. Set once, and `video_router.js` holds it.
   *
   * @public
   */
  publishVideoInputs() {
    VideoRouter.resolveWith(
      (id) => (this.videoInputs || []).find((input) => input.id === id) || null,
      () => this.videoInputs || [],
    );
  }

  /**
   * Adds a video input to the show.
   *
   * @public
   * @param {Object} data `{ kind, file, name }`
   * @returns {Object} the VideoInput
   */
  addVideoInput(data = {}) {
    const input = new VideoInput({ ...data, builtIn: false });
    // Before the test card, which stays last; see `withTestCard`.
    const card = this.videoInputs.findIndex((candidate) => candidate.builtIn);
    this.videoInputs.splice(card < 0 ? this.videoInputs.length : card, 0, input);
    this.touch();
    VideoRouter.refresh();
    return input;
  }

  /**
   * Removes a video input. Devices that showed it show nothing.
   *
   * @public
   * @param {Number} id
   */
  removeVideoInput(id) {
    const at = this.videoInputs.findIndex((input) => input.id === id);
    if (at < 0 || this.videoInputs[at].builtIn) return;
    this.videoInputs.splice(at, 1);
    this.touch();
    VideoRouter.refresh();
  }

  /**
   * Marks an input's name or file changed.
   *
   * @public
   */
  videoInputChanged() {
    this.touch();
    VideoRouter.refresh();
  }

  /**
   * Claims a fixture's channels.
   *
   * @public
   * @param {Object} fixture Fixture instance carrying an absolute address
   */
  // eslint-disable-next-line class-methods-use-this
  patchFixture(fixture) {
    PatchSingleton.patchFixture(fixture);
  }

  /**
   * Deletes a fixture from the show.
   *
   * @param {Object} fixture a fixture configuration object
   */
  deleteFixture(fixture) {
    // `findFromId`, as `deleteStructure` already does: a fixture that is no
    // longer in the pool has been deleted, which is the outcome asked for
    // rather than a fault. Deleting a selection makes three passes -- groups,
    // then structures, then what is left -- and the first two take their
    // contents with them, so the third routinely meets fixtures that are
    // already gone. `getFromId` throws at that, so the guard below would never
    // see the falsy value it exists to catch.
    const fixtureHandle = this.fixturePool.findFromId(fixture.id);
    if (fixtureHandle) {
      MeasureTool.forgetItem(fixtureHandle);
      PatchSingleton.unpatchFixture(fixtureHandle);
      this.fixturePool.delete(fixtureHandle, true);
      // The last instance takes its definition with it.
      this.pruneDefinitions();
    }
  }

  /**
   * Clears show data
   *
   * @public
   */
  clearShowData() {
    // The address space outlives no show: drop every claim before loading.
    PatchSingleton.clearAll();
    this.fixturePool.clearAll(true);
    // Their handles are Object3Ds in the scene, so dropping the array is not
    // enough -- the old show's structures would keep a node each.
    this.structures.forEach((structure) => structure.dispose());
    this.structures = [];
    this.objects.forEach((object) => object.dispose());
    this.objects = [];
    // And the geometry they were drawn from. Disposing an object removes its
    // placement -- its row in an instanced buffer -- but the build itself is
    // cached in `SceneObjects` under the object's render key, and a cache that
    // outlives the show it was filled for is a cache that answers the next
    // show's questions with the last one's shapes.
    SceneObjects.clear();
    // Nothing to dispose: a connector holds no scene node and no GPU
    // resource, only numbers.
    this.videoInputs = withTestCard([]);
    this.definitions = new DefinitionStore();
    MeasureTool.load([]);
    ViewFilter.load(null);
    this.isSaved = true;
  }

  /**
   * What this show is called on screen.
   *
   * A show that has never been saved is `untitled`, whatever the template it
   * was built from happens to call itself. The name only becomes real once the
   * user has chosen where the document lives.
   *
   * @type {String}
   */
  /**
   * The folder the open project lives in, or null for one never saved.
   *
   * @type {String|null}
   */
  get documentFolder() {
    return this.documentPath ? this.documentPath.replace(/[\\/][^\\/]*$/, '') : null;
  }

  get documentTitle() {
    return this.projectName || 'untitled';
  }

  /**
   * Points the show at a document, or at none.
   *
   * @private
   * @async
   * @param {String|null} target absolute path, or null to go back to untitled
   */
  async setDocument(target) {
    this.documentPath = target || null;
    this.projectName = target && window.documentStore
      ? await window.documentStore.projectName(target)
      : '';
    this.emit('document', { path: this.documentPath, title: this.documentTitle });
  }

  /**
   * Opens a document the user picks.
   *
   * The whole of it: ask which file, read that file, become it. Nothing is
   * opened unasked -- a document appears because the user said so. The main
   * process keeps the paths opened and saved, for File > Open Recent.
   *
   * @public
   * @async
   * @returns {Promise<Boolean>} whether a document was opened
   */
  async openDocument() {
    if (typeof window === 'undefined' || !window.documentStore) return false;
    if (!await this.releaseDocument('Open Project')) return false;
    const target = await window.documentStore.open();
    // Cancelling is an ordinary answer, not a failure.
    if (!target) return false;
    return this.openDocumentAt(target);
  }

  /**
   * Asks what to do with unsaved changes before the show is replaced: save
   * them, drop them, or stay. A save cancelled in its dialog counts as stay.
   *
   * @public
   * @async
   * @param {String} title the action that would replace the show
   * @returns {Promise<Boolean>} whether the show may be replaced
   */
  async releaseDocument(title) {
    if (this.isSaved) return true;
    const answer = await choose({
      title,
      message: `${this.documentTitle} has unsaved changes.\nSave them first?`,
      detail: "Don't save loses the changes.",
      yes: 'Save',
      also: "Don't save",
      no: 'Cancel',
    });
    if (answer === 'also') return true;
    if (answer === 'yes') return this.saveDocument();
    return false;
  }

  /**
   * Opens a document already named -- double-clicked in Explorer, or handed
   * over on the command line.
   *
   * @public
   * @async
   * @param {String} target absolute path
   * @returns {Promise<Boolean>} whether it opened
   */
  async openDocumentAt(target) {
    if (typeof window === 'undefined' || !window.documentStore || !target) return false;
    const showData = await window.documentStore.read(target);
    if (!showData) {
      // Unreadable is not the same as empty: leave the show that is loaded
      // alone rather than replacing it with nothing.
      this.emit('documentError', target);
      return false;
    }
    await this.loadFromData(showData, { document: target });
    await this.setDocument(target);
    this.isSaved = true;
    this.emit('saveState', this.isSaved);
    return true;
  }

  /**
   * The shape of `collected` when the open document carries nothing.
   *
   * @returns {Object} `{ profiles, gdtf }`, both empty
   */
  static nothingCollected() {
    return { profiles: {}, gdtf: [] };
  }

  /**
   * Saves the show to its document, asking where to put it the first time.
   *
   * @public
   * @async
   * @returns {Promise<Boolean>} whether anything was written
   */
  async saveDocument() {
    if (!this.documentPath) return this.saveDocumentAs();
    return this.writeDocument(this.documentPath);
  }

  /**
   * Saves the show to a document the user picks. The dialog opens on the
   * current document when there is one.
   *
   * @public
   * @async
   * @returns {Promise<Boolean>} whether anything was written
   */
  async saveDocumentAs() {
    if (typeof window === 'undefined' || !window.documentStore) return false;
    const target = await window.documentStore.saveAs(this.documentPath || this.projectName, undefined, 'project');
    // Cancelling a save dialog is an ordinary answer, not a failure.
    if (!target) return false;
    return this.writeDocument(target);
  }

  /**
   * Writes a frozen copy of the show to a document the user picks.
   *
   * A save names what the show uses and leaves it in the library, so that
   * editing a profile reaches every show placing it. An export is the one
   * deliberate freeze: every profile and model the show references
   * goes into the file, so it opens the same way anywhere. It is a copy -- the
   * show stays on the document it was on, and stays as saved or unsaved as
   * it was.
   *
   * @public
   * @async
   * @returns {Promise<Boolean>} whether anything was written
   */
  async exportDocument() {
    if (typeof window === 'undefined' || !window.documentStore) return false;
    // Suffixed so the export does not default to overwriting the project it came from.
    const base = this.projectName || 'Untitled';
    const name = /_Export$/i.test(base) ? base : `${base}_Export`;
    const target = await window.documentStore.saveAs(
      name,
      'Export project',
      `project-export|${this.documentPath || ''}`,
    );
    // Cancelling is an ordinary answer, not a failure.
    if (!target) return false;
    const json = JSON.stringify(this.showData, null, 2);
    const result = await window.documentStore.export(target, json, this.referencedResources());
    this.emit('exported', { target, ...result });
    return !!result.ok;
  }

  /**
   * What the show references outside itself, by key.
   *
   * Profiles are named `manufacturer/model`, one key however many fixtures
   * share it. The show's own definitions are left out: they already travel
   * in the show. Objects are named by library key; an inline shape carries its
   * own parameters and has nothing to collect.
   *
   * @public
   * @returns {Object} `{ profiles, objects, media, lasers, laserCards, gobos }`,
   *   each an array of keys
   */
  referencedResources() {
    const profiles = new Set(this.fixturePool.fixtures
      .map((fixture) => fixture.profileKey)
      .filter((key) => !this.definitions.has(key)));
    const objects = new Set(this.objects
      .filter((object) => !object.isInline && object.model)
      .map((object) => object.model));
    const media = (this.videoInputs || [])
      // The built-in test card ships with Beam, so an export need not carry it.
      .filter((input) => input.kind === INPUT_KINDS.FILE && input.file && !input.builtIn)
      .map((input) => input.file);
    // ILDA files in laser clip lists, and the cards they are copies of. The
    // shipped files travel with Beam.
    const lasers = new Set();
    const laserCards = new Set();
    this.fixturePool.fixtures.forEach((fixture) => {
      const card = fixture.device && fixture.device.value ? fixture.device.value('card') : null;
      if (card) laserCards.add(card);
      const clips = fixture.device && fixture.device.value ? fixture.device.value('clips') : null;
      (Array.isArray(clips) ? clips : []).forEach((clip) => {
        const carried = clip.kind === CLIP_KINDS.FILE && !SHIPPED_CLIP_FILES.has(clip.file);
        if (carried) lasers.add(clip.file);
      });
    });
    // Images from the user's library swapped into wheels. Beam's stock gobos
    // and discs, and a fixture's own images, travel with Beam and the profile.
    const gobos = new Set();
    this.fixturePool.fixtures.forEach((fixture) => {
      (fixture.overwrites || []).forEach((o) => {
        if (o.image.startsWith('library:')) gobos.add(o.image.slice('library:'.length));
      });
    });
    return {
      profiles: [...profiles],
      objects: [...objects],
      media,
      lasers: [...lasers],
      laserCards: [...laserCards],
      gobos: [...gobos],
    };
  }

  /**
   * Writes the show to a path already decided on.
   *
   * @private
   * @async
   * @param {String} target absolute path
   * @returns {Promise<Boolean>} whether the write succeeded
   */
  async writeDocument(target) {
    const json = JSON.stringify(this.showData, null, 2);
    const written = await window.documentStore.write(target, json, this.referencedResources());
    if (!written || !written.ok) return false;
    // A document that carries files carries only what the show uses once
    // saved, so what resolves from it has to shrink to match.
    if (written.carried) this.collected = Show.collectedFrom(written);
    await this.setDocument(target);
    this.isSaved = true;
    this.emit('saveState', this.isSaved);
    return true;
  }

  /**
   * Generates shiwfile from shuw data
   *
   * @returns {String} JSON formated show data.
   */
  genShowFile() {
    return JSON.stringify(this.showData);
  }

  /**
   * Loads showfile from provided URL
   *
   * @param {String} url local url of the showfile
   */
  async loadFromUrl(url) {
    const res = await fetch(url);
    const data = await res.json();
    await this.loadFromData(data);
  }

  /**
   * Prepares and sets up a show from provided show data configuration
   *
   * @param {Object} rawShowData raw show configuration data to be parsed/loaded
   * @param {Object} [options]
   * @param {String} [options.document] the `.beam` the data came from, mounted
   *   so that what it carries resolves ahead of the library; a show from
   *   anywhere else unmounts whatever was open
   * @public
   * @async
   */
  async loadFromData(rawShowData, options = {}) {
    // A load clears the show and then rebuilds it across several awaits. Two
    // overlapping calls would both clear first and then both append, leaving
    // one copy of every fixture per caller, so run them strictly in sequence.
    // A failed load must not stall the queue, hence the same handler twice.
    //
    // The load raises the loading overlay, so the load lowers it -- including
    // when it throws. Left to each caller, one missed path leaves the overlay
    // at "Finalizing" for good over a show that loaded fine.
    const run = async () => {
      try {
        return await this.loadShowData(rawShowData, options);
      } finally {
        this.loading.state = false;
      }
    };
    this.loadChain = this.loadChain.then(run, run);
    return this.loadChain;
  }

  /**
   * Performs a single show load. Callers go through loadFromData, which
   * serialises these.
   *
   * @param {Object} rawShowData raw show configuration data to be parsed/loaded
   * @param {Object} options load options, as `loadFromData` takes them
   * @private
   * @async
   */
  async loadShowData(rawShowData, options = {}) {
    // Connectors and a single video file become inputs; see `migrateVideo`.
    const video = migrateVideo(migrateShowData(rawShowData), Preferences.get('videoSource'));
    const { showData } = video;
    // A document may carry its own copy of a GDTF fixture, so what was read
    // for the last one does not stand for this one.
    this.gdtfTypes = new Map();
    this.loading.state = true;
    this.loading.message = 'Clearing Show Data';
    this.loading.percentage = 20;
    this.clearShowData();
    // Before anything is placed, so each item is drawn filtered from the start.
    ViewFilter.load(showData.viewFilter);

    // Mounted inside the load rather than before it, because loads queue: two
    // documents opened in quick succession must each load against their own
    // files, not both against whichever was mounted last. A refresh has
    // already replaced the mount and hands over what it now carries: mounting
    // again would unpack the file on disk and bring the old copies back.
    if (options.carried) this.collected = Show.collectedFrom(options.carried);
    else await this.mountDocument(options.document || null);

    this.loading.message = 'Preloading fixture library';
    this.loading.percentage = 40;
    await this.preloadGeneratedProfiles();
    await this.preloadGdtfFixtures();
    await this.preloadStructures();
    await this.preloadManufacturers();
    await this.preloadFixtureList();

    // Before the fixtures, which resolve their profiles through it.
    this.definitions = DefinitionStore.fromJSON(showData.definitions);

    this.loading.message = 'Setting up show fixtures';
    this.loading.percentage = 60;
    await this.prepareFixtures(showData);

    this.loading.message = 'Restoring groups';
    this.prepareGroups(showData);

    // Objects before structures, which may hold them.
    this.loading.message = 'Placing objects';
    await this.prepareObjects(showData);

    this.loading.message = 'Restoring structures';
    this.prepareStructures(showData);

    const inputs = (showData.videoInputs || []).map((data) => new VideoInput(data));
    this.videoInputs = withTestCard(inputs);
    // This machine's sender carries over to the input it now fills.
    if (video.binding) VideoRouter.bind(video.binding.uid, video.binding.sender);

    // Cameras belong to the show, so the one arriving replaces the one that
    // was open. A file with no cameras empties the list rather than leaving
    // the last show's views behind it.
    //
    // When the file carries an editor view, the viewport goes to it: reopening
    // a project should look the way it did when it was closed. Applied further
    // down rather than here -- `frameDefault` runs at the end of this method
    // and would fly straight over the top of it.
    const storedView = Studio.loadCameras(showData.cameras);
    Studio.loadSettings(showData.studio);
    this.details = Show.detailsFrom(showData);
    MeasureTool.load(showData.measurements, ({ kind, id }) => {
      if (kind === SCENE_ITEM_KINDS.OBJECT) return (this.loadedObjectsById || new Map()).get(id);
      if (kind === SCENE_ITEM_KINDS.FIXTURE) return this.loadedFixturesById.get(id) || null;
      return null;
    });

    this.loading.message = 'Patching fixtures';
    this.loading.percentage = 80;
    if (showData.diffInput !== undefined) {
      PatchSingleton.diffInput = showData.diffInput;
    }
    await this.patchFixtures();

    this.loading.message = 'Finalizing';
    this.loading.percentage = 95;
    this.ready = true;
    // Building the scene goes through the same setters as an edit, so the
    // saved state is stated again once the load is done.
    this.isSaved = true;
    this.emit('saveState', this.isSaved);

    // The opening view. A show that carries its own editor view gets that one:
    // it is where the project was left, and it is the only camera whose framing
    // has nowhere else to live. `frameDefault` is the fallback for a show that
    // carries none -- and it has to be an either/or, because it flies rather
    // than jumps, so running both would animate away from the restored view.
    this.applyOpeningView(storedView);

    VideoRouter.refresh();
    // Lasers on a library card take the library's version of it.
    loadCards(this).catch(() => {});
    // Said once, when the show opens: these devices showed part of a picture
    // and now show all of it.
    if (video.lostCrop.length) this.emit('videoCropsDropped', video.lostCrop);
  }

  /**
   * Prepares show fixtures from provided show data
   *
   * @param {Object} handle to show data configuration object
   * @public
   * @async
   */
  async prepareFixtures(showData) {
    /**
     * Showfile fixture id to the instance created for it. Ids are reassigned
     * on the way in, so anything referring to a fixture by its saved id needs
     * this to find it again.
     */
    this.loadedFixturesById = new Map();
    this.missingProfiles = [];
    for (let i = 0; i < showData.fixtures.length; i++) {
      const fixtureData = showData.fixtures[i];
      // A profile replaced by another file is looked for under its new name,
      // and the project saves that name from here on.
      Object.assign(fixtureData, movedProfile(fixtureData.manufacturer, fixtureData.model));
      const profileKey = `${fixtureData.manufacturer}/${fixtureData.model}`;
      if (this.gdtfEntry(profileKey)) {
        // eslint-disable-next-line no-await-in-loop
        fixtureData.fixtureType = await this.loadGdtfType(profileKey);
        fixtureData.OFLData = null;
        if (fixtureData.fixtureType) {
          const created = this.fixturePool.addRaw(fixtureData);
          restoreListOrder(created, fixtureData);
          if (fixtureData.id !== undefined) this.loadedFixturesById.set(fixtureData.id, created);
        } else {
          this.missingProfiles.push(profileKey);
        }
        // eslint-disable-next-line no-continue
        continue;
      }
      const local = this.localProfile(profileKey);
      fixtureData.OFLData = local
        ? JSON.parse(JSON.stringify(local))
        : JSON.parse(fixtureDataCache[profileKey] || null);
      if (!fixtureData.OFLData) {
        // A profile the user has since deleted is an ordinary thing to meet in
        // an old show, not an error worth losing the rest of the rig over.
        // Guarded rather than trusted, because the dev server answers an
        // unknown path with index.html and a cheerful 200 -- so what arrives is
        // a page of HTML, and the first thing to touch it dies of a type error
        // several layers from anything that names the profile.
        fixtureData.OFLData = await fetchProfile(profileKey);
        if (fixtureData.OFLData) {
          fixtureDataCache[profileKey] = JSON.stringify(fixtureData.OFLData);
        } else {
          this.missingProfiles.push(profileKey);
        }
      }
      if (fixtureData.OFLData) {
        const created = this.fixturePool.addRaw(fixtureData);
        restoreListOrder(created, fixtureData);
        if (fixtureData.id !== undefined) this.loadedFixturesById.set(fixtureData.id, created);
      }
    }
    if (this.missingProfiles.length) {
      // Named once, with the count, rather than per fixture: thirty bars off
      // one deleted profile is one problem, not thirty.
      // eslint-disable-next-line no-console
      console.warn(`[show] ${this.missingProfiles.length} fixture(s) skipped, profile not found: `
        + `${[...new Set(this.missingProfiles)].join(', ')}`);
    }
  }

  /**
   * Makes a document the open one, taking on what it carries.
   *
   * An export carries its profiles and models; a plain save
   * carries nothing, and then this is only bookkeeping. No document at all --
   * a template, an imported showfile -- unmounts, so that nothing of the last
   * document lingers to resolve a name in this one.
   *
   * @private
   * @async
   * @param {String|null} target absolute path of the `.beam`, or null
   */
  async mountDocument(target) {
    this.collected = Show.nothingCollected();
    if (typeof window === 'undefined' || !window.documentStore) return;
    if (!target) {
      await window.documentStore.unmount();
      return;
    }
    this.collected = Show.collectedFrom(await window.documentStore.mount(target));
  }

  /**
   * What a document carries, in the shape `collected` holds it.
   *
   * @param {Object} [carried] `{ profiles, gdtf }` from the document store
   * @returns {Object} `{ profiles, gdtf }`
   */
  static collectedFrom(carried) {
    const { profiles, gdtf } = carried || {};
    // Bars are stored without their channels, as the library stores them.
    return {
      profiles: Object.fromEntries(Object.entries(profiles || {})
        .map(([key, profile]) => [key, expandLedBarProfile(profile)])),
      gdtf: gdtf || [],
    };
  }

  /**
   * Replaces the copies an exported project carries with the library's.
   *
   * An export resolves what it carries ahead of the library, so a profile or
   * model edited in the library afterwards never reaches it. This collects
   * every item the show references again from the library, reloads the show
   * against the new copies, and leaves it unsaved: the file takes them on the
   * next save, and closing without saving keeps it as it was.
   *
   * @public
   * @async
   * @returns {Promise<Object>} `{ carried, refreshed, kept }` -- whether the
   *   project carries anything, the items whose copy changed, and the items
   *   only the project has
   */
  async refreshFromLibrary() {
    const nothing = { carried: false, refreshed: [], kept: [] };
    if (typeof window === 'undefined' || !window.documentStore || !this.documentPath) return nothing;
    const result = (await window.documentStore.refresh(this.referencedResources())) || nothing;
    if (result.refreshed && result.refreshed.length) {
      await this.loadFromData(JSON.parse(JSON.stringify(this.showData)), {
        document: this.documentPath,
        carried: result,
      });
      // The load treats the show as freshly opened; it is not, until saved.
      this.isSaved = false;
      this.emit('saveState', this.isSaved);
    }
    this.emit('refreshed', result);
    return result;
  }

  /**
   * Rebuilds groups and their membership from a showfile.
   *
   * Runs after the fixtures exist, since a group holds its members rather than
   * their ids. A showfile without groups is simply one where nothing is
   * grouped, so this is safe on older files.
   *
   * @public
   * @param {Object} showData raw showfile contents
   */
  prepareGroups(showData) {
    // Appended rather than assigned, and the same for structures and objects
    // below. A load clears the show first, so it cannot tell the difference --
    // but a paste is the same work on a show that is already standing, and
    // that is the whole difference between loading a chunk and loading a file.
    const made = (showData.groups || []).map((groupData) => {
      const group = new Group(groupData);
      restoreListOrder(group, groupData);
      (groupData.members || []).forEach((id) => {
        // Resolved through the load index rather than the pool: addRaw hands
        // out fresh ids, so a saved member id means nothing once a fixture has
        // been deleted and the rest have shuffled down.
        const fixture = this.loadedFixturesById.get(id);
        if (fixture) group.add(fixture);
      });
      return group;
    });
    Show.joinNumbered(this.groups, made);
    return made;
  }

  /**
   * The items of one kind, which instance numbers are counted among.
   *
   * @public
   * @param {Object} item any scene item
   * @returns {Array}
   */
  siblingsOf(item) {
    switch (kindOf(item)) {
      case SCENE_ITEM_KINDS.FIXTURE: return this.fixturePool.fixtures;
      case SCENE_ITEM_KINDS.OBJECT: return this.objects;
      case SCENE_ITEM_KINDS.STRUCTURE: return this.structures;
      case SCENE_ITEM_KINDS.GROUP: return this.groups;
      default: return [];
    }
  }

  /**
   * Gives an item a new name, and the lowest free instance number under it.
   *
   * The number follows the name rather than the item: renaming `Truss 3` to
   * `Stage` makes `Stage 1` when no other stage is there.
   *
   * @public
   * @param {Object} item any scene item
   * @param {String} desired the name typed; blank keeps the current one
   */
  renameItem(item, desired) {
    const name = (desired || '').trim();
    if (!name || name === item.name) return;
    item.name = name;
    item.instance = null;
    claimInstance(item, this.siblingsOf(item));
  }

  /**
   * Adds items to one of the show's lists, each numbered as it goes in.
   *
   * One at a time, so items added together number against each other as
   * well as against what was already there.
   *
   * @param {Array} list the show's list for their kind
   * @param {Array} items
   */
  static joinNumbered(list, items) {
    items.forEach((item) => {
      claimInstance(item, list);
      list.push(item);
    });
  }

  /**
   * Loads the user's saved structures.
   *
   * @public
   * @async
   */
  async preloadStructures() {
    if (typeof window === 'undefined' || !window.library) return;
    this.structureLibrary = (await window.library.readAll('structures')) || {};
  }

  /**
   * Saves a group's arrangement as a structure.
   *
   * What is kept is the shape, not these fixtures: each member's profile and
   * where it sits relative to the group's origin. Placing it again builds new
   * fixtures, which is why no address is recorded -- they are patched as they
   * are created, exactly as adding one by hand would be.
   *
   * @public
   * @async
   * @param {Object} group group to save
   * @returns {String|null} the structure's name, or null when it has none of
   *   its own and nothing was written
   */
  async saveStructure(group) {
    // Refused rather than filed under `untitled 1`. The name is the key: it is
    // the file's name on disk, the key in the library, and the only thing the
    // user has to pick the stamp out by later. Saving an unnamed one puts an
    // entry in the library that says nothing about what it holds, and a second
    // one overwrites the first.
    if (!isNamedByUser(group.name)) return null;
    const matrix = group.matrix.clone();
    const inverse = matrix.clone().invert();
    const structure = {
      name: group.name,
      members: group.members.map((member) => {
        const local = member.localTransform
          ? member.localTransform.clone()
          : inverse.clone();
        // An object keeps what it is -- its library key, or the parameters of
        // a created one -- and its own scale, beside where it stands.
        if (kindOf(member) === SCENE_ITEM_KINDS.OBJECT) {
          const data = member.showData;
          return {
            kind: SCENE_ITEM_KINDS.OBJECT,
            name: data.name,
            model: data.model,
            primitive: data.primitive,
            scale: data.scale,
            colors: data.colors,
            transform: local.elements.slice(),
          };
        }
        return {
          manufacturer: member.manufacturer,
          model: member.model,
          mode: member.mode ? member.mode.name : undefined,
          universeAligned: !!member.universeAligned,
          transform: local.elements.slice(),
        };
      }),
    };
    // Measurements tied only to the members, naming each by its place in the
    // list, so a placement can tie them to the members it builds.
    const raw = group.members.map((member) => toRaw(member));
    const measurements = MeasureTool.exportFor(
      group.members,
      (item) => ({ index: raw.indexOf(toRaw(item)) }),
    );
    if (measurements) structure.measurements = measurements;
    this.structureLibrary[group.name] = structure;
    if (typeof window !== 'undefined' && window.library) {
      // Only this structure is written, so a bad write cannot take the rest of
      // the library with it.
      await window.library.write('structures', group.name, JSON.stringify(structure, null, 2));
    }
    return group.name;
  }

  /**
   * Places a saved structure as a new group of new fixtures.
   *
   * Each member is created and patched exactly as adding it by hand would be,
   * which is why the structure carries no addresses: they are found free at
   * the moment of placing, so the same structure can be put down repeatedly.
   *
   * @public
   * @async
   * @param {String} name structure to place
   * @param {Object} placement world position and rotation, in metres and radians
   * @returns {Object|null} the group created, or null when the structure is
   *   unknown or none of its members could be resolved
   */
  async placeStructure(name, placement = {}) {
    const definition = this.structureLibrary[name];
    if (!definition) return null;

    const origin = new THREE.Matrix4().compose(
      new THREE.Vector3(
        (placement.position || {}).x || 0,
        (placement.position || {}).y || 0,
        (placement.position || {}).z || 0,
      ),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(
        (placement.rotation || {}).x || 0,
        (placement.rotation || {}).y || 0,
        (placement.rotation || {}).z || 0,
      )),
      new THREE.Vector3(1, 1, 1),
    );

    const world = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const euler = new THREE.Euler();
    const members = [];
    // By the definition's own order, which its measurements name members by;
    // a fixture whose profile cannot be found leaves its place empty.
    const byIndex = [];

    // Every distinct profile the definition needs, warmed before the loop and
    // all at once. With the cache above this is what makes the loop's awaits
    // microtasks without exception: one yield here rather than one per member,
    // and the distinct profiles fetched together rather than in series.
    const wanted = new Set();
    const isObject = (member) => member.kind === SCENE_ITEM_KINDS.OBJECT;
    if (definition.members.some(isObject)) await this.preloadObjectLibrary();
    const distinct = definition.members.filter((member) => {
      if (isObject(member)) return false;
      const key = `${member.manufacturer}/${member.model}`;
      if (wanted.has(key)) return false;
      wanted.add(key);
      return true;
    });
    await Promise.all(
      distinct.map((member) => this.resolveFixture(member.manufacturer, member.model)),
    );

    for (let i = 0; i < definition.members.length; i += 1) {
      const member = definition.members[i];
      if (isObject(member)) {
        world.multiplyMatrices(origin, new THREE.Matrix4().fromArray(member.transform));
        world.decompose(position, quaternion, scale);
        euler.setFromQuaternion(quaternion);
        // A missing library model still arrives, unresolved, as it does when
        // a show is opened without it.
        const object = new SceneObject({
          model: member.primitive ? undefined : member.model,
          primitive: member.primitive || null,
          name: member.name || member.model || 'object',
          position: { x: position.x, y: position.y, z: position.z },
          rotation: { x: euler.x, y: euler.y, z: euler.z },
          scale: member.scale,
          colors: member.colors,
        });
        // eslint-disable-next-line no-await-in-loop
        await object.attach(member.primitive
          ? null
          : (this.objectLibrary[foldModelKey(member.model)] || null));
        Show.joinNumbered(this.objects, [object]);
        members.push(object);
        byIndex[i] = object;
        // eslint-disable-next-line no-continue
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const resolved = await this.resolveFixture(member.manufacturer, member.model);
      if (resolved) {
        world.multiplyMatrices(origin, new THREE.Matrix4().fromArray(member.transform));
        world.decompose(position, quaternion, scale);
        euler.setFromQuaternion(quaternion);

        const fixture = this.fixturePool.addRaw({
          OFLData: resolved.OFLData,
          fixtureType: resolved.fixtureType,
          manufacturer: member.manufacturer,
          model: member.model,
          category: resolved.category,
          name: resolved.name,
          mode: member.mode,
          universeAligned: !!member.universeAligned,
          position: { x: position.x, y: position.y, z: position.z },
          rotation: {
            x: THREE.MathUtils.radToDeg(euler.x),
            y: THREE.MathUtils.radToDeg(euler.y),
            z: THREE.MathUtils.radToDeg(euler.z),
          },
        });

        const address = PatchSingleton.findFreeAddress(
          fixture.channels.length,
          1,
          0,
          fixture.alignmentPixelSize,
        );
        if (address > -1) {
          fixture.address = address;
          PatchSingleton.patchFixture(fixture);
        }
        members.push(fixture);
        byIndex[i] = fixture;
      }
    }

    if (!members.length) return null;
    // The placement origin, not the centre of mass: the definition's transforms
    // were authored around it, so that is where the structure's handle belongs.
    const structure = this.createStructure(members, definition.name, {
      position: placement.position,
      rotation: placement.rotation,
    });
    this.seatStructure(structure, placement.position || {});
    // After seating, so they are tied to the members where they now stand.
    MeasureTool.append(definition.measurements, ({ index }) => byIndex[index] || null);
    return structure;
  }

  /**
   * Moves a freshly placed structure so it stands on the point it was given.
   *
   * A definition is authored around its centre of mass, because that is where
   * a group puts its handle for dragging. Placed from there, anything with
   * height arrives half underground -- a dodecahedron reaching 1.17 m either
   * side of its origin loses its lower half to the floor.
   *
   * So the insertion point is the bottom of the geometry, centred in X and Y:
   * ask for z 0 and it stands on the floor, ask for z 6 and it hangs with its
   * underside at 6 m. Derived rather than stored, so it holds for every
   * structure file whatever wrote it.
   *
   * @public
   * @param {Object} structure the structure to seat
   * @param {Object} at where its base should end up
   */
  // eslint-disable-next-line class-methods-use-this
  seatStructure(structure, at) {
    const box = new THREE.Box3();
    structure.members.forEach((member) => {
      const model = member._3DModel;
      if (model && model.expandGeometryBounds) model.expandGeometryBounds(box);
      else if (model && model.expandBounds) model.expandBounds(box);
    });
    if (box.isEmpty()) return;
    const centre = box.getCenter(new THREE.Vector3());
    const origin = structure.position;
    // The gap between where the base sits and where it was asked to sit.
    structure.position = {
      x: origin.x + ((at.x || 0) - centre.x),
      y: origin.y + ((at.y || 0) - centre.y),
      z: origin.z + ((at.z || 0) - box.min.z),
    };
  }

  /**
   * A fixture's profile by key, from whichever kind of file holds it.
   *
   * @public
   * @async
   * @param {String} manufacturer
   * @param {String} model
   * @returns {Promise<Object|null>} `{ OFLData, fixtureType, category, name }`
   *   with one of the two set, or null when neither is found
   */
  async resolveFixture(manufacturer, model) {
    const moved = movedProfile(manufacturer, model);
    const key = `${moved.manufacturer}/${moved.model}`;
    if (this.gdtfEntry(key)) {
      const fixtureType = await this.loadGdtfType(key);
      if (!fixtureType) return null;
      return {
        OFLData: null,
        fixtureType,
        category: headInputs(fixtureType, fixtureType.modes[0] || { channels: [] }).category,
        name: fixtureType.name,
      };
    }
    const OFLData = await this.resolveProfile(manufacturer, model);
    if (!OFLData) return null;
    return {
      OFLData, fixtureType: null, category: OFLData.categories[0], name: OFLData.name,
    };
  }

  /**
   * A GDTF fixture by key: the open document's copy, else the library's.
   *
   * @public
   * @param {String} key `<manufacturer folder>/<file stem>`
   * @returns {Object|null} `{ entry, carried }`
   */
  gdtfEntry(key) {
    const carried = (this.collected.gdtf || []).find((e) => e.key === key);
    if (carried) return { entry: carried, carried: true };
    const own = this.gdtfFixtures.find((e) => e.key === key);
    return own ? { entry: own, carried: false } : null;
  }

  /**
   * Reads a GDTF fixture type, once per key.
   *
   * Fetched as `library://`, which streams the file rather than carrying
   * megabytes across IPC, and parsed with the page's own XML parser.
   *
   * @public
   * @async
   * @param {String} key
   * @returns {Promise<Object|null>} the fixture type, or null when it cannot be read
   */
  async loadGdtfType(key) {
    if (this.gdtfTypes.has(key)) return this.gdtfTypes.get(key);
    const found = this.gdtfEntry(key);
    if (!found || typeof fetch === 'undefined' || typeof DOMParser === 'undefined') return null;
    let host = 'profiles';
    if (found.carried) host = 'projectprofiles';
    else if (found.entry.shipped) host = 'shippedprofiles';
    const path = found.entry.file.split('/').map(encodeURIComponent).join('/');
    try {
      const response = await fetch(`library://${host}/${path}`);
      if (!response.ok) throw new Error(`${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const parseXml = (text) => new DOMParser().parseFromString(text, 'text/xml');
      const { fixtureType, files, problems } = readGdtf(bytes, { parseXml });
      // eslint-disable-next-line no-console
      if (problems.length) console.warn(`[gdtf] ${key}: ${problems.join('; ')}`);
      // The wheel slots' own pictures, as URLs the panels can show. Made once
      // per type, which every fixture of it shares.
      const urlOf = (image) => URL.createObjectURL(new Blob([image.bytes], { type: image.mime }));
      fixtureType.wheelImages = new Map([...wheelImages(fixtureType, files)]
        .map(([name, image]) => [name, urlOf(image)]));
      // The body its meshes make, shared by every fixture of the type. A file
      // whose meshes cannot be read keeps the shipped body.
      try {
        // A laser is drawn by the laser renderer, standing; a light by the head.
        // A laser known only by its channels has no frame its model is drawn
        // in for a laser, so it takes the box.
        if (isLaserType(fixtureType)) {
          fixtureType.body = null;
          fixtureType.laserBody = laserGeometry(fixtureType)
            ? await laserBody(fixtureType, files) : null;
        } else {
          fixtureType.body = await buildBody(fixtureType, files);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[gdtf] ${key}: body not built: ${err.message}`);
        fixtureType.body = null;
      }
      markRaw(fixtureType);
      this.gdtfTypes.set(key, fixtureType);
      return fixtureType;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[gdtf] cannot read ${key}: ${err.message}`);
      this.gdtfTypes.set(key, null);
      return null;
    }
  }

  /**
   * The profile behind a manufacturer and model, generated or from the library.
   *
   * @public
   * @async
   * @param {String} manufacturer
   * @param {String} model
   * @returns {Object|null} profile data
   */
  async resolveProfile(manufacturer, model) {
    const key = `${manufacturer}/${model}`;
    const local = this.localProfile(key);
    if (local) return JSON.parse(JSON.stringify(local));
    // The same cache the load path fills, for a reason that has nothing to do
    // with the cost of a fetch. A profile is ~0.5 ms to fetch; what it costs
    // is the *await*. An await on real I/O is a macrotask, so the renderer
    // gets to paint between one member of a structure and the next -- and
    // while fixtures are arriving a frame is not cheap: 542 ms rising to
    // 2.9 s, growing 64 ms with every fixture already placed. A 115-member
    // structure placed that way pays 115 ever-slower frames, nearly five
    // minutes, for 48 ms of actual work.
    //
    // Served from here the await resolves immediately, which is a microtask,
    // and a microtask cannot paint. The loop runs to the end and the renderer
    // sees the finished structure once, as it does when a show loads.
    if (fixtureDataCache[key]) return JSON.parse(fixtureDataCache[key]);
    // Validated, not merely fetched -- see `fetchProfile`. Callers test this
    // for null and skip; a page of HTML would pass that test and then die
    // somewhere with no idea which profile it was looking at.
    const profile = await fetchProfile(key);
    // Parsed back out on every read, so each caller gets its own copy to
    // mutate.
    if (profile) fixtureDataCache[key] = JSON.stringify(profile);
    return profile;
  }

  /**
   * Rebuilds placed structures and their membership from a showfile.
   *
   * Runs after the fixtures exist, since a structure holds its members rather
   * than their ids. A showfile without structures is simply one where nothing
   * was structured, so this is safe on older files.
   *
   * Membership is re-taken with `add`, which recaptures each member's relative
   * transform from where it now stands. That is deliberate: the members were
   * saved at absolute coordinates, so the file already agrees with itself and
   * the relative transforms fall straight back out of it.
   *
   * @public
   * @param {Object} showData raw showfile contents
   */
  /**
   * Rebuilds the models placed in a show.
   *
   * Each object names a library key, and the key is resolved here rather than
   * stored: the file is a reference, so a show opened on another machine finds
   * whatever that machine has. A model that cannot be found leaves its object
   * in the show marked unresolved rather than dropping it -- a missing file
   * should not quietly delete what was built with it, and the alternative is
   * a show that silently loses a truss.
   *
   * Geometry loads in the background. Nothing waits on it: a hundred objects
   * are a hundred rows in an instanced buffer and appear as they arrive.
   *
   * @public
   * @async
   * @param {Object} showData raw showfile contents
   */
  async prepareObjects(showData) {
    const records = showData.objects || [];
    const made = records.map((data) => new SceneObject(data));
    made.forEach((object, i) => restoreListOrder(object, records[i]));
    // By the id the record was saved or copied with, for the structures that
    // name their members by it.
    this.loadedObjectsById = new Map();
    records.forEach((data, i) => {
      const id = data.sourceId !== undefined ? data.sourceId : data.id;
      if (id !== undefined) this.loadedObjectsById.set(id, made[i]);
    });
    Show.joinNumbered(this.objects, made);
    if (!made.length) return made;
    await this.preloadObjectLibrary();
    // Awaited, all of them. Fired and left to land, the load would report
    // itself finished while geometry was still arriving: a clear in between
    // would remove placements that did not exist yet, and their meshes would
    // land in a scene nothing tracks them in. The check below needs it too --
    // `unresolved` is set inside `attach`, so it means nothing until every
    // object has answered.
    await Promise.all(made.map(
      (object) => object.attach(this.objectLibrary[foldModelKey(object.model)] || null),
    ));
    const missing = made.filter((object) => object.unresolved);
    if (missing.length) {
      // Named, because "an object is missing" is not actionable and the file
      // name is: it is in the user's own library folder.
      // eslint-disable-next-line no-console
      console.warn(`[show] ${missing.length} object(s) reference models this machine does not have: ${[...new Set(missing.map((o) => o.model))].join(', ')}`);
    }
    return made;
  }

  /**
   * Reads what models the library offers, keyed as objects reference them.
   *
   * @public
   * @async
   */
  async preloadObjectLibrary() {
    if (!window.library || !window.library.objects) return;
    try {
      const listed = await window.library.objects();
      // Keyed by the library key, which is `folder/name` for anything in a
      // folder. It has to be the path: two folders may each hold a `truss`,
      // and a show that stored only the name could not say which it meant.
      //
      // The bare name is registered too, but never over a real key, so a show
      // that names a model without its folder still resolves. An object that
      // was at the root and has since been filed into a folder still finds
      // itself; one whose name is ambiguous resolves to the first listed,
      // which is better than resolving to nothing.
      //
      // Registered under a folded key, and looked up the same way. A library
      // key is a file name, and on Windows a file's capitalisation can change
      // without anything looking like it changed -- an exact string compare
      // would let `Audio/Sub_Speaker` miss `Audio/Sub_speaker` and leave every
      // object placed from it unresolved. Two copies of a model, one in a
      // development checkout and one in an installed build, can differ in
      // case alone.
      this.objectLibrary = listed.reduce((all, model) => {
        all[foldModelKey(model.key)] = model;
        const name = foldModelKey(model.name);
        if (!all[name]) all[name] = model;
        return all;
      }, {});
    } catch (err) {
      this.objectLibrary = {};
    }
  }

  /**
   * Puts a model in the scene as an item of its own.
   *
   * @public
   * @async
   * @param {Object} descriptor a library entry
   * @param {Object} [transform] `{ position, rotation, scale }`
   * @returns {Promise<Object>} the object
   */
  async placeObject(descriptor, transform = {}, { inline: created = false } = {}) {
    // Two kinds of thing arrive here. A **library entry** is referenced by
    // key and shares its geometry with every other placement of it; its
    // shape is a definition and a placement cannot change it. A **created**
    // object arrives from the create dialog as parameters and carries them
    // itself, so it stays editable and belongs to this show alone -- see
    // `SceneObject`.
    //
    // Which one it is has to be said by the caller, not read off the data.
    // A saved primitive's library entry carries its type, size and colour
    // too, so "has parameters" once made every Stage Table placed from the
    // library an editable cube that happened to start at the saved size --
    // the opposite of what saving it had just promised.
    const inline = created && descriptor && descriptor.primitive
      ? { ...descriptor.primitive, type: descriptor.primitive.type || descriptor.type }
      : null;
    const object = new SceneObject({
      // The key, not the name: it is what the showfile stores and what
      // `objectLibrary` is keyed by.
      model: inline ? undefined : (descriptor.key || descriptor.name),
      primitive: inline,
      name: descriptor.name,
      position: transform.position,
      rotation: transform.rotation,
      scale: transform.scale,
    });
    await object.attach(inline ? null : descriptor);
    Show.joinNumbered(this.objects, [object]);
    return object;
  }

  /**
   * Adds a created object to the scene from the parameters the dialog gathered.
   *
   * The library is not involved. Everything the object is, it carries.
   *
   * @public
   * @async
   * @param {Object} params `{ type, name, size, color }`
   * @param {Object} [transform] `{ position, rotation, scale }`
   * @returns {Promise<Object>} the object
   */
  async createObject(params, transform = {}) {
    const primitive = {
      type: params.type,
      size: { ...(params.size || {}) },
      color: params.color,
    };
    return this.placeObject({ name: params.name, primitive }, transform, { inline: true });
  }

  /**
   * Makes a created object a reference to the library entry it was just saved
   * as.
   *
   * The library is re-read first, because the entry did not exist when the
   * catalogue was last listed, and the object is then re-pointed at it -- see
   * `SceneObject.adoptLibraryModel` for what that means for its parameters.
   *
   * @public
   * @async
   * @param {SceneObject} object the created object that was saved
   * @param {String} key the library key it was saved under
   * @returns {Promise<Boolean>} whether the object now draws from the library
   */
  async adoptObjectIntoLibrary(object, key) {
    await this.preloadObjectLibrary();
    const descriptor = this.objectLibrary[foldModelKey(key)] || null;
    if (!descriptor) return false;
    // The entry may have just been overwritten. Its old build is cached under
    // the same key, and the renderer answers a key from its cache -- so every
    // placement of it, this object included, would go on drawing the old shape
    // until a restart. Dropped, and every other placement of it redrawn from
    // the entry as it now is. For a brand new entry nothing is cached and no
    // placement references it, so this does nothing.
    SceneObjects.forget(descriptor.key || key);
    const others = this.objects.filter((item) => item !== object && !item.isInline
      && foldModelKey(item.model) === foldModelKey(key));
    await Promise.all(others.map((item) => item.reattach(descriptor)));
    return object.adoptLibraryModel(key, descriptor);
  }

  /**
   * The library entry a placed object references, or null for a created
   * object or one whose entry is missing.
   *
   * @public
   * @param {SceneObject} object
   * @returns {Object|null}
   */
  objectLibraryEntry(object) {
    if (!object || object.isInline || !object.model) return null;
    return this.objectLibrary[foldModelKey(object.model)] || null;
  }

  /**
   * Makes a placement of a library shape into a created object of this show.
   *
   * The opposite of `adoptObjectIntoLibrary`. See
   * `SceneObject.makeUnique`.
   *
   * @public
   * @async
   * @param {SceneObject} object
   * @returns {Promise<Boolean>} whether the object is now its own
   */
  async makeObjectUnique(object) {
    const entry = this.objectLibraryEntry(object);
    if (!entry || !entry.primitive) return false;
    return object.makeUnique(entry);
  }

  /**
   * Puts a copied chunk into the show, beside what is already there.
   *
   * This is `loadShowData` without the clear: the same four `prepare` steps,
   * in the same order, on a show that is already standing. Nothing here knows
   * how to build a fixture or resolve a structure's members -- that is the
   * point. `prepareFixtures` reassigns ids and leaves behind the index from
   * old id to new instance, and the structures and groups in the chunk resolve
   * their members through it exactly as a load does.
   *
   * What paste has to decide for itself is the two things a copy cannot keep:
   *
   * - **Addresses.** Every pasted fixture is patched at the next free block
   *   that fits it, respecting universe alignment, the way placing a structure
   *   from the library already does. Sharing an address with the original is a
   *   real thing to want and a deliberate one; it is not what a copy means.
   *   A fixture that finds no room arrives unpatched rather than not arriving.
   * - **Names.** Each copy takes the nearest free name to the one it came
   *   from, so `Front truss` pastes as `Front truss 2`.
   *
   * Everything lands exactly where it was copied from. A copy on top of its
   * original looks like nothing happened until it is moved, which is why the
   * caller selects what this returns: the gizmo is then already holding the
   * copies, and the first drag separates them.
   *
   * @public
   * @async
   * @param {Object} chunk `{ fixtures, objects, structures, groups }`
   * @returns {Array} the items created, in list order
   */
  async pasteItems(chunk) {
    if (!chunk) return [];
    // Cloned because `prepareFixtures` writes the resolved profile into each
    // record it is given. Handed the clipboard's own chunk it would fill it
    // with profiles, and every later paste would carry them.
    const data = JSON.parse(JSON.stringify(chunk));
    // A container's id is its identity in this show, and the copy is not the
    // same item -- left in place it would collide with what it was copied
    // from. Members are named by the *source* ids on purpose: that is what the
    // load index maps to the new instances.
    const fresh = (records) => (records || []).map(({ id, ...rest }) => rest);

    // Names travel with the copies; each is given the lowest free instance
    // number under its name as it joins the show -- see `joinNumbered`.
    await this.prepareFixtures({ fixtures: data.fixtures || [] });
    const fixtures = [...this.loadedFixturesById.values()];
    fixtures.forEach((fixture) => {
      // With the patch not strict, a copy keeps the address it was copied with.
      if (!PatchSingleton.strict) {
        PatchSingleton.patchFixture(fixture);
        return;
      }
      const address = PatchSingleton.findFreeAddress(
        fixture.channels.length,
        1,
        0,
        fixture.alignmentPixelSize,
      );
      if (address > -1) {
        fixture.address = address;
        PatchSingleton.patchFixture(fixture);
      }
    });

    const groups = this.prepareGroups({ groups: fresh(data.groups) });

    // Objects before structures, which may hold them. A copy gets a new id,
    // and keeps the one it was copied from as `sourceId`, which is what a
    // pasted structure names its members by.
    const objects = await this.prepareObjects({
      objects: (data.objects || []).map(({ id, ...rest }) => ({ ...rest, sourceId: id })),
    });

    const structures = this.prepareStructures({ structures: fresh(data.structures) });

    // Measurements tied only to the copied items, onto the copies: the source
    // ids they name are what the two load indexes map to the new instances.
    MeasureTool.append(data.measurements, ({ kind, id }) => {
      if (kind === SCENE_ITEM_KINDS.OBJECT) return this.loadedObjectsById.get(id);
      if (kind === SCENE_ITEM_KINDS.FIXTURE) return this.loadedFixturesById.get(id);
      return null;
    });

    // A fixture inside a pasted structure or group is not a loose item, and
    // handing it back would put the gizmo on the members as well as on the
    // thing that holds them.
    const loose = fixtures.filter((fixture) => !fixture.structure && !fixture.group);
    return [...loose, ...objects, ...structures, ...groups];
  }

  /**
   * Takes an object out of the show.
   *
   * @public
   * @param {Object} object the object to remove
   * @returns {Boolean} whether it was there to remove
   */
  removeObject(object) {
    const index = this.objects.indexOf(object);
    if (index === -1) return false;
    MeasureTool.forgetItem(object);
    object.dispose();
    this.objects.splice(index, 1);
    return true;
  }

  prepareStructures(showData) {
    const made = (showData.structures || []).map((structureData) => {
      const structure = new Structure(structureData);
      restoreListOrder(structure, structureData);
      (structureData.members || []).forEach((ref) => {
        // An object member is `{ kind, id }`, resolved through the objects
        // just loaded.
        if (ref && typeof ref === 'object') {
          if (ref.kind !== SCENE_ITEM_KINDS.OBJECT) return;
          const object = (this.loadedObjectsById || new Map()).get(ref.id);
          if (object) structure.add(object);
          return;
        }
        // Resolved through the load index rather than the pool: addRaw hands
        // out fresh ids, so a saved member id means nothing once a fixture has
        // been deleted and the rest have shuffled down.
        const fixture = this.loadedFixturesById.get(ref);
        if (fixture) structure.add(fixture);
      });
      return structure;
    });
    Show.joinNumbered(this.structures, made);
    return made;
  }

  /**
   * Makes one scene item out of several.
   *
   * Without an origin the structure sits at the centre of what it holds, which
   * is what making one out of a selection wants. Placing a saved definition
   * passes the origin instead, so the stamp keeps the point its transforms
   * were authored around rather than drifting to the centre of mass.
   *
   * @public
   * @param {Array} [members] items to take ownership of
   * @param {String} [name] display name
   * @param {Object} [origin] {position, rotation} in metres and radians
   * @returns {Object} the new structure
   */
  createStructure(members = [], name = undefined, origin = null) {
    const structure = new Structure({
      name: (name || '').trim() || 'untitled',
      position: (origin || {}).position,
      rotation: (origin || {}).rotation,
    });
    members.forEach((member) => structure.add(member));
    if (members.length && !origin) structure.centreOnMembers();
    Show.joinNumbered(this.structures, [structure]);
    return structure;
  }

  /**
   * Explodes a structure, leaving what it held in the scene.
   *
   * The members keep the coordinates they already occupied -- nothing moves,
   * they simply become items in their own right. This is the only edit a
   * placed structure has: there is no reaching into one to change a member,
   * because a structure is a stamp rather than a live copy of a definition.
   *
   * @public
   * @param {Object} structure structure to explode
   * @returns {Array} the items it released
   */
  explodeStructure(structure) {
    const index = this.structures.indexOf(structure);
    if (index === -1) return [];
    const released = structure.release();
    structure.dispose();
    this.structures.splice(index, 1);
    return released;
  }

  /**
   * Deletes a structure and everything in it.
   *
   * Keeping the contents is a different intention, and has its own word:
   * `explodeStructure`.
   *
   * @public
   * @param {Object} structure structure to remove
   */
  deleteStructure(structure) {
    const index = this.structures.indexOf(structure);
    if (index === -1) return;
    structure.release().forEach((member) => {
      if (kindOf(member) === SCENE_ITEM_KINDS.OBJECT) {
        this.removeObject(member);
        return;
      }
      const handle = this.fixturePool.findFromId(member.id);
      if (!handle) return;
      MeasureTool.forgetItem(handle);
      PatchSingleton.unpatchFixture(handle);
      this.fixturePool.delete(handle, true);
    });
    structure.dispose();
    this.structures.splice(index, 1);
  }

  /**
   * Creates a group, optionally taking members straight away.
   *
   * A group with members sits at their centre; an empty one sits at the scene
   * origin, and will re-centre itself once it has something in it.
   *
   * @public
   * @param {Array} [members] objects to take ownership of
   * @param {String} [name] display name
   * @returns {Object} the new group
   */
  createGroup(members = [], name = undefined) {
    const group = new Group({ name });
    members.forEach((member) => group.add(member));
    if (members.length) group.centreOnMembers();
    Show.joinNumbered(this.groups, [group]);
    return group;
  }

  /**
   * Dissolves a group, leaving its members where they are at the root.
   *
   * @public
   * @param {Object} group group to remove
   */
  deleteGroup(group) {
    const index = this.groups.indexOf(group);
    if (index === -1) return;
    // Deleting a group deletes what is in it. Dissolving a group and keeping
    // its fixtures is a different intention, and has its own word.
    [...group.members].forEach((member) => {
      group.remove(member);
      const handle = this.fixturePool.findFromId(member.id);
      if (!handle) return;
      MeasureTool.forgetItem(handle);
      PatchSingleton.unpatchFixture(handle);
      this.fixturePool.delete(handle, true);
    });
    group.dispose();
    this.groups.splice(index, 1);
  }

  /**
   * Dissolves a group, leaving its fixtures in the show.
   *
   * @public
   * @param {Object} group group to dissolve
   */
  ungroup(group) {
    const index = this.groups.indexOf(group);
    if (index === -1) return;
    [...group.members].forEach((member) => group.remove(member));
    group.dispose();
    this.groups.splice(index, 1);
  }

  /**
   * Moves an object into a group, or out to the root when group is null.
   *
   * @public
   * @param {Object} member object to move
   * @param {Object|null} group destination, or null for the root
   */
  // eslint-disable-next-line class-methods-use-this
  moveToGroup(member, group) {
    if (!member) return;
    if (member.group) member.group.remove(member);
    if (group) group.add(member);
  }

  /**
   * Sets the order of the item list, first to last.
   *
   * @public
   * @param {Array} items fixtures, objects, structures and groups, in order
   */
  setListOrder(items) {
    items.forEach((item, i) => {
      item.listOrder = i;
    });
    this.touch();
  }

  /**
   * Lists the GDTF fixtures in the user's library.
   *
   * @public
   * @async
   */
  async preloadGdtfFixtures() {
    if (typeof window === 'undefined' || !window.library || !window.library.gdtfList) return;
    this.gdtfFixtures = await window.library.gdtfList();
    // The user's gobo and disc images, for placements that swap them in.
    if (window.library.gobos) UserGobos.set(await window.library.gobos());
  }

  /**
   * Lists the library's GDTF fixtures again, after an import.
   *
   * @public
   * @async
   */
  async refreshGdtfFixtures() {
    // An import may have replaced a file under a key already read.
    this.gdtfTypes = new Map();
    await this.preloadGdtfFixtures();
    this.refreshFixtureList();
  }

  /**
   * Loads the user's own generic fixtures.
   *
   * A show that uses one and cannot find it will not load its fixtures, so
   * these are read before any show is.
   *
   * @public
   * @async
   */
  async preloadGeneratedProfiles() {
    if (typeof window === 'undefined' || !window.library) return;
    const stored = await window.library.readAll('profiles');
    // Bars are stored without the channels their geometry implies; the parser
    // needs them, so they are rebuilt here. Profiles that carry their own come
    // back untouched.
    this.generatedProfiles = Object.fromEntries(
      Object.entries(stored || {}).map(([key, profile]) => [key, expandLedBarProfile(profile)]),
    );
  }

  /**
   * A profile held locally, wherever it lives: this show's own definitions
   * first, then what the open document carries, then the library's generated
   * profiles. Null for a shipped OFL profile, which is fetched.
   *
   * The one lookup both the load path and the Add-to-Show list use, so the
   * two cannot disagree about which wins when a show and the library both
   * hold a definition of the same name -- the show does.
   *
   * @public
   * @param {String} key `manufacturer/model`
   * @returns {Object|null}
   */
  localProfile(key) {
    return this.definitions.get(key)
      || this.collected.profiles[key]
      || this.generatedProfiles[key]
      || null;
  }

  /**
   * Whether a definition belongs to this show rather than the library.
   *
   * @public
   * @param {String} key
   * @returns {Boolean}
   */
  isShowDefinition(key) {
    return this.definitions.has(key);
  }

  /**
   * Builds a generic fixture definition and adds it to **this show**.
   *
   * Nothing is written to the library. A definition lives with the show until
   * the user saves it from the fixture's Model widget, and disappears when the
   * last fixture using it does -- see `definition_store.js`. That is the same
   * bargain a structure makes, and it keeps experiments out of the library.
   *
   * A definition is made with one name, the working name it is found by in
   * the "This show" folder. A manufacturer and a model become its identity
   * when it is saved to the library, which is when they matter.
   *
   * @public
   * @param {String} name the working name the user chose
   * @param {Object} params geometry, wiring and controls
   * @param {String} kindId which kind builds it -- see `generic/fixture_kind.js`
   * @returns {String} the definition's key
   */
  createDefinition(name, params, kindId) {
    const kind = kindById(kindId);
    if (!kind) throw new Error(`No fixture kind called "${kindId}"`);
    const key = showKey(name);
    const profile = kind.buildProfile(params);
    profile.name = name;
    this.definitions.add(key, profile);
    this.refreshFixtureList();
    return key;
  }

  /**
   * Drops the show's definitions nothing places any more.
   *
   * Called before the show is written and after a fixture is deleted, so a
   * definition created and never placed, or whose last instance was removed,
   * does not outlive its use.
   *
   * @public
   * @returns {DefinitionStore} the store, for chaining into `toJSON`
   */
  pruneDefinitions() {
    const inUse = this.fixturePool.fixtures.map((f) => `${f.manufacturer}/${f.model}`);
    if (this.definitions.prune(inUse).length) this.refreshFixtureList();
    return this.definitions;
  }

  /**
   * Moves one of this show's definitions into the library, under the
   * manufacturer and model it is given here.
   *
   * The deliberate act, and the moment a definition gets its identity: it was
   * made under a working name, and this is where a manufacturer and a model
   * are chosen for it. Afterwards the show is in the state it would be in had
   * the fixture been placed from the library: the definition is gone from the
   * show, the library has it, and every instance is re-pointed at the new key
   * as a library reference. A library entry of that name already existing is
   * refused rather than overwritten -- the library is keyed by name and a
   * silent overwrite would change fixtures in other shows.
   *
   * @public
   * @async
   * @param {String} key the definition's key in this show
   * @param {String} manufacturer the library folder it goes under
   * @param {String} model its name there
   * @returns {Object} `{ ok, reason, key }`, the new key on success
   */
  async saveDefinitionToLibrary(key, manufacturer, model) {
    const profile = this.definitions.get(key);
    if (!profile) return { ok: false, reason: 'This fixture is not a definition of this show.' };
    const maker = String(manufacturer || '').trim();
    const name = String(model || '').trim();
    if (!maker || !name) return { ok: false, reason: 'A manufacturer and a model are needed.' };
    if (maker === SHOW_SCOPE || maker.includes('/') || name.includes('/')) {
      return { ok: false, reason: 'A manufacturer or model cannot contain a slash.' };
    }
    const target = `${maker}/${name}`;
    if (this.generatedProfiles[target] || (target !== key && this.definitions.has(target))) {
      return { ok: false, reason: `The library already has a "${target}". Choose another name to save it.` };
    }
    profile.name = name;
    if (typeof window !== 'undefined' && window.library) {
      // A bar is written without its channel list, as the store does -- see
      // `definition_store.js` for why.
      await window.library.write(
        'profiles',
        target,
        JSON.stringify(withoutLedBarChannels(profile), null, 2),
      );
    }
    this.generatedProfiles[target] = profile;
    this.definitions.remove(key);
    // Every instance follows the definition to its new key.
    if (target !== key) {
      this.fixturePool.fixtures.forEach((fixture) => {
        if (fixture.profileKey !== key) return;
        fixture.manufacturer = maker;
        fixture.model = name;
      });
    }
    this.refreshFixtureList();
    return { ok: true, key: target };
  }

  /**
   * The manufacturers a definition can be saved under: every folder the
   * library and the shipped profiles have, the ones this machine's own
   * definitions were saved under, and Generic, for a fixture whose maker is
   * nobody in particular. Sorted, Generic first.
   *
   * @public
   * @returns {Array} `[{ slug, name }]`, the folder and what it is called
   */
  manufacturerChoices() {
    const seen = new Map();
    const offer = (slug) => {
      if (!slug || slug === SHOW_SCOPE || seen.has(slug)) return;
      seen.set(slug, { slug, name: this.manufacturerName(slug) });
    };
    (this.rawOFLFixtures || []).forEach((entry) => {
      if (!entry.local) offer(entry.name);
    });
    Object.keys(this.generatedProfiles).forEach((key) => offer(key.split('/')[0]));
    const list = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
    return [{ slug: 'Generic', name: 'Generic' }, ...list.filter((m) => m.slug !== 'Generic')];
  }

  /**
   * Profiles the open document carries that neither the library nor the
   * shipped set has, keyed `manufacturer/model`.
   *
   * @private
   * @returns {Object}
   */
  collectedOnlyProfiles() {
    const shipped = new Set((this.shippedFixtureList || [])
      .flatMap((entry) => (entry.fixtures || [])
        .map((fixture) => `${entry.name}/${String(fixture.file).replace(/\.json$/i, '')}`)));
    return Object.fromEntries(Object.entries(this.collected.profiles)
      .filter(([key]) => !this.generatedProfiles[key] && !shipped.has(key)));
  }

  /**
   * Re-lays the library index over the current generated profiles.
   *
   * @public
   */
  refreshFixtureList() {
    // This show's own definitions first -- they are what the user just made --
    // then the library's, then the shipped profiles with GDTF fixtures filed
    // among them.
    const { folders, unfiled } = this.withGdtfFixtures(this.shippedFixtureList || []);
    this.rawOFLFixtures = [
      ...this.definitions.list(),
      ...this.generatedFixtureList(),
      ...unfiled,
      ...folders,
    ];
  }

  /**
   * The shipped index with the GDTF fixtures filed in it.
   *
   * A GDTF fixture joins its manufacturer's folder -- the one whose name its
   * own begins with, since GDTF says "Martin Professional" where the index
   * says "Martin" -- and takes the place of a shipped profile of the same
   * name, which GDTF supersedes. A manufacturer the index does not have gets
   * a folder of its own. Rebuilt from the untouched index every time, so a
   * GDTF file removed brings its OFL profile back.
   *
   * @public
   * @param {Array} shipped the shipped index
   * @returns {{folders: Array, unfiled: Array}} the index's folders, and
   *   folders for manufacturers it lacks
   */
  withGdtfFixtures(shipped) {
    const known = new Set(this.gdtfFixtures.map((entry) => entry.key));
    const carried = (this.collected.gdtf || []).filter((entry) => !known.has(entry.key));
    const all = [...this.gdtfFixtures, ...carried];
    const fold = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const folders = shipped.map((folder) => ({
      ...folder, fixtures: [...(folder.fixtures || [])],
    }));
    const named = folders.map((folder) => ({
      folder, name: fold(this.manufacturerName(folder.name)),
    })).sort((a, b) => b.name.length - a.name.length);
    const unfiled = new Map();
    all.forEach((entry) => {
      const maker = fold(entry.manufacturer);
      const match = named.find(({ name }) => name && (maker === name || maker.startsWith(`${name} `)));
      // Typed and marked as an OFL profile is: GDTF draws moving heads, static
      // lights and lasers so far, and the rest patch and draw nothing.
      const row = {
        file: entry.key,
        name: entry.name,
        manufacturer: entry.key.split('/')[0],
        category: entry.category || 'unreadable file',
        supported: ['Moving Head', 'Static', 'Laser'].includes(entry.category),
        gdtf: true,
        shipped: !!entry.shipped,
        fixtureTypeId: entry.fixtureTypeId || null,
        revision: entry.revision || null,
      };
      if (match) {
        const model = fold(entry.name);
        match.folder.fixtures = match.folder.fixtures
          .filter((f) => f.gdtf || fold(f.name) !== model);
        match.folder.fixtures.push(row);
      } else {
        if (!unfiled.has(entry.manufacturer)) {
          unfiled.set(entry.manufacturer, {
            name: entry.manufacturer, generated: true, gdtf: true, fixtures: [],
          });
        }
        unfiled.get(entry.manufacturer).fixtures.push(row);
      }
    });
    // Revisions kept side by side share a name; each says which it is, by
    // its revision, or by its file where the revisions say the same.
    const told = (rows) => {
      const sameName = new Map();
      rows.filter((row) => row.gdtf).forEach((row) => {
        const key = fold(row.name);
        if (!sameName.has(key)) sameName.set(key, []);
        sameName.get(key).push(row);
      });
      sameName.forEach((same) => {
        if (same.length < 2) return;
        const revisions = same.map((row) => row.revision || '');
        same.forEach((row, i) => {
          const repeated = revisions.indexOf(revisions[i]) !== i
            || revisions.lastIndexOf(revisions[i]) !== i;
          const which = !repeated && row.revision ? row.revision : row.file.split('/').pop();
          row.name = `${row.name} · ${which}`;
        });
      });
    };
    const byName = (a, b) => String(a.name).localeCompare(String(b.name));
    folders.forEach((folder) => told(folder.fixtures));
    unfiled.forEach((folder) => told(folder.fixtures));
    folders.forEach((folder) => folder.fixtures.sort(byName));
    return { folders, unfiled: [...unfiled.values()] };
  }

  /**
   * Loads the library's manufacturer display names.
   *
   * @public
   * @async
   */
  async preloadManufacturers() {
    try {
      this.manufacturers = (await fetchJson(`${import.meta.env.VITE_STATIC_URL}fixtures/manufacturers.json`)) || {};
    } catch (err) {
      this.manufacturers = {};
    }
  }

  /**
   * A manufacturer's display name, falling back to the slug it is stored under.
   *
   * @public
   * @param {String} slug library folder name
   * @returns {String}
   */
  manufacturerName(slug) {
    if (slug === SHOW_SCOPE) return SHOW_SCOPE_LABEL;
    return (this.manufacturers[slug] || {}).name || slug || '';
  }

  async preloadFixtureList() {
    try {
      /** The shipped index as fetched, which every refresh starts from. */
      this.shippedFixtureList = await fetchJson(`${import.meta.env.VITE_STATIC_URL}fixtures/fixture_list.json`);
    } catch (err) {
      console.log('could not fetch fixture list.');
      this.shippedFixtureList = [];
    }
    this.refreshFixtureList();
  }

  /**
   * Generated profiles, shaped like the library index so the patch popup can
   * list them without knowing where they came from.
   *
   * Listed first: these are the fixtures this app is actually for, and hunting
   * for them under A in a list of 47 manufacturers would be perverse.
   *
   * @public
   * @returns {Array} manufacturer entries
   */
  generatedFixtureList() {
    const byManufacturer = {};
    // The library's profiles, and those the open document carries that this
    // machine has nowhere else: an export opened elsewhere can still place
    // another of the bars it was built with. A carried copy of a shipped
    // profile is left out, since the shipped list already offers it.
    const listed = { ...this.collectedOnlyProfiles(), ...this.generatedProfiles };
    Object.keys(listed).forEach((key) => {
      const [manufacturer, model] = key.split('/');
      const profile = listed[key];
      byManufacturer[manufacturer] = byManufacturer[manufacturer] || [];
      byManufacturer[manufacturer].push({
        file: model,
        name: profile.name,
        category: profile.categories[0],
        supported: true,
        generated: true,
      });
    });
    return Object.keys(byManufacturer).map((name) => ({
      name,
      // Flagged so a refresh can tell the user's entries from the library's.
      generated: true,
      fixtures: byManufacturer[name],
    }));
  }
}

export default Show;
