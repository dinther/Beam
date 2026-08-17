/* eslint-disable no-console */
/* eslint-disable import/no-extraneous-dependencies */
import { app } from 'electron';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import paths from './paths';

/**
 * The user's fixture library on disk, one file per item (main process).
 *
 * Everything here is the user's own work, shared across projects rather than
 * belonging to any one of them: generated fixture profiles, saved structures,
 * and local corrections to shipped profiles. A show only ever *names* these, so
 * they are edited in one place -- freezing a project against later edits is what
 * Export is for, not this.
 *
 * It lives in the user's Documents, not in AppData. AppData is for settings,
 * and a structure someone saved is not a setting: they will want to find the
 * file again, copy it to another machine, or send it to somebody. That is the
 * same reason one structure is one file.
 *
 * One item is one file. The alternative, a single keyed blob per kind, is what
 * this replaces: saving one structure used to re-serialise the whole library,
 * so an interrupted write or one malformed entry put every item at risk. Here a
 * save touches exactly the file it names, and a file that will not parse is
 * skipped by name while the rest of the library still loads.
 *
 * Layout, under `Documents/Beatline/Beam/Library`:
 *
 *   Profiles/<manufacturer>/<model>.json
 *   Structures/<name>.json
 *   Overrides/<manufacturer>/<model>.json
 *
 * Nothing is created until there is something to put in it, so a user who has
 * saved nothing never finds empty folders in their Documents.
 */

/**
 * How many path segments a kind's key has, and where its legacy blob lived.
 *
 * @constant {Object} KINDS
 */
const KINDS = {
  profiles: { depth: 2, legacy: 'generated_profiles', dir: 'Profiles' },
  structures: { depth: 1, legacy: 'structures', dir: 'Structures' },
  overrides: { depth: 2, legacy: 'fixture_overrides', dir: 'Overrides' },
};

/** Records that the one-time split of the old blobs has happened. */
const MIGRATION_MARKER = 'library-migrated.json';

/** Marks a file as ours and carries the key the filename cannot. */
const FORMAT = 1;

/**
 * Characters Windows forbids in a file name, plus the control range.
 *
 * Kept deliberately narrow: spaces and hyphens are legal and common -- `60 LED
 * Bar GRB`, `mac-aura` -- so only what Windows actually refuses is touched, and
 * every surviving character is one the key reads back from unchanged.
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001F]/g;

/** Device names Windows reserves whatever extension follows them. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Root of the library.
 *
 * Beside the projects rather than inside any of them, and in Documents where
 * the user can reach it.
 *
 * @returns {String} absolute path
 */
function libraryRoot() {
  return path.join(paths.beamRoot(), 'Library');
}

/**
 * Root of one kind.
 *
 * @param {String} kind key of `KINDS`
 * @returns {String|null} absolute path, or null when the kind is unknown
 */
function kindRoot(kind) {
  return KINDS[kind] ? path.join(libraryRoot(), KINDS[kind].dir) : null;
}

/**
 * A short, stable digest of a key, used to tell two file names apart.
 *
 * @param {String} value
 * @returns {String} six hex characters
 */
function digestOf(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 6);
}

/**
 * A file name that means the same thing to the user and to Windows.
 *
 * Names the user chose are not file names: `martin/mac-aura` has a separator in
 * it, a structure may be called `Truss #2 (SL)`, and Windows additionally
 * refuses trailing dots and spaces and reserves a handful of device names. When
 * anything has to be changed, a short digest of the original is appended, so two
 * different keys can never land on the same file -- which on a case-insensitive
 * filesystem they otherwise would.
 *
 * @param {String} raw one segment of a key
 * @returns {String} a usable file or directory name
 */
function safeSegment(raw) {
  const original = String(raw);
  let safe = original.replace(FORBIDDEN, '_').replace(/[. ]+$/, '');
  if (!safe || RESERVED.test(safe)) safe = `_${safe}`;
  if (safe !== original) safe = `${safe}~${digestOf(original)}`;
  return safe;
}

/**
 * The key a file claims, falling back to the one its path implies.
 *
 * Our own files carry their key, because a file name cannot always spell one
 * and because the user is allowed to rename a file without breaking it. A file
 * dropped in by hand carries nothing, so its path is read instead -- which is
 * exactly right for a name that needed no changing.
 *
 * @param {Object} parsed file contents
 * @param {String} file absolute path
 * @param {String} kind key of `KINDS`
 * @returns {String} the item's key
 */
function keyOf(parsed, file, kind) {
  if (parsed && parsed.format === FORMAT && typeof parsed.key === 'string' && parsed.key) {
    return parsed.key;
  }
  const base = path.basename(file).replace(/\.json$/i, '');
  if (KINDS[kind].depth === 1) return base;
  return `${path.basename(path.dirname(file))}/${base}`;
}

/**
 * The key currently stored at a path, if anything is.
 *
 * @param {String} file absolute path
 * @param {String} kind key of `KINDS`
 * @returns {String|null} the occupant's key, or null when the file is absent or
 *   unreadable
 */
function keyAt(file, kind) {
  if (!fs.existsSync(file)) return null;
  try {
    return keyOf(JSON.parse(fs.readFileSync(file, 'utf8')), file, kind);
  } catch (err) {
    return null;
  }
}

