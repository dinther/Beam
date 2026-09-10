import { DMX_UNIVERSE_LENGTH } from './patch.model';
import { DEFAULT_FLOOR } from './scene_item';

/**
 * Showfile format version.
 *
 * 1: fixtures addressed by (universe, chStart), and listed a second time under
 *    the universe that owned them.
 * 2: fixtures carry one absolute address into a show-wide space, so a fixture
 *    may span a universe boundary. Universe records are display metadata only.
 * 3: the floor is an object in the show rather than a fixture of the renderer,
 *    so it can be moved, resized, replaced or deleted like anything else.
 *
 * @constant {Number} SHOWFILE_VERSION
 */
const SHOWFILE_VERSION = 3;

/**
 * Brings a showfile of any version up to the current shape.
 *
 * Kept apart from the Show class because loading a file should not require a
 * show to load it into: this is a pure transform, and testable as one.
 *
 * @param {Object} showData raw showfile contents
 * @return {Object} showfile in the current shape
 */
function migrateShowData(showData) {
  const data = showData || {};
  const version = data.version || 1;
  if (version >= SHOWFILE_VERSION) return data;

  // A show below version 3 records no floor, though it was built looking at
  // one, so it is given one. The floor is deletable, so a show that does not
  // want it says so by not having one the next time it is written. Anything
  // at or past 3 has already returned above.
  const objects = [{ ...DEFAULT_FLOOR }, ...(data.objects || [])];

  return {
    ...data,
    version: SHOWFILE_VERSION,
    objects,
    fixtures: (data.fixtures || []).map((fixture) => ({
      ...fixture,
      // Fixture accepts either form, but resolving it here means the migration
      // shows up in the file the next time it is written rather than being
      // re-derived on every load.
      address: fixture.address !== undefined
        ? fixture.address
        : (parseInt(fixture.universe, 10) || 0) * DMX_UNIVERSE_LENGTH
          + (parseInt(fixture.chStart, 10) || 0),
    })),
    // Version 1 groups fixtures under the universe that owns them, with a name
    // and colour each. Addresses are the only record of where a fixture lives,
    // and nothing presents universes, so the records are dropped.
    universes: undefined,
  };
}

export default migrateShowData;
export { SHOWFILE_VERSION };
