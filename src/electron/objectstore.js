import fs from 'fs';
import path from 'path';
import { is } from '@electron-toolkit/utils';
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

/** Where the user's models live, under the library root. */
const OBJECTS_DIR = 'Objects';

/**
 * Where the models that ship with the app live, under the renderer's assets.
 *
 * The same bargain the user's folder makes -- one level of folders, no index,
 * the directory *is* the catalogue -- so a model is added to the product by
 * putting a file in it, exactly as a user adds one to theirs.
 *
 * @constant {String}
 */
const SHIPPED_DIR = 'objects';

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
 * append a digest of.
 *
 * Characters Windows will not take are stripped; null comes back only when
 * nothing usable is left, or when what remains is a reserved device name. The
 * caller is expected to show the user what was actually written -- and callers
 * that need a *rejection* rather than a repair, as a folder name does, must
 * test for themselves first.
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

/** @returns {String} absolute path of the user's objects folder */
function objectsRoot() {
  return path.join(library.libraryRoot(), OBJECTS_DIR);
}

/**
 * Absolute path of the models that ship with the app.
 *
 * Two places, because the renderer's assets are in two places. Packaged, they
 * sit beside the built renderer -- the same root the `static://` handler
 * serves from. In development Vite serves `public/` straight from the project,
 * and this file is bundled into `out/main`, so the project root is two levels
 * up.
 *
 * Nothing here is writable: it is inside the install. Save to library always
 * writes to the user's own.
 *
 * @returns {String} absolute path
 */
