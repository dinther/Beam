import fs from 'fs';
import path from 'path';
import library from './library';

/**
 * @file 3D models the user has dropped into their library.
 *
 * Everything else in the library is a JSON record small enough to hand over
 * IPC. A model is neither: a single `.glb` runs to megabytes of binary, and
 * `readAll` would try to `JSON.parse` it. So objects are served as files over
 * the `library://` protocol instead, which lets `GLTFLoader` stream one
 * straight from disk rather than marshalling it through a structured clone.
 *
 * The folder is the catalogue. There is no index to keep in step: whatever the
 * user copies into `Library/Objects` is what the app offers, and deleting a
 * file is how it stops offering it. That is the same bargain the rest of the
 * library makes -- see `library.js` on why a file name is not an identity --
 * except that here the name really is all there is, because a `.glb` carries
 * nowhere for us to put a key.
 */

/** Where models live, under the library root. */
const OBJECTS_DIR = 'Objects';

/**
 * Folders the `library://` protocol will serve, by the host segment naming them.
 *
 * Keyed lowercase because a URL host is lowercased before it reaches us, and
 * the folder on disk is capitalised. Anything not listed here is unreachable,
 * whatever it is called or however the request is spelled.
 *
 * @constant {Object}
 */
const SERVED_DIRS = {
  objects: OBJECTS_DIR,
};

/**
 * Model containers worth offering.
 *
 * `.glb` is the packed one and what anyone exporting for a game engine
 * produces; `.gltf` is the same data as JSON with its buffers beside it, which
 * works over this protocol because relative URLs resolve against it.
 *
 * @constant {Array<String>}
 */
const MODEL_EXTENSIONS = ['.glb', '.gltf'];

/**
 * What a created object's file says it is.
 *
 * Primitives live in the same folder as imported models, as plain `.json`.
 * That folder already holds `.json` files, though -- an imported model's
 * sidecar is `<name>.json` beside `<name>.glb` -- so the two have to be told
 * apart. Two things must hold for a `.json` to be an object in its own right:
 * it declares this kind, and no model file shares its base name. A sidecar
 * fails both, and a descriptor cannot be mistaken for one.
 *
 * @constant {String}
 */
const PRIMITIVE_KIND = 'primitive';

/** Shapes the create dialog can write. Anything else is refused. */
const PRIMITIVE_TYPES = ['cube', 'cylinder', 'sphere', 'plane'];

