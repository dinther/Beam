/* eslint-disable no-console */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import paths from './paths';
import jsonstore from './jsonstore';

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
 * How many path segments a kind's key has, and the folder it lives in.
 *
 * @constant {Object} KINDS
 */
const KINDS = {
  profiles: { depth: 2, dir: 'Profiles' },
  structures: { depth: 1, dir: 'Structures' },
  overrides: { depth: 2, dir: 'Overrides' },
};

/** Marks a file as ours and carries the key the filename cannot. */
const FORMAT = 1;

/**
 * Where the keys of already-seeded items are remembered.
 *
 * In the settings directory rather than in the library: which demos a user has
 * been offered is bookkeeping, and the library is meant to hold their work and
 * nothing else.
 *
 * @constant {String} SEED_STORE
 */
const SEED_STORE = 'library-seed';

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
 * Copies the demo items shipped with the app into the user's library.
 *
 * Demo content is only worth anything if it can be found, opened, edited and
 * sent on, so it is put where the user's own items are rather than read out of
 * the install: a demo structure is a structure, and behaves like one.
 *
 * A key is recorded once its item is in place -- written here, or already held
 * by the user under that name. That is what makes a demo the user deleted stay
 * deleted, and what stops one they have edited being replaced on the next
 * launch. A write that failed records nothing, so the next launch tries again
 * rather than quietly leaving the demo out forever.
 *
 * The record only means anything while there is a library for it to describe.
 * A user whose library has gone -- wiped, moved, or a profile that never had
 * one -- is starting again, and starting again includes the demos: the record
 * is dropped rather than read as "already given". Without that, deleting the
 * folder is a one-way door that no reinstall reopens.
 *
 * @public
 * @returns {Number} how many items were written
 */
function seedDefaults() {
  const record = fs.existsSync(libraryRoot()) ? (jsonstore.read(SEED_STORE) || {}) : {};
  const seeded = new Set(Array.isArray(record.seeded) ? record.seeded : []);
  const known = seeded.size;
  let written = 0;

  Object.keys(KINDS).forEach((kind) => {
    const root = path.join(paths.seedRoot(), KINDS[kind].dir);
    filesUnder(root, KINDS[kind].depth).forEach((file) => {
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        // One unreadable demo is one missing demo, not a failed startup.
        console.error(`[library] skipping shipped ${file}: ${err.message}`);
        return;
      }
      const key = keyOf(parsed, file, kind);
      if (seeded.has(`${kind}/${key}`)) return;
      const target = pathFor(kind, key);
      if (!target) return;
      // Whatever the user already has under that name is theirs, and stays --
      // but it counts as given, so we never ask about it again.
      if (fs.existsSync(target)) {
        seeded.add(`${kind}/${key}`);
        return;
      }
      const payload = parsed && parsed.format === FORMAT ? parsed.data : parsed;
      if (payload === undefined || payload === null) return;
      if (!writeItem(kind, key, JSON.stringify(payload))) return;
      seeded.add(`${kind}/${key}`);
      written += 1;
    });
  });

  if (seeded.size !== known) {
    jsonstore.write(SEED_STORE, JSON.stringify({ seeded: [...seeded] }, null, 2));
  }
  return written;
}

export default {
  readAll, writeItem, removeItem, libraryRoot, pathFor, seedDefaults,
};