function shippedRoot() {
  return is.dev
    ? path.join(__dirname, '..', '..', 'public', SHIPPED_DIR)
    : path.join(__dirname, '..', 'renderer', SHIPPED_DIR);
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
function metadataFor(file, folder = null, root = null) {
  const base = root || objectsRoot();
  const dir = folder ? path.join(base, folder) : base;
  const sidecar = path.join(dir, `${path.basename(file, path.extname(file))}.json`);
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
function primitiveFor(file, modelBaseNames, folder = null, root = null) {
  const base = path.basename(file, path.extname(file));
  // A sidecar sits beside its model and shares its name, so a taken base name
  // settles it without reading anything. Names are only compared within one
  // folder, which is the only place a sidecar can sit.
  if (modelBaseNames.has(base.toLowerCase())) return null;
  const from = root || objectsRoot();
  const dir = folder ? path.join(from, folder) : from;
  let stored = null;
  try {
    stored = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  } catch (err) {
    return null;
  }
  if (!stored || stored.kind !== PRIMITIVE_KIND) return null;
  if (!PRIMITIVE_TYPES.includes(stored.type)) return null;
  return stored;
}

/**
 * The key an object is referenced by, and stored under in a showfile.
 *
 * A path when the object sits in a folder, a bare name when it does not. It has
 * to be the path: two folders may each hold a `truss.glb`, and the show would
 * have no way to say which it meant. A bare name for a root object keeps every
 * show written before folders existed resolving unchanged.
 *
 * Forward slash whatever the platform, because this is an identifier that goes
 * in a file, not a path to open.
 *
 * @param {String|null} folder
 * @param {String} name
 * @returns {String}
 */
function keyFor(folder, name) {
  return folder ? `${folder}/${name}` : name;
}

/**
 * Everything in one directory, as catalogue entries.
 *
 * @param {String} root the catalogue root this belongs to
 * @param {String|null} folder the folder under it, or null for the root itself
 * @param {Boolean} [shipped] whether this root ships with the app
 * @returns {Array<Object>}
 */
function entriesIn(root, folder, shipped = false) {
  const dir = folder ? path.join(root, folder) : root;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return [];
  }

  const files = entries.filter((entry) => entry.isFile());
  const modelBaseNames = new Set(files
    .filter((entry) => MODEL_EXTENSIONS.includes(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.basename(entry.name, path.extname(entry.name)).toLowerCase()));

  // The url's path segments are encoded separately: a folder called "Stage
  // Props" has to survive as two segments rather than becoming one escaped
  // blob, and `resolve` splits on `/` before touching the filesystem.
  const segmentsFor = (file) => (folder ? [folder, file] : [file]);

  // A user model is served over `library://`, which exists because the user's
  // library is outside the app and nothing else can reach it. A shipped one is
  // already part of the renderer's assets, so it goes the way every other
  // shipped asset does -- and the prefix for that is a renderer concern
  // (`VITE_STATIC_URL` is empty in dev, where Vite serves `public/` itself),
  // so main hands over the relative path and lets the renderer address it.
  const urlFor = (file) => (shipped
    ? null
    : `library://objects/${segmentsFor(file).map(encodeURIComponent).join('/')}`);
  const staticPathFor = (file) => (shipped
    ? [SHIPPED_DIR, ...segmentsFor(file)].map(encodeURIComponent).join('/')
    : null);

  const stat = (file) => {
    try {
      return fs.statSync(path.join(dir, file));
    } catch (err) {
      return null;
    }
  };

  const models = files
    .filter((entry) => MODEL_EXTENSIONS.includes(path.extname(entry.name).toLowerCase()))
    .map((entry) => {
      const stats = stat(entry.name);
      if (!stats) return null;
      const name = path.basename(entry.name, path.extname(entry.name));
      return {
        name,
        folder,
        key: keyFor(folder, name),
        file: entry.name,
        kind: 'model',
        url: urlFor(entry.name),
        staticPath: staticPathFor(entry.name),
        shipped,
        bytes: stats.size,
        modified: stats.mtimeMs,
        ...metadataFor(entry.name, folder, root),
      };
    })
    .filter(Boolean);

  const primitives = files
    .filter((entry) => path.extname(entry.name).toLowerCase() === '.json')
    .map((entry) => {
      const primitive = primitiveFor(entry.name, modelBaseNames, folder, root);
      if (!primitive) return null;
      const stats = stat(entry.name);
      if (!stats) return null;
      const name = primitive.name || path.basename(entry.name, '.json');
      return {
        name,
        folder,
        key: keyFor(folder, name),
        file: entry.name,
        kind: PRIMITIVE_KIND,
        primitive,
        shipped,
        bytes: stats.size,
        modified: stats.mtimeMs,
        // A built shape is authored in metres, Z up, about its own origin --
        // there is no file whose convention could disagree.
        ...DEFAULT_METADATA,
        upAxis: 'z',
        described: true,
      };
    })
    .filter(Boolean);

  return [...models, ...primitives];
}

/**
 * Every object in the library: models the user imported, and shapes they made.
 *
 * **One level of folders**, and deliberately no more. A folder is a category --
 * Trusses, Speakers -- which is all anybody has wanted, and the item list this
 * feeds nests exactly one level too. Arbitrary depth would mean a recursive
 * list component for no gain anyone has asked for.
 *
 * A model entry carries a `url` for `GLTFLoader`; a primitive carries its
 * `primitive` description instead and no url, because there is no file for a
 * loader to fetch -- the renderer builds it. `kind` says which. Both carry a
 * `folder` and the `key` they are referenced by.
 *
 * @public
 * @returns {Array<Object>} sorted by folder, then name
 */
function catalogue(root, shipped) {
  let top = [];
  try {
    top = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    // No folder is an empty catalogue, not a failure: the user has simply not
    // put anything there yet, and a build may ship none at all.
    return [];
  }
  const all = entriesIn(root, null, shipped);
  top
    .filter((entry) => entry.isDirectory())
    .forEach((entry) => all.push(...entriesIn(root, entry.name, shipped)));
  return all;
}

function list() {
  // Shipped first, then the user's over the top of it. A key present in both
  // resolves to the user's -- the same order profiles follow, project-local
  // then user library then shipped -- so somebody can replace a supplied truss
  // with their own without deleting anything, and get the supplied one back by
  // removing theirs.
  const merged = new Map();
  catalogue(shippedRoot(), true).forEach((entry) => merged.set(entry.key, entry));
  catalogue(objectsRoot(), false).forEach((entry) => merged.set(entry.key, entry));

  return [...merged.values()].sort((a, b) => {
    // Root objects first, then folders alphabetically, then by name -- so the
    // listing reads the way the folder does in Explorer.
    if ((a.folder || '') !== (b.folder || '')) {
      return (a.folder || '').localeCompare(b.folder || '');
    }
    return a.name.localeCompare(b.name);
  });
}

/**
 * Writes a created object into the library.
 *
 * The name is the identity within its folder, so a name already taken there is
 * refused rather than silently overwritten -- including by a model, since the
 * two share a directory and a `.json` shadowing a `.glb`'s sidecar would
 * corrupt the model's import settings. The dialog checks first; this is the
 * check that counts, because between the two the user may have put a file
 * there by hand.
 *
 * @public
 * @param {String} name what the user called it
 * @param {Object} primitive `{ type, size, color, ... }`
 * @param {String} [folder] a category under Objects, or null for the root
 * @returns {Object} `{ ok, name, file, key }` or `{ ok: false, reason }`
 */
function writePrimitive(name, primitive, folder = null) {
  const safe = safeName(name);
  if (!safe) return { ok: false, reason: 'That name cannot be used as a file name.' };
  if (!primitive || !PRIMITIVE_TYPES.includes(primitive.type)) {
    return { ok: false, reason: 'Unknown object type.' };
  }

  // One level, and the folder is a name rather than a path: anything with a
  // separator in it would be a way to write outside the catalogue.
  let safeFolder = null;
  if (folder) {
    // Refused outright rather than sanitised. `safeName` would strip the
    // separators out of `../../evil` and hand back `....evil` -- safe, in that
    // it cannot escape, but a folder silently appearing under a name nobody
    // typed is worse than being told no. A folder name with a separator in it
    // means the caller is confused or hostile, and neither wants a rename.
    if (/[\\/]/.test(folder) || /^\.+$/.test(String(folder).trim())) {
      return { ok: false, reason: 'A folder is a name, not a path.' };
    }
    safeFolder = safeName(folder);
    if (!safeFolder) return { ok: false, reason: 'That folder name cannot be used.' };
  }

  const dir = safeFolder ? path.join(objectsRoot(), safeFolder) : objectsRoot();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { ok: false, reason: `Could not create ${dir}: ${err.message}` };
  }

  const file = `${safe}.json`;
  const target = path.join(dir, file);
  const taken = fs.existsSync(target)
    || MODEL_EXTENSIONS.some((ext) => fs.existsSync(path.join(dir, `${safe}${ext}`)));
  if (taken) {
    const where = safeFolder ? `${safeFolder}/${safe}` : safe;
    return { ok: false, reason: `${where} already exists in the object library.` };
  }

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
  const temporary = path.join(dir, `.${file}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}
`, 'utf8');
    fs.renameSync(temporary, target);
  } catch (err) {
    try { fs.unlinkSync(temporary); } catch (cleanupError) { /* nothing to undo */ }
    return { ok: false, reason: `Could not write ${file}: ${err.message}` };
  }

  return {
    ok: true, name: record.name, file, folder: safeFolder, key: keyFor(safeFolder, record.name),
  };
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
  keyFor,
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