/**
 * Absolute path of one item.
 *
 * Two keys can want the same file even when neither needed sanitising, because
 * Windows matches file names without regard to case: `Truss` and `truss` are one
 * file, and the second saved would quietly replace the first. So a file that is
 * already occupied by a *different* key pushes this one onto a digest-suffixed
 * name instead. Nothing is renamed and the common case keeps its clean name --
 * the suffix appears only on the second of two genuinely colliding keys.
 *
 * @param {String} kind key of `KINDS`
 * @param {String} key `manufacturer/model`, or a structure's name
 * @returns {String|null} absolute path, or null when the key does not fit the kind
 */
function pathFor(kind, key) {
  const spec = KINDS[kind];
  if (!spec || typeof key !== 'string' || !key) return null;
  const segments = spec.depth === 1 ? [key] : key.split('/');
  if (segments.length !== spec.depth || segments.some((s) => !s)) return null;
  const safe = segments.map(safeSegment);
  const last = safe.length - 1;
  const folder = path.join(kindRoot(kind), ...safe.slice(0, last));
  const natural = path.join(folder, `${safe[last]}.json`);
  const occupant = keyAt(natural, kind);
  if (occupant === null || occupant === key) return natural;
  return path.join(folder, `${safe[last]}~${digestOf(key)}.json`);
}

/**
 * Every `.json` file under a directory, to the given depth.
 *
 * @param {String} root directory to walk
 * @param {Number} depth how many levels down the files sit
 * @returns {Array} absolute file paths
 */
function filesUnder(root, depth) {
  if (!fs.existsSync(root)) return [];
  if (depth === 1) {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
      .map((entry) => path.join(root, entry.name));
  }
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => filesUnder(path.join(root, entry.name), depth - 1));
}

/**
 * Reads every item of one kind.
 *
 * @param {String} kind key of `KINDS`
 * @returns {Object} key to contents; empty when the kind has nothing stored
 */
function readAll(kind) {
  const root = kindRoot(kind);
  if (!root) return {};
  const items = {};
  filesUnder(root, KINDS[kind].depth).forEach((file) => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const payload = parsed && parsed.format === FORMAT ? parsed.data : parsed;
      if (payload === undefined || payload === null) return;
      items[keyOf(parsed, file, kind)] = payload;
    } catch (err) {
      // One unreadable file is one missing fixture, not an empty library.
      console.error(`[library] skipping ${file}: ${err.message}`);
    }
  });
  return items;
}

/**
 * Writes one item, replacing whatever was there.
 *
 * @param {String} kind key of `KINDS`
 * @param {String} key `manufacturer/model`, or a structure's name
 * @param {String} json serialised contents of the item itself
 * @returns {Boolean} whether the write succeeded
 */
function writeItem(kind, key, json) {
  const target = pathFor(kind, key);
  if (!target || typeof json !== 'string') return false;
  let data;
  try {
    data = JSON.parse(json);
  } catch (err) {
    console.error(`[library] refusing to write malformed ${kind}/${key}: ${err.message}`);
    return false;
  }
  const temporary = `${target}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify({
      format: FORMAT, kind, key, data,
    }, null, 2), 'utf8');
    fs.renameSync(temporary, target);
    return true;
  } catch (err) {
    console.error(`[library] could not write ${kind}/${key}: ${err.message}`);
    return false;
  }
}

/**
 * Removes one item.
 *
 * @param {String} kind key of `KINDS`
 * @param {String} key `manufacturer/model`, or a structure's name
 * @returns {Boolean} whether anything was removed
 */
function removeItem(kind, key) {
  const target = pathFor(kind, key);
  if (!target) return false;
  try {
    if (!fs.existsSync(target)) return false;
    fs.unlinkSync(target);
    return true;
  } catch (err) {
    console.error(`[library] could not remove ${kind}/${key}: ${err.message}`);
    return false;
  }
}

/**
 * Splits the old single-file stores into the library, once.
 *
 * Runs once, recorded by a marker in `userData` -- settings being exactly the
 * kind of thing AppData is for. Folder existence cannot stand in for that any
 * more: the library is in the user's Documents now, where they are free to move
 * or delete it, and re-splitting the old blobs behind their back is not a
 * sensible reading of an empty folder.
 *
 * The originals are deliberately left where they are: a migration that turns out
 * to be wrong should cost nothing to walk back, and a rename has already
 * orphaned this user's data once.
 *
 * @returns {Object} kind to number of items migrated
 */
function migrate() {
  const marker = path.join(app.getPath('userData'), MIGRATION_MARKER);
  if (fs.existsSync(marker)) return {};
  const migrated = {};
  Object.entries(KINDS).forEach(([kind, spec]) => {
    const legacy = path.join(app.getPath('userData'), `${spec.legacy}.json`);
    if (!fs.existsSync(legacy)) return;
    migrated[kind] = 0;
    try {
      const blob = JSON.parse(fs.readFileSync(legacy, 'utf8'));
      Object.entries(blob || {}).forEach(([key, value]) => {
        if (writeItem(kind, key, JSON.stringify(value))) migrated[kind] += 1;
      });
      console.log(`[library] migrated ${migrated[kind]} ${kind} from ${spec.legacy}.json`);
    } catch (err) {
      console.error(`[library] could not migrate ${spec.legacy}.json: ${err.message}`);
    }
  });
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({
      at: new Date().toISOString(), into: libraryRoot(), migrated,
    }, null, 2), 'utf8');
  } catch (err) {
    console.error(`[library] could not record the migration: ${err.message}`);
  }
  return migrated;
}

export default {
  readAll, writeItem, removeItem, migrate, libraryRoot, pathFor,
};
