/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';
import documentstore from './documentstore';
import library from './library';
import objectstore from './objectstore';
import paths from './paths';

/**
 * Collecting what a show references into its document (main process).
 *
 * An ordinary save writes the show and nothing else: a fixture is named by
 * `manufacturer/model`, an object by its library key, and both are resolved
 * against whatever library the machine has when the file is opened. That is
 * what keeps a profile edit reaching every show that uses it. An export is the
 * one deliberate exception -- a frozen copy, carrying the files it names so
 * that it opens the same way on a machine with a different library, or none.
 *
 * The renderer says *what* is referenced -- it is the only side that knows
 * which profiles and models the show actually places -- and this module finds
 * the files, because the library and the shipped assets are on disk in the
 * main process. Bytes never cross IPC: a model is megabytes.
 *
 * Collected entries sit under `Library/` in the container, laid out exactly as
 * the user's library is, so that an export unpacked by hand is a library
 * folder, and so that a reader resolving project-local first can walk it the
 * way it walks the real one:
 *
 *   Library/Profiles/<manufacturer>/<model>.json
 *   Library/Overrides/<manufacturer>/<model>.json
 *   Library/Objects/[<folder>/]<file>
 *
 * A shipped profile or model is collected too. It is part of *this* version
 * of Beam, and the export may be opened by another.
 */

/** Where collected resources sit in the container. */
const PREFIX = documentstore.LIBRARY_PREFIX;

/** Where shipped fixture profiles live, under the renderer's assets. */
const SHIPPED_FIXTURES_DIR = 'fixtures';

/** Preview images that may sit beside a model or a shape. */
const THUMBNAIL_EXTENSIONS = ['.png', '.jpg', '.webp'];

/**
 * Where the fixture profiles shipped with the app live on disk.
 *
 * @returns {String} absolute path
 */
function shippedFixturesRoot() {
  return paths.rendererAssets(SHIPPED_FIXTURES_DIR);
}

/**
 * The entry name of a library item, from its path under the library root.
 *
 * Forward slashes whatever the platform: this names a zip entry, not a file.
 *
 * @param {String} relative path relative to the library root
 * @returns {String} entry name
 */
function entryFor(relative) {
  return `${PREFIX}${relative.split(path.sep).join('/')}`;
}

/**
 * Reads one file, or says why not.
 *
 * @param {String} file absolute path
 * @returns {Uint8Array|null} contents, or null when unreadable
 */
function bytesOf(file) {
  try {
    return new Uint8Array(fs.readFileSync(file));
  } catch (err) {
    return null;
  }
}

/**
 * A profile's place in the library, whether or not it is there.
 *
 * `pathFor` spells the key the way the library would file it -- sanitised for
 * Windows, digest-suffixed on a collision -- so a shipped profile that was
 * never in the library still lands where the library would put it.
 *
 * @param {String} kind `profiles` or `overrides`
 * @param {String} key `manufacturer/model`
 * @returns {String|null} path relative to the library root, or null for a key
 *   that does not fit
 */
function libraryRelative(kind, key) {
  const absolute = library.pathFor(kind, key);
  return absolute ? path.relative(library.libraryRoot(), absolute) : null;
}

/**
 * The first existing file for a library item, in resolution order.
 *
 * What the open document carries, then the user's library -- the order a
 * load resolves in, so that exporting an opened export freezes what it
 * actually shows rather than what this machine's library happens to hold.
 *
 * @param {String} kind `profiles` or `overrides`
 * @param {String} key `manufacturer/model`
 * @returns {String|null} absolute path, or null when neither has it
 */
function libraryFile(kind, key) {
  const relative = libraryRelative(kind, key);
  if (!relative) return null;
  const mounted = documentstore.mountRoot();
  const candidates = [
    mounted ? path.join(mounted, relative) : null,
    library.pathFor(kind, key),
  ];
  return candidates.find((file) => file && fs.existsSync(file)) || null;
}

/**
 * Collects one fixture profile and its override, if any.
 *
 * The open document, then the user's library, then the shipped set, the
 * order a load resolves in. A shipped profile is wrapped in the library's own
 * file format on the way in, so that the entry carries its key exactly as a
 * library file would and reads back through the same code.
 *
 * @param {String} key `manufacturer/model`
 * @param {Object} entries collected so far, added to
 * @returns {Boolean} whether the profile was found
 */
function collectProfile(key, entries) {
  const relative = libraryRelative('profiles', key);
  if (!relative) return false;

  const override = libraryFile('overrides', key);
  const overrideBytes = override ? bytesOf(override) : null;
  if (overrideBytes) entries[entryFor(libraryRelative('overrides', key))] = overrideBytes;

  const own = libraryFile('profiles', key);
  const ownBytes = own ? bytesOf(own) : null;
  if (ownBytes) {
    entries[entryFor(relative)] = ownBytes;
    return true;
  }

  const shipped = `${path.join(shippedFixturesRoot(), ...key.split('/'))}.json`;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(shipped, 'utf8'));
  } catch (err) {
    return false;
  }
  entries[entryFor(relative)] = JSON.stringify({
    format: 1, kind: 'profiles', key, data,
  }, null, 2);
  return true;
}

