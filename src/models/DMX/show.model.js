import * as THREE from 'three';
import axios from 'axios';
import { merge } from 'lodash';
import {
  EventEmitter,
} from 'events';
import {
  ProxifySingleton,
} from '../utils/proxify.utils';

import PatchSingleton from './patch.model';
import migrateShowData, { SHOWFILE_VERSION } from './showfile.migrate';
import FixturePool from './fixture.pool.model';
import Group from './group.model';
import Structure from './structure.model';
import Live from './live.model';
import { buildLedBarProfile } from './generic/led_bar';
import { MAX_SHADOW_CASTERS } from '../../plugins/visualizer/moving_head';

const DEFAULT_PROJECT_NAME = 'new_project.json';

const SHOWFILE_EXTENSIONS = {
  JSON: 'json',
};

const fixtureDataCache = {};

/**
 * Storage for show definitions
 * TODO: Refactor and document.
 *
 * @class Show
 * @todo Refactor whole class. it's messy
 * @extends {EventEmitter}
 */
class Show extends EventEmitter {
  /**
   * Creates an instance of Show.
   */
  constructor() {
    super();
    this.name = '';
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
    /** Local corrections to library profiles, keyed `manufacturer/model`. */
    this.fixtureOverrides = {};
    /**
     * Profiles built here rather than fetched, keyed the same way. OFL cannot
     * describe an emitter array, so these are generated from parameters the
     * user chose, and saved beside the show.
     */
    this.generatedProfiles = {};
    this.fixturePool = new FixturePool();
    /** Groups, in list order. Membership is exclusive. */
    this.groups = [];
    /**
     * Structures standing in the scene, in list order. These are placed
     * items, not definitions: each holds real fixtures and objects and has no
     * link back to whatever it was stamped from.
     */
    this.structures = [];
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
    ProxifySingleton.on('changed', () => {
      this.isSaved = false;
      this.emit('saveState', this.isSaved);
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

  get isSaved() {
    return this._isSaved;
  }

  set isSaved(isSaved) {
    this._isSaved = isSaved;
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
    return {
      version: SHOWFILE_VERSION,
      name: this.name,
      diffInput: PatchSingleton.diffInput,
      // Addressing lives entirely on the fixtures now. Universe records are
      // kept only for the name and colour the patch bay displays.
      groups: this.groups.map((group) => group.showData),
      structures: this.structures.map((structure) => structure.showData),
      fixtures: this.fixturePool.fixtures.map((f) => f.showData),
    };
  }

  /**
   * Show name
   *
   * @type {String}
   */
  set name(name) {
    if (name) {
      this._name = name.replace('.json', '');
    } else {
      this._name = 'Untitled project';
    }
  }

  get name() {
    return this._name ? this._name : DEFAULT_PROJECT_NAME;
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
  // eslint-disable-next-line class-methods-use-this
  // eslint-disable-next-line class-methods-use-this
  /**
   * @method undo
   * forward undo instruction to prify instance
   */
  static undo() {
    ProxifySingleton.undo();
  }

  /**
   * @method redo
   * forward redo instruction to prify instance
   */
  static redo() {
    ProxifySingleton.redo();
  }

  /**
   * Claims every loaded fixture's channels in the show's address space.
   *
   * @public
   */
  async patchFixtures() {
    this.fixturePool.fixtures.forEach((fixture) => this.patchFixture(fixture));
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
    const fixtureHandle = this.fixturePool.getFromId(fixture.id);
    if (fixtureHandle) {
      PatchSingleton.unpatchFixture(fixtureHandle);
      this.fixturePool.delete(fixtureHandle, true);
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
    this.name = '';
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
   * remembered between runs and nothing is opened unasked -- a document appears
   * because the user said so.
   *
   * @public
   * @async
   * @returns {Promise<Boolean>} whether a document was opened
   */
  async openDocument() {
    if (typeof window === 'undefined' || !window.documentStore) return false;
    const target = await window.documentStore.open();
    // Cancelling is an ordinary answer, not a failure.
    if (!target) return false;
    return this.openDocumentAt(target);
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
    await this.loadFromData(showData);
    await this.setDocument(target);
    this.isSaved = true;
    this.emit('saveState', this.isSaved);
    return true;
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
   * Saves the show to a document the user picks.
   *
   * @public
   * @async
   * @returns {Promise<Boolean>} whether anything was written
   */
  async saveDocumentAs() {
    if (typeof window === 'undefined' || !window.documentStore) return false;
    const target = await window.documentStore.saveAs(this.projectName || this.name);
    // Cancelling a save dialog is an ordinary answer, not a failure.
    if (!target) return false;
    return this.writeDocument(target);
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
    const written = await window.documentStore.write(target, json);
    if (!written) return false;
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
   * Loads showfile from provided frile
   *
   * @param {File} file handle to raw showfile instance
   * @returns {Promise}
   * @async
   * @public
   */
  async loadFromFile(file) {
    try {
      const fileData = await Show.readFileAsync(file);
      await this.loadShowFile(file.name, fileData);
    } catch (err) {
      console.log(err);
    }
  }

  /**
   * Parses and loads showfile from provided data
   *
   * @todo re-implement QLC loader better
   *
   * @param {String} filename Name of the file
   * @param {Object} data RAW show data to be parsed
   * @async
   * @public
   */
  async loadShowFile(filename, data) {
    const extension = Show._getShowFileType(filename);
    const showData = await Show._parseShowData(data, extension);
    await this.loadFromData(showData);
    this.name = filename;
    // Importing a loose showfile is not opening a project. Leaving the previous
    // document in place would point Save at somebody else's project and write
    // this show straight over it.
    await this.setDocument(null);
  }

  /**
   * Prepares and sets up a show from provided show data configuration
   *
   * @param {Object} showData raw show configuration data to be parsed/loaded
   * @public
   * @async
   */
  async loadFromData(rawShowData) {
    // A load clears the show and then rebuilds it across several awaits. Two
    // overlapping calls would both clear first and then both append, leaving
    // one copy of every fixture per caller, so run them strictly in sequence.
    // A failed load must not stall the queue, hence the same handler twice.
    //
    // The load raises the loading overlay, so the load lowers it -- including
    // when it throws. Leaving that to each caller is how opening a document
    // came to sit at "Finalizing" forever: the show behind the overlay was
    // loaded and fine, but nothing had thought to take the overlay away.
    const run = async () => {
      try {
        return await this.loadShowData(rawShowData);
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
   * @param {Object} options load options
   * @private
   * @async
   */
  async loadShowData(rawShowData) {
    const showData = migrateShowData(rawShowData);
    this.loading.state = true;
    this.loading.message = 'Clearing Show Data';
    this.loading.percentage = 20;
    this.clearShowData();

    this.loading.message = 'Preloading fixture library';
    this.loading.percentage = 40;
    await this.preloadGeneratedProfiles();
    await this.preloadStructures();
    await this.preloadManufacturers();
    await this.preloadFixtureList();
    await this.preloadFixtureOverrides();

    this.loading.message = 'Setting up show fixtures';
    this.loading.percentage = 60;
    await this.prepareFixtures(showData);

    this.capShadowCasters();

    this.loading.message = 'Restoring groups';
    this.prepareGroups(showData);

    this.loading.message = 'Restoring structures';
    this.prepareStructures(showData);

    this.loading.message = 'Patching fixtures';
    this.loading.percentage = 80;
    this.name = showData.name;
    if (showData.diffInput !== undefined) {
      PatchSingleton.diffInput = showData.diffInput;
    }
    await this.patchFixtures();

    this.loading.message = 'Finalizing';
    this.loading.percentage = 95;
    this.name = showData.name;
    this.ready = true;
    this.isSaved = true;

    // Opening view chosen from the show that just loaded. Every fixture has
    // its renderer by now, and bounds come from those rather than from drawn
    // matrices, so there is nothing to wait a frame for.
    if (this.visualizerHandle && this.visualizerHandle.frameDefault) {
      this.visualizerHandle.frameDefault();
    }
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
    for (let i = 0; i < showData.fixtures.length; i++) {
      const fixtureData = showData.fixtures[i];
      const profileKey = `${fixtureData.manufacturer}/${fixtureData.model}`;
      fixtureData.OFLData = this.generatedProfiles[profileKey]
        ? JSON.parse(JSON.stringify(this.generatedProfiles[profileKey]))
        : JSON.parse(fixtureDataCache[profileKey] || null);
      if (!fixtureData.OFLData) {
        const res = await axios.get(`${import.meta.env.VITE_STATIC_URL}fixtures/${profileKey}.json`);
        fixtureData.OFLData = res.data;
        fixtureDataCache[profileKey] = JSON.stringify(fixtureData.OFLData);
      }
      // Applied after caching, so the cache keeps the library profile untouched
      // and an edited overrides file takes effect on the next load.
      if (this.fixtureOverrides[profileKey]) {
        merge(fixtureData.OFLData, this.fixtureOverrides[profileKey]);
      }
      const created = this.fixturePool.addRaw(fixtureData);
      if (fixtureData.id !== undefined) this.loadedFixturesById.set(fixtureData.id, created);
    }
  }

  /**
   * Loads local corrections to library profiles, keyed `manufacturer/model`.
   *
   * The shipped library is Open Fixture Library data and stays untouched so it
   * can be replaced wholesale; anything measured or guessed locally -- head slew
   * rates, which OFL has no field for -- lives here instead. It sits beside the
   * show rather than in the bundle because the app writes it.
   *
   * @public
   * @async
   */
  async preloadFixtureOverrides() {
    if (typeof window === 'undefined' || !window.library) {
      this.fixtureOverrides = {};
      return;
    }
    // Nothing overridden is a perfectly ordinary state; every fixture then
    // falls back to its library profile and the renderer's own defaults.
    this.fixtureOverrides = (await window.library.readAll('overrides')) || {};
  }

  /**
   * Writes the overrides file.
   *
   * @public
   */
  persistFixtureOverrides(profileKey) {
    if (typeof window === 'undefined' || !window.library) return;
    // One item, one file. Writing only the profile that changed is the point of
    // the library being files: nothing else is put at risk by this save.
    const keys = profileKey ? [profileKey] : Object.keys(this.fixtureOverrides);
    keys.forEach((key) => {
      const entry = this.fixtureOverrides[key];
      // A model whose last override has just been cleared has no entry left,
      // and its file has to go with it. Written back instead it would return as
      // an empty object on the next launch, and the default would stay
      // overridden by nothing at all.
      if (!entry || !Object.keys(entry).length) {
        window.library.remove('overrides', key);
        return;
      }
      window.library.write('overrides', key, JSON.stringify(entry, null, 2));
    });
  }

  /**
   * Sets one override for a model and applies it to everything already patched.
   *
   * @public
   * @param {String} profileKey `manufacturer/model`
   * @param {String} key property being overridden
   * @param {Number|String} value value to store
   */
  setFixtureOverride(profileKey, key, value) {
    const entry = this.fixtureOverrides[profileKey] || {};
    entry[key] = value;
    this.fixtureOverrides[profileKey] = entry;
    this.persistFixtureOverrides(profileKey);
    this.applyFixtureOverride(profileKey, key, value);
  }

  /**
   * Drops one override and restores the system default.
   *
   * The model's entry is removed once its last override goes, so the file never
   * accumulates empty objects for models that are no longer customised.
   *
   * @public
   * @param {String} profileKey `manufacturer/model`
   * @param {String} key property being cleared
   * @param {Number} fallback value to restore
   */
  clearFixtureOverride(profileKey, key, fallback) {
    const entry = this.fixtureOverrides[profileKey];
    if (entry) {
      delete entry[key];
      if (!Object.keys(entry).length) delete this.fixtureOverrides[profileKey];
      this.persistFixtureOverrides(profileKey);
    }
    this.applyFixtureOverride(profileKey, key, fallback);
  }

  /**
   * Pushes an override onto every patched fixture of that model.
   *
   * @public
   * @param {String} profileKey `manufacturer/model`
   * @param {String} key property being set
   * @param {Number|String} value value to apply
   */
  applyFixtureOverride(profileKey, key, value) {
    this.fixturePool.fixtures.forEach((fixture) => {
      if (fixture.profileKey !== profileKey) return;
      // Kept on the raw profile too, so a fixture rebuilt from it agrees.
      fixture.OFLData[key] = value;
      fixture[key] = value;
    });
  }

  /**
   * Holds the show to the shadow budget it can actually render.
   *
   * The checkbox refuses to spend more than there is, but a showfile is not
   * the checkbox: one written by hand, or by a build where the limit was
   * different, can ask for more shadow-casting fixtures than the GPU has
   * texture units -- and the result is not a slow scene, it is a scene missing
   * everything drawn with the standard material. The ones beyond the budget
   * lose their shadow rather than the show losing its floor.
   *
   * @public
   */
  capShadowCasters() {
    let spent = 0;
    this.fixturePool.fixtures.forEach((fixture) => {
      if (!fixture.castsShadow) return;
      spent += 1;
      if (spent > MAX_SHADOW_CASTERS) fixture.castsShadow = false;
    });
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
    this.groups = (showData.groups || []).map((groupData) => {
      const group = new Group(groupData);
      (groupData.members || []).forEach((id) => {
        // Resolved through the load index rather than the pool: addRaw hands
        // out fresh ids, so a saved member id means nothing once a fixture has
        // been deleted and the rest have shuffled down.
        const fixture = this.loadedFixturesById.get(id);
        if (fixture) group.add(fixture);
      });
      return group;
    });
  }

  /**
   * The nearest free group name to the one asked for.
   *
   * Groups are told apart by name in the patch bay, so two sharing one makes
   * the list ambiguous. A taken name gains a number rather than being refused.
   *
   * @public
   * @param {String} desired name the user asked for
   * @param {Number} [ignoreId] id of the group allowed to keep this name
   * @returns {String} a name no other group is using
   */
  uniqueGroupName(desired, ignoreId = null) {
    const wanted = (desired || '').trim() || 'Group';
    const taken = new Set(
      this.groups.filter((group) => group.id !== ignoreId).map((group) => group.name),
    );
    if (!taken.has(wanted)) return wanted;
    let n = 2;
    while (taken.has(`${wanted} ${n}`)) n += 1;
    return `${wanted} ${n}`;
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
   * @returns {String} the structure's name
   */
  async saveStructure(group) {
    const matrix = group.matrix.clone();
    const inverse = matrix.clone().invert();
    const structure = {
      name: group.name,
      members: group.members.map((member) => {
        const local = member.localTransform
          ? member.localTransform.clone()
          : inverse.clone();
        return {
          manufacturer: member.manufacturer,
          model: member.model,
          mode: member.mode ? member.mode.name : undefined,
          universeAligned: !!member.universeAligned,
          transform: local.elements.slice(),
        };
      }),
    };
    this.structureLibrary[group.name] = structure;
    if (typeof window !== 'undefined' && window.library) {
      // Only this structure is written. Saving one used to re-serialise every
      // structure there was, so a bad write took the whole library with it.
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

    for (let i = 0; i < definition.members.length; i += 1) {
      const member = definition.members[i];
      // eslint-disable-next-line no-await-in-loop
      const OFLData = await this.resolveProfile(member.manufacturer, member.model);
      if (OFLData) {
        world.multiplyMatrices(origin, new THREE.Matrix4().fromArray(member.transform));
        world.decompose(position, quaternion, scale);
        euler.setFromQuaternion(quaternion);

        const fixture = this.fixturePool.addRaw({
          OFLData,
          manufacturer: member.manufacturer,
          model: member.model,
          category: OFLData.categories[0],
          name: this.fixturePool.numberedName(OFLData.name),
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
   * underside at 6 m. Derived rather than stored, so structures saved before
   * any of this place correctly without being saved again.
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
    if (this.generatedProfiles[key]) {
      return JSON.parse(JSON.stringify(this.generatedProfiles[key]));
    }
    try {
      const res = await axios.get(`${import.meta.env.VITE_STATIC_URL}fixtures/${key}.json`);
      return res.data;
    } catch (err) {
      return null;
    }
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
  prepareStructures(showData) {
    this.structures = (showData.structures || []).map((structureData) => {
      const structure = new Structure(structureData);
      (structureData.members || []).forEach((id) => {
        // Resolved through the load index rather than the pool: addRaw hands
        // out fresh ids, so a saved member id means nothing once a fixture has
        // been deleted and the rest have shuffled down.
        const fixture = this.loadedFixturesById.get(id);
        if (fixture) structure.add(fixture);
      });
      return structure;
    });
  }

  /**
   * The nearest free structure name to the one asked for.
   *
   * Placing the same definition twice is normal, so a clash is expected rather
   * than exceptional: the second one gains a number instead of being refused.
   *
   * @public
   * @param {String} desired name the user asked for
   * @param {Number} [ignoreId] id of the structure allowed to keep this name
   * @returns {String} a name no other structure is using
   */
  uniqueStructureName(desired, ignoreId = null) {
    // Untitled, as an unsaved show is: the name is the user's to give, and a
    // made-up one reads as though it had already been named.
    const wanted = (desired || '').trim() || 'untitled';
    const taken = new Set(
      this.structures
        .filter((structure) => structure.id !== ignoreId)
        .map((structure) => structure.name),
    );
    if (!taken.has(wanted)) return wanted;
    let n = 2;
    while (taken.has(`${wanted} ${n}`)) n += 1;
    return `${wanted} ${n}`;
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
      name: this.uniqueStructureName(name),
      position: (origin || {}).position,
      rotation: (origin || {}).rotation,
    });
    members.forEach((member) => structure.add(member));
    if (members.length && !origin) structure.centreOnMembers();
    this.structures.push(structure);
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
      const handle = this.fixturePool.findFromId(member.id);
      if (!handle) return;
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
    this.groups.push(group);
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
    this.generatedProfiles = stored || {};
  }

  /**
   * Builds a generic fixture profile and adds it to the library.
   *
   * @public
   * @async
   * @param {String} manufacturer name the user chose
   * @param {String} model name the user chose
   * @param {Object} params geometry and wiring
   * @returns {String} the profile's key
   */
  async createGeneratedProfile(manufacturer, model, params) {
    const key = `${manufacturer}/${model}`;
    const profile = buildLedBarProfile(params);
    profile.name = model;
    this.generatedProfiles[key] = profile;
    if (typeof window !== 'undefined' && window.library) {
      await window.library.write('profiles', key, JSON.stringify(profile, null, 2));
    }
    this.refreshFixtureList();
    return key;
  }

  /**
   * Re-lays the library index over the current generated profiles.
   *
   * @public
   */
  refreshFixtureList() {
    const library = this.rawOFLFixtures.filter((entry) => !entry.generated);
    this.rawOFLFixtures = [...this.generatedFixtureList(), ...library];
  }

  /**
   * Loads the library's manufacturer display names.
   *
   * @public
   * @async
   */
  async preloadManufacturers() {
    try {
      const res = await axios.get(`${import.meta.env.VITE_STATIC_URL}fixtures/manufacturers.json`);
      this.manufacturers = res.data || {};
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
    return (this.manufacturers[slug] || {}).name || slug || '';
  }

  async preloadFixtureList() {
    try {
      const res = await axios.get(`${import.meta.env.VITE_STATIC_URL}fixtures/fixture_list.json`);
      this.rawOFLFixtures = res.data;
    } catch (err) {
      console.log('could not fetch fixture list.');
      this.rawOFLFixtures = [];
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
    Object.keys(this.generatedProfiles).forEach((key) => {
      const [manufacturer, model] = key.split('/');
      const profile = this.generatedProfiles[key];
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

  /**
   * Gets showfile type from showfile extension
   *
   * @todo Implement QLC and other showfile formats better
   *
   * @param {String} showFileName show file name
   * @static
   */
  static _getShowFileType(showFileName) {
    const splitted = showFileName.split('.');
    return splitted[splitted.length - 1];
  }

  /**
   * Parses show data
   *
   * @param {File} showFile handle to raw showfile instance
   * @param {String} extension extendion of the provided showfile
   * @static
   */
  static _parseShowData(showFile, extension) {
    switch (extension) {
      case SHOWFILE_EXTENSIONS.JSON:
        return JSON.parse(showFile);
      default:
        throw new Error('Could not load provided file');
    }
  }

  /**
   * Reads a file asynchronously
   *
   * @todo put this in utils
   *
   * @param {File} file handle to file instance
   * @static
   * @async
   */
  static async readFileAsync(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => {
        resolve(fr.result);
      };
      fr.onerror = reject;
      fr.readAsText(file);
    });
  }
}

export default Show;