// eslint-disable-next-line no-control-regex
const FORBIDDEN_NAME = /[<>:"/\\|?*\u0000-\u001F]/g;

/** Device names Windows reserves whatever extension follows them. */
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * A file name that means the same thing to the user and to Windows.
 *
 * Simpler than `library.js`'s equivalent because there is no key here: the
 * user names the object and that name is its identity, so there is nothing to
 * append a digest of. A name that cannot be a file name is refused rather than
 * quietly altered -- the dialog can say so while the user is still typing.
 *
 * @param {String} raw
 * @returns {String|null} a usable file name, or null if there isn't one
 */
function safeName(raw) {
  const trimmed = String(raw == null ? '' : raw).trim();
  if (!trimmed) return null;
  const safe = trimmed.replace(FORBIDDEN_NAME, '').replace(/[. ]+$/, '');
  if (!safe || RESERVED_NAME.test(safe)) return null;
  if (safe.length > 120) return null;
  return safe;
}

/** Anything the loader may fetch alongside a `.gltf`: its buffers and textures. */
const COMPANION_EXTENSIONS = ['.bin', '.png', '.jpg', '.jpeg', '.webp', '.ktx2', '.basis'];

/**
 * What a model is taken to mean when nothing says otherwise.
 *
 * glTF's own convention is metres and Y up, and it is the only convention the
 * format states, so it is what an unannotated file is read as. A model that
 * disagrees is corrected by its sidecar rather than by guessing: nothing in a
 * .glb reliably says what a unit was meant to be, and a wrong guess puts a
 * truss in a room at a hundredth of its size with no way to tell why.
 *
 * @constant {Object}
 */
const DEFAULT_METADATA = {
  /** Multiplier taking the file's units to metres. */
  scale: 1,
  /** Which axis of the file points up: 'y' as glTF specifies, or 'z'. */
  upAxis: 'y',
  /** Metres, applied after scale and axis, to bring the origin where it belongs. */
  offset: { x: 0, y: 0, z: 0 },
};

/** @returns {String} absolute path of the objects folder */
function objectsRoot() {
  return path.join(library.libraryRoot(), OBJECTS_DIR);
}

/**
 * What the import step recorded about a model, if anything.
 *
 * A sidecar beside the model rather than anything inside it: the .glb is the
 * user's file and we do not rewrite it, and glTF has nowhere to put "this was
 * authored in millimetres" that a loader would honour. A model with no sidecar
 * still loads -- on glTF's own convention -- which is what keeps "drop a file
 * in the folder and it appears" true.
 *
 * @param {String} file model file name, with extension
 * @returns {Object} the defaults, overlaid with whatever the sidecar says
 */
function metadataFor(file) {
  const sidecar = path.join(objectsRoot(), `${path.basename(file, path.extname(file))}.json`);
  let stored = null;
  try {
    stored = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
  } catch (err) {
    return { ...DEFAULT_METADATA, described: false };
  }
  const payload = stored && stored.data ? stored.data : stored;
  return {
    ...DEFAULT_METADATA,
    ...payload,
    offset: { ...DEFAULT_METADATA.offset, ...(payload.offset || {}) },
    // So the UI can say "this has never been through import" rather than
    // showing defaults as though someone had chosen them.
    described: true,
  };
}

/**
 * A created object's own description, if that is what this file is.
 *
 * Returns null for a sidecar, for a malformed file, and for anything that does
 * not name a shape this app knows how to build -- a descriptor naming a type we
 * have since dropped is not a thing to place, and a listing that offered it
 * would fail at the point of use instead of here.
 *
 * @param {String} file file name, with extension
 * @param {Set<String>} modelBaseNames base names taken by real model files
 * @returns {Object|null} the primitive, or null
 */
function primitiveFor(file, modelBaseNames) {
  const base = path.basename(file, path.extname(file));
  // A sidecar sits beside its model and shares its name, so a taken base name
  // settles it without reading anything.
  if (modelBaseNames.has(base.toLowerCase())) return null;
  let stored = null;
  try {
    stored = JSON.parse(fs.readFileSync(path.join(objectsRoot(), file), 'utf8'));
  } catch (err) {
    return null;
  }
  if (!stored || stored.kind !== PRIMITIVE_KIND) return null;
  if (!PRIMITIVE_TYPES.includes(stored.type)) return null;
  return stored;
}

/**
 * Every object in the folder: models the user imported, and shapes they made.
 *
 * Shallow on purpose: a models folder the user browses in Explorer is easier
 * to reason about flat, and nothing yet needs to group them.
 *
 * A model entry carries a `url` for `GLTFLoader`; a primitive carries its
 * `primitive` description instead and no url, because there is no file for a
 * loader to fetch -- the renderer builds it. `kind` says which.
 *
 * @public
 * @returns {Array<Object>} `{ name, file, kind, ... }`, by name
 */
function list() {
  const root = objectsRoot();
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    // No folder is an empty catalogue, not a failure: the user has simply not
    // put anything there yet.
    return [];
  }

  const files = entries.filter((entry) => entry.isFile());
  const modelBaseNames = new Set(files
    .filter((entry) => MODEL_EXTENSIONS.includes(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.basename(entry.name, path.extname(entry.name)).toLowerCase()));

  const primitives = files
    .filter((entry) => path.extname(entry.name).toLowerCase() === '.json')
    .map((entry) => {
      const primitive = primitiveFor(entry.name, modelBaseNames);
      if (!primitive) return null;
      let stats = null;
      try {
        stats = fs.statSync(path.join(root, entry.name));
      } catch (err) {
        return null;
      }
      return {
        // The descriptor carries the name the user typed, which is allowed to
        // differ from the file name once Windows has had its say about it.
        name: primitive.name || path.basename(entry.name, '.json'),
        file: entry.name,
        kind: PRIMITIVE_KIND,
        primitive,
        bytes: stats.size,
        modified: stats.mtimeMs,
        // A built shape is authored in metres, Z up, at its own origin: there
        // is no file whose convention could disagree.
        ...DEFAULT_METADATA,
        upAxis: 'z',
        described: true,
      };
    })
    .filter(Boolean);

  const models = files
    .filter((entry) => MODEL_EXTENSIONS.includes(path.extname(entry.name).toLowerCase()))
    .map((entry) => {
      const file = path.join(root, entry.name);
      let stats = null;
      try {
        stats = fs.statSync(file);
      } catch (err) {
        return null;
      }
      return {
        // The name the user sees is the file's, minus the extension. They
        // named the file; we do not get to rename it at them.
        name: path.basename(entry.name, path.extname(entry.name)),
        file: entry.name,
        kind: 'model',
        // What the renderer hands to GLTFLoader. Lowercase `objects` because
        // that segment is a URL host, not a folder name -- see `resolve`.
        url: `library://objects/${encodeURIComponent(entry.name)}`,
        bytes: stats.size,
        modified: stats.mtimeMs,
        ...metadataFor(entry.name),
      };
    })
    .filter(Boolean);

  return [...models, ...primitives].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Writes a created object into the library.
 *
 * The name is the identity, so a name already taken is refused rather than
 * silently overwritten -- including by a model, since the two share a folder
 * and a `.json` shadowing a `.glb`'s sidecar would corrupt the model's import
 * settings. The dialog checks first; this is the check that actually counts,
 * because between the two the user may have put a file there by hand.
 *
 * @public
 * @param {String} name what the user called it
 * @param {Object} primitive `{ type, size, color, ... }`
 * @returns {Object} `{ ok, name, file }` or `{ ok: false, reason }`
 */
function writePrimitive(name, primitive) {
  const safe = safeName(name);
  if (!safe) return { ok: false, reason: 'That name cannot be used as a file name.' };
  if (!primitive || !PRIMITIVE_TYPES.includes(primitive.type)) {
    return { ok: false, reason: 'Unknown object type.' };
  }

  const root = objectsRoot();
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (err) {
    return { ok: false, reason: `Could not create ${root}: ${err.message}` };
  }

  const file = `${safe}.json`;
  const target = path.join(root, file);
  const taken = fs.existsSync(target)
    || MODEL_EXTENSIONS.some((ext) => fs.existsSync(path.join(root, `${safe}${ext}`)));
  if (taken) return { ok: false, reason: `${safe} already exists in the object library.` };

  const record = {
    kind: PRIMITIVE_KIND,
    // The typed name, not the file name: the two differ whenever Windows had
    // an opinion, and the user should see what they wrote.
    name: String(name).trim(),
    type: primitive.type,
    size: primitive.size,
    color: primitive.color,
    created: new Date().toISOString(),
  };

  // Written beside the target and renamed over it, so a failure part-way
  // through cannot leave a half-written descriptor the listing would reject.
  const temporary = path.join(root, `.${file}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, target);
  } catch (err) {
    try { fs.unlinkSync(temporary); } catch (cleanupError) { /* nothing to undo */ }
    return { ok: false, reason: `Could not write ${file}: ${err.message}` };
  }

  return { ok: true, name: record.name, file };
}

/**
 * Resolves a `library://` request to a file, or refuses it.
 *
 * Refusing is most of the job. The renderer is not trusted to name a path:
 * this serves read-only, from inside the library root only, and only files
 * whose extension is one a model loader would ask for. A request that escapes
 * the root by any spelling -- `..`, an absolute path, a symlink pointing out
 * -- resolves to null and is answered with a 404 rather than a file.
 *
 * @public
 * @param {String} requestPath path portion of the URL, already decoded
 * @returns {String|null} absolute path, or null when it may not be served
 */
function resolve(requestPath) {
  if (!requestPath) return null;
  const root = library.libraryRoot();

  // The scheme is registered `standard: true`, so Chromium parses a URL with a
  // host: `library://objects/x.glb` arrives as host `objects` and path
  // `/x.glb`. Hosts are lowercased, and the folder on disk is `Objects`, so the
  // first segment cannot be used as a path component -- it is a *kind*, looked
  // up here. That also means only the folders named below are reachable at all,
  // which is a better guarantee than refusing the rest by extension.
  const [kind, ...rest] = requestPath.split('/').filter(Boolean);
  const dir = SERVED_DIRS[String(kind || '').toLowerCase()];
  if (!dir || !rest.length) return null;

  // `path.resolve` collapses `..` before the containment test, so the test is
  // made against where the path actually lands rather than how it is written.
  const target = path.resolve(root, dir, `.${path.sep}${rest.join(path.sep)}`);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;

  const extension = path.extname(target).toLowerCase();
  if (!MODEL_EXTENSIONS.includes(extension) && !COMPANION_EXTENSIONS.includes(extension)) {
    return null;
  }

  // A symlink inside the root may still point outside it, so the containment
  // test is repeated against what the path really is.
  let real;
  try {
    real = fs.realpathSync(target);
  } catch (err) {
    return null;
  }
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch (err) {
    return null;
  }
  const realRelative = path.relative(realRoot, real);
  if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) return null;

  return fs.statSync(real).isFile() ? real : null;
}

export default {
  list,
  resolve,
  metadataFor,
  objectsRoot,
  writePrimitive,
  safeName,
  MODEL_EXTENSIONS,
  PRIMITIVE_TYPES,
  PRIMITIVE_KIND,
  DEFAULT_METADATA,
};