/**
 * Files a `.gltf` refers to by relative URI, if any.
 *
 * A `.glb` carries everything; a `.gltf` may keep its buffers and textures in
 * files beside it, and a copy without them is a model that does not load.
 * Data URIs are already inside the file and absolute URIs are not ours to
 * copy.
 *
 * @param {String} file absolute path of the `.gltf`
 * @returns {Array<String>} file names relative to the model's folder
 */
function gltfCompanions(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return [];
  }
  return [...(parsed.buffers || []), ...(parsed.images || [])]
    .map((item) => item && item.uri)
    .filter((uri) => typeof uri === 'string' && uri && !/^(data:|[a-z]+:\/\/)/i.test(uri))
    .map((uri) => decodeURIComponent(uri));
}

/**
 * Collects one object: a model with its sidecar and preview, or a shape.
 *
 * Found through the catalogue rather than by spelling a path from the key,
 * because the catalogue already knows which root the object came from,
 * whether the key was matched without regard to case, and whether it is a
 * model or a shape.
 *
 * @param {Object} entry a catalogue entry from `objectstore.list()`
 * @param {Object} entries collected so far, added to
 * @returns {Boolean} whether the object's own file was found
 */
function collectObject(entry, entries) {
  let root = entry.shipped ? objectstore.shippedRoot() : objectstore.objectsRoot();
  if (entry.collected) {
    // Carried by the open document: copied on from where it was unpacked.
    const mounted = documentstore.mountRoot();
    if (!mounted) return false;
    root = path.join(mounted, objectstore.OBJECTS_DIR);
  }
  const dir = entry.folder ? path.join(root, entry.folder) : root;
  const base = path.basename(entry.file, path.extname(entry.file));
  const relativeDir = [objectstore.OBJECTS_DIR, ...(entry.folder ? [entry.folder] : [])];

  const add = (name) => {
    const bytes = bytesOf(path.join(dir, name));
    if (bytes) entries[entryFor(path.join(...relativeDir, name))] = bytes;
    return !!bytes;
  };

  if (!add(entry.file)) return false;
  if (entry.kind === 'model') {
    add(`${base}.json`);
    if (path.extname(entry.file).toLowerCase() === '.gltf') {
      gltfCompanions(path.join(dir, entry.file)).forEach(add);
    }
  }
  THUMBNAIL_EXTENSIONS.forEach((extension) => add(`${base}${extension}`));
  return true;
}

/**
 * Everything a show references, as container entries.
 *
 * @public
 * @param {Object} wanted `{ profiles, objects }`, each an array of keys
 * @returns {Object} `{ entries, missing }` -- entry name to bytes, and the keys
 *   that no file could be found for
 */
function collect(wanted) {
  const entries = {};
  const missing = [];
  const profiles = Array.isArray(wanted && wanted.profiles) ? wanted.profiles : [];
  const objects = Array.isArray(wanted && wanted.objects) ? wanted.objects : [];

  [...new Set(profiles)].forEach((key) => {
    if (typeof key !== 'string' || !collectProfile(key, entries)) missing.push(`profile ${key}`);
  });

  if (objects.length) {
    // Folded the way the catalogue folds: a key is a file name, and a file name
    // on Windows can change case without anything looking changed.
    const catalogue = new Map();
    objectstore.list().forEach((entry) => {
      catalogue.set(String(entry.key).toLowerCase(), entry);
      const name = String(entry.name).toLowerCase();
      if (!catalogue.has(name)) catalogue.set(name, entry);
    });
    [...new Set(objects)].forEach((key) => {
      const entry = typeof key === 'string' ? catalogue.get(key.toLowerCase()) : null;
      if (!entry || !collectObject(entry, entries)) missing.push(`object ${key}`);
    });
  }

  if (missing.length) {
    console.warn(`[export] ${missing.length} item(s) referenced but not found: ${missing.join(', ')}`);
  }
  return { entries, missing };
}

/**
 * Writes an export: the show with everything it references collected in.
 *
 * @public
 * @param {String} target absolute path of the document
 * @param {String} json serialised show
 * @param {Object} wanted `{ profiles, objects }`, each an array of keys
 * @returns {Object} `{ ok, collected, missing }` -- whether the file was
 *   written, how many entries went in, and the keys no file was found for
 */
function exportTo(target, json, wanted) {
  const { entries, missing } = collect(wanted);
  const ok = documentstore.write(target, json, entries);
  return { ok, collected: Object.keys(entries).length, missing };
}

export default { collect, exportTo };
