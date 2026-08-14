import { DMX_UNIVERSE_LENGTH } from './patch.model';

/**
 * Showfile format version.
 *
 * 1: fixtures addressed by (universe, chStart), and listed a second time under
 *    the universe that owned them.
 * 2: fixtures carry one absolute address into a show-wide space, so a fixture
 *    may span a universe boundary. Universe records are display metadata only.
 *
 * @constant {Number} SHOWFILE_VERSION
 */
const SHOWFILE_VERSION = 2;

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

  return {
    ...data,
    version: SHOWFILE_VERSION,
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
    // Version 1 grouped fixtures under the universe that owned them, and gave
    // each a name and colour. Addresses are the only record of where a fixture
    // lives now, and nothing presents universes, so the records are dropped.
    universes: undefined,
  };
}

export default migrateShowData;
export { SHOWFILE_VERSION };
