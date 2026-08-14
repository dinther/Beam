import axios from 'axios';
import {
  EventEmitter,
} from 'events';
import {
  ProxifySingleton,
} from '../utils/proxify.utils';

import UniversePool from './universe.pool.model';
import FixturePool from './fixture.pool.model';
import Live from './live.model';

const DEFAULT_PROJECT_NAME = 'new_project.asls';

const SHOWFILE_EXTENSIONS = {
  ASLS: 'json',
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
    this.isSaved = true;
    this.rawOFLFixtures = [];
    this.fixturePool = new FixturePool();
    this.universePool = new UniversePool();
    this.running = false;
    this.slave = false;
    this.loading = {
      state: true,
      message: 'Preparing Environment',
      percentage: 10,
    };
    this.ready = false;
    this.artnetServerUrl = import.meta.env.VITE_APP_DMX2WS_SERVER_URL;
    this.visualizerHandle = null;
    ProxifySingleton.on('changed', () => {
      this.isSaved = false;
      this.emit('saveState', this.isSaved);
    });
    this.universePool.addRaw();
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

  get showData() {
    return {
      name: this.name,
      fixtures: this.fixturePool.fixtures.map((f) => f.showData),
      universes: this.universePool.universes.map((u) => u.showData),
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
   * Persists the show to disk.
   *
   * Fire-and-forget: the save state is reported optimistically so the UI stays
   * responsive, and a failure is logged by the main process rather than
   * interrupting the user mid-edit.
   *
   * @public
   */
  persistLocally() {
    if (typeof window !== 'undefined' && window.jsonStore) {
      // Serialised here: show data is wrapped in reactive proxies, which
      // structured clone cannot carry across the IPC boundary.
      window.jsonStore.write('show', JSON.stringify(this.showData, null, 2));
    }
    this.isSaved = true;
    this.emit('saveState', this.isSaved);
  }

  /**
   * Prepares universes from show data.
   *
   * @param {Object} showData hande toa show configuration object
   */
  async prepareUniverses(showData) {
    showData.universes.forEach((universeData) => {
      const universe = this.universePool.addRaw(universeData);
      universeData.fixtures.forEach((fixtureData) => {
        const fixture = this.fixturePool.getFromId(fixtureData.id);
        universe.patchFixture(fixture);
      });
    });
  }

  /**
   * Deletes a fixture from the show.
   *
   * @param {Object} fixture a fixture configuration object
   */
  deleteFixture(fixture) {
    const fixtureHandle = this.fixturePool.getFromId(fixture.id);
    if (fixtureHandle) {
      const universe = this.universePool.getFromId(fixtureHandle.universe);
      universe.unpatchFixture(fixtureHandle);
      this.fixturePool.delete(fixtureHandle, true);
    }
  }

  /**
   * Clears show data
   *
   * @public
   */
  clearShowData() {
    this.universePool.clearAll();
    this.fixturePool.clearAll(true);
    this.name = '';
    this.isSaved = true;
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
   * Loads the persisted show from disk, if there is one.
   *
   * @async
   * @public
   * @returns {Boolean} whether a stored show was found and loaded
   */
  async loadPersisted() {
    if (typeof window === 'undefined' || !window.jsonStore) return false;
    const showData = await window.jsonStore.read('show');
    if (!showData) return false;
    await this.loadFromData(showData);
    return true;
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
  }

  /**
   * Prepares and sets up a show from provided show data configuration
   *
   * @param {Object} showData raw show configuration data to be parsed/loaded
   * @public
   * @async
   */
  async loadFromData(showData) {
    this.loading.state = true;
    this.loading.message = 'Clearing Show Data';
    this.loading.percentage = 20;
    this.clearShowData();

    this.loading.message = 'Preloading fixture library';
    this.loading.percentage = 40;
    await this.preloadFixtureList();

    this.loading.message = 'Setting up show fixtures';
    this.loading.percentage = 60;
    await this.prepareFixtures(showData);

    this.loading.message = 'Setting up universes';
    this.loading.percentage = 80;
    this.name = showData.name;
    await this.prepareUniverses(showData);

    this.loading.message = 'Finalizing';
    this.loading.percentage = 95;
    this.name = showData.name;
    this.ready = true;
    this.isSaved = true;

    this.persistLocally();
  }

  /**
   * Prepares show fixtures from provided show data
   *
   * @param {Object} handle to show data configuration object
   * @public
   * @async
   */
  async prepareFixtures(showData) {
    for (let i = 0; i < showData.fixtures.length; i++) {
      const fixtureData = showData.fixtures[i];
      fixtureData.OFLData = JSON.parse(fixtureDataCache[`${fixtureData.manufacturer}/${fixtureData.model}`] || null);
      if (!fixtureData.OFLData) {
        const res = await axios.get(`${import.meta.env.VITE_STATIC_URL}fixtures/${fixtureData.manufacturer}/${fixtureData.model}.json`);
        fixtureData.OFLData = res.data;
        fixtureDataCache[`${fixtureData.manufacturer}/${fixtureData.model}`] = JSON.stringify(fixtureData.OFLData);
      }
      this.fixturePool.addRaw(fixtureData);
    }
  }

  /**
   * Preloads fixture library from provided fixture list configuration
   *
   * @public
   * @async
   * @see ./fixtures/fixture_list.json
   * @see https://open-fixture-library.org/
   */
  async preloadFixtureList() {
    try {
      const res = await axios.get(`${import.meta.env.VITE_STATIC_URL}fixtures/fixture_list.json`);
      this.rawOFLFixtures = res.data;
    } catch (err) {
      console.log('could not fetch fixture list.');
    }
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
      case SHOWFILE_EXTENSIONS.ASLS:
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
