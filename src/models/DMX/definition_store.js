import { withoutLedBarChannels, expandLedBarProfile } from './generic/led_bar';

/**
 * @file The fixture definitions that belong to a show.
 *
 * A definition lives **in the show** until the user saves it to the library
 * -- the same bargain a structure or an inline object makes -- so an
 * experiment is not a permanent library entry, and a show opens on a machine
 * whose library has never seen what it uses.
 *
 * Two rules:
 *
 * - **A definition exists only while something references it.** Delete the
 *   last instance and the definition goes with it; a definition created and
 *   then never placed does not linger either. {@link DefinitionStore#prune}
 *   is what enforces it, given the keys the show's fixtures still use.
 * - **A definition is never edited.** Its resolution, its pixel count, its
 *   throw range are what it *is*; the adjustable parameters live on the
 *   placement. Delete and recreate is the only edit.
 *
 * Bars are stored without their channel list, exactly as the library stores
 * them: every entry is the same capability under a different name and the
 * geometry already says how many there are. A 256 x 256 tile is 196,608 of
 * them, which is 33 MB of show file saying nothing.
 */
class DefinitionStore {
  constructor() {
    /** key `manufacturer/model` to a full (expanded) profile. */
    this._profiles = {};
  }

  /**
   * Reads what a show file carries.
   *
   * @param {Object} [data] `{ key: compactProfile }`, or nothing for a show
   *   written before definitions travelled in it
   * @returns {DefinitionStore}
   */
  static fromJSON(data) {
    const store = new DefinitionStore();
    Object.entries(data || {}).forEach(([key, profile]) => {
      if (profile) store._profiles[key] = expandLedBarProfile(profile);
    });
    return store;
  }

  /** @type {Array} */
  get keys() { return Object.keys(this._profiles); }

  /** @type {Number} */
  get size() { return this.keys.length; }

  /**
   * @param {String} key
   * @returns {Boolean}
   */
  has(key) { return !!this._profiles[key]; }

  /**
   * The profile under a key, or null. Callers that mutate what they get must
   * copy it first, as they do for a library profile.
   *
   * @param {String} key
   * @returns {Object|null}
   */
  get(key) { return this._profiles[key] || null; }

  /**
   * @param {String} key
   * @param {Object} profile a full profile, channels and all
   */
  add(key, profile) { this._profiles[key] = profile; }

  /**
   * @param {String} key
   * @returns {Object|null} what was removed
   */
  remove(key) {
    const profile = this._profiles[key] || null;
    delete this._profiles[key];
    return profile;
  }

  /**
   * Drops every definition nothing uses any more.
   *
   * @param {Iterable} keysInUse the `manufacturer/model` keys of the fixtures
   *   currently in the show
   * @returns {Array} the keys removed
   */
  prune(keysInUse) {
    const used = new Set(keysInUse);
    const gone = this.keys.filter((key) => !used.has(key));
    gone.forEach((key) => { delete this._profiles[key]; });
    return gone;
  }

  /**
   * As the show file stores them: compact, bars without their channels.
   *
   * @returns {Object}
   */
  toJSON() {
    return Object.fromEntries(this.keys.map(
      (key) => [key, withoutLedBarChannels(this._profiles[key])],
    ));
  }

  /**
   * What the Add-to-Show list shows for this show's own definitions: one
   * folder, its entries carrying their own manufacturer since the folder is
   * not one.
   *
   * @param {String} [title] the folder's name
   * @returns {Array} zero or one manufacturer-shaped entries
   */
  list(title = 'This show') {
    if (!this.size) return [];
    return [{
      name: title,
      // Flagged so a refresh can tell the app's own entries from the
      // library's, and `local` so the list knows the entries carry their
      // manufacturer themselves.
      generated: true,
      local: true,
      fixtures: this.keys.map((key) => {
        const [manufacturer, model] = key.split('/');
        const profile = this._profiles[key];
        return {
          file: model,
          manufacturer,
          name: `${manufacturer} ${profile.name || model}`,
          category: (profile.categories || [])[0],
          supported: true,
          generated: true,
          local: true,
        };
      }),
    }];
  }
}

export default DefinitionStore;
