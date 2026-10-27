import fs from 'fs';
import path from 'path';
import documentstore from './documentstore';
import library from './library';
import paths from './paths';

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

/** Where the user's radiance images live, under the library root. */
const ENVIRONMENTS_DIR = 'Environments';

/**
 * Image containers an environment may be stored in.
 *
 * Both are high dynamic range and interchangeable in purpose: `.hdr` is
 * Radiance RGBE, which is what most environment libraries publish and what
 * `RGBELoader` reads; `.exr` is OpenEXR, higher precision and larger, read by
 * `EXRLoader`. An 8-bit image is deliberately not accepted -- an environment
 * whose brightest value is white cannot light anything, and letting one in
 * would look like a broken environment rather than an unsuitable file.
 *
 * @constant {Array<String>}
 */
const ENVIRONMENT_EXTENSIONS = ['.hdr', '.exr'];

/** Where the user's image and video files live, under the library root. */
const MEDIA_DIR = 'Media';

/** Still images a video source may be. */
const MEDIA_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];

/** Video files a video source may be: the containers Chromium plays. */
const MEDIA_VIDEO_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.webm'];

/** Every media file a video source may be. */
const MEDIA_EXTENSIONS = [...MEDIA_IMAGE_EXTENSIONS, ...MEDIA_VIDEO_EXTENSIONS];

/** Where the user's ILDA files for laser clip lists live, under the library root. */
const LASERS_DIR = 'Lasers';

/** The files a laser clip list plays. */
const LASER_EXTENSIONS = ['.ild'];

/** Where the user's gobo and animation disc images live, under the library root. */
const GOBOS_DIR = 'Gobos';

/** The images a placement may swap into a gobo or animation wheel slot. */
const GOBO_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.svg'];

/**
 * Folders the `library://` protocol will serve, by the host segment naming them.
 *
 * Keyed lowercase because a URL host is lowercased before it reaches us, and
 * the folder on disk is capitalised. Anything not listed here is unreachable,
 * whatever it is called or however the request is spelled.
 *
 * Each kind carries the extensions it will serve, because they differ: a model
 * folder serves geometry and the textures a glTF references, while an
 * environment folder serves radiance images and nothing else. A null list means
 * the model set.
 *
 * `project` is the models an opened export carries, unpacked by the document
 * store. Its folder moves with the open document, so it is asked for each
 * time rather than fixed here, and there is none at all when the open
 * document carried nothing.
 *
 * @constant {Object}
 */
const SERVED_DIRS = {
  objects: { dir: OBJECTS_DIR, extensions: null },
  environments: { dir: ENVIRONMENTS_DIR, extensions: ENVIRONMENT_EXTENSIONS },
  // Image and video files for a video source: the user's, the open
  // document's, and the ones that ship with Beam.
  media: { dir: MEDIA_DIR, extensions: MEDIA_EXTENSIONS },
  projectmedia: {
    base: () => {
      const mounted = documentstore.mountRoot();
      return mounted ? path.join(mounted, MEDIA_DIR) : null;
    },
    extensions: MEDIA_EXTENSIONS,
  },
  shippedmedia: { base: () => paths.rendererAssets('media'), extensions: MEDIA_EXTENSIONS },
  // ILDA files for laser clip lists: the user's, the open document's, and
  // the ones that ship with Beam.
  lasers: { dir: LASERS_DIR, extensions: LASER_EXTENSIONS },
  projectlasers: {
    base: () => {
      const mounted = documentstore.mountRoot();
      return mounted ? path.join(mounted, LASERS_DIR) : null;
    },
    extensions: LASER_EXTENSIONS,
  },
  shippedlasers: { base: () => paths.rendererAssets('lasers'), extensions: LASER_EXTENSIONS },
  // Gobo and disc images swapped into wheels: the user's, and the open
  // document's carried copies.
  gobos: { dir: GOBOS_DIR, extensions: GOBO_EXTENSIONS },
  projectgobos: {
    base: () => {
      const mounted = documentstore.mountRoot();
      return mounted ? path.join(mounted, GOBOS_DIR) : null;
    },
    extensions: GOBO_EXTENSIONS,
  },
  project: {
    base: () => {
      const mounted = documentstore.mountRoot();
      return mounted ? path.join(mounted, OBJECTS_DIR) : null;
    },
    extensions: null,
  },
  // GDTF fixtures, and nothing else from the Profiles folder: the JSON
  // profiles beside them reach the renderer through the library's own calls.
  profiles: { dir: 'Profiles', extensions: ['.gdtf'] },
  // GDTF fixtures that ship with Beam.
  shippedprofiles: { base: () => paths.rendererAssets('profiles'), extensions: ['.gdtf'] },
  projectprofiles: {
    base: () => {
      const mounted = documentstore.mountRoot();
      return mounted ? path.join(mounted, 'Profiles') : null;
    },
    extensions: ['.gdtf'],
  },
};

/**
 * Model containers worth offering.
 *
 * `.glb` is the packed one and what anyone exporting for a game engine
 * produces; `.gltf` is the same data as JSON with its buffers beside it, which
 * works over this protocol because relative URLs resolve against it. `.obj`,
 * `.fbx` and `.stl` are what CAD tools, DCC tools and vendors' downloads
 * produce. Only glTF states its units and up axis, so the others depend on
 * their sidecar for both.
 *
 * @constant {Array<String>}
 */
const MODEL_EXTENSIONS = ['.glb', '.gltf', '.obj', '.fbx', '.stl'];

/**
 * What the import button accepts. `.gltf` is left out because its buffers and
 * textures are separate files that a single pick cannot bring along; it still
 * loads when copied into the folder by hand.
 *
 * @constant {Array<String>}
 */
const IMPORTABLE_EXTENSIONS = ['.glb', '.obj', '.fbx', '.stl'];

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
const PRIMITIVE_TYPES = ['cube', 'cylinder', 'tube', 'sphere', 'plane', 'truss', 'drape', 'barrier'];

/** Which faces a shape can draw; the renderer's `FACES`. */
const FACES = ['front', 'flipped'];

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

/**
 * Anything a loader may fetch alongside a model: a `.gltf`'s buffers and
 * textures, an `.obj`'s material library and the images that names.
 */
const COMPANION_EXTENSIONS = ['.bin', '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.ktx2', '.basis', '.mtl'];

/**
 * A relative reference that stays inside the model's folder, normalised to
 * forward slashes, or null for one that does not.
 *
 * @param {String} reference as written in the file
 * @returns {String|null}
 */
function localReference(reference) {
  const cleaned = String(reference || '').trim().replace(/\\/g, '/');
  if (!cleaned || /^(data:|[a-z]+:\/\/)/i.test(cleaned) || path.isAbsolute(cleaned)) return null;
  if (/^[a-z]:/i.test(cleaned) || cleaned.split('/').includes('..')) return null;
  return cleaned;
}

/**
 * Files a model refers to by relative path, which have to travel with it.
 *
 * A `.gltf` names its buffers and images. An `.obj` names its material
 * libraries on `mtllib` lines, and each of those names its textures on `map_`
 * lines -- the file is the last word, after any options. A `.glb` carries
 * everything, an `.stl` refers to nothing, and an `.fbx` keeps its references
 * in a binary format read only by the loader, so those give none.
 *
 * References that leave the model's folder, and absolute paths, are left out:
 * nothing outside the folder can be copied to a place it would be found.
 *
 * @public
 * @param {String} file absolute path of the model
 * @returns {Array<String>} paths relative to the model's folder
 */
function companionsOf(file) {
  const extension = path.extname(file).toLowerCase();
  const read = (target) => {
    try {
      return fs.readFileSync(target, 'utf8');
    } catch (err) {
      return null;
    }
  };
  if (extension === '.gltf') {
    let parsed;
    try {
      parsed = JSON.parse(read(file));
    } catch (err) {
      return [];
    }
    return [...((parsed && parsed.buffers) || []), ...((parsed && parsed.images) || [])]
      .map((item) => localReference(item && item.uri && decodeURIComponent(item.uri)))
      .filter(Boolean);
  }
  if (extension !== '.obj') return [];
  const text = read(file);
  if (!text) return [];
  const dir = path.dirname(file);
  const found = new Set();
  [...text.matchAll(/^\s*mtllib\s+(.+?)\s*$/gm)].forEach(([, named]) => {
    const mtl = localReference(named);
    if (!mtl) return;
    found.add(mtl);
    const materials = read(path.join(dir, mtl));
    if (!materials) return;
    const mtlDir = path.posix.dirname(mtl);
    [...materials.matchAll(/^\s*(?:map_\w+|bump|disp|decal|norm)\s+(.+?)\s*$/gim)].forEach(([, rest]) => {
      const words = rest.split(/\s+/);
      const texture = localReference(words[words.length - 1]);
      if (texture) found.add(mtlDir === '.' ? texture : path.posix.join(mtlDir, texture));
    });
  });
  return [...found];
}

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
 * Nothing here is writable: it is inside the install. Save to library always
 * writes to the user's own.
 *
 * @returns {String} absolute path
 */
function shippedRoot() {
  return paths.rendererAssets(SHIPPED_DIR);
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
 * @param {String} [origin] `shipped`, `library`, or `project` for the models an
 *   opened export carries
 * @returns {Array<Object>}
 */
function entriesIn(root, folder, origin = 'library') {
  const shipped = origin === 'shipped';
  const collected = origin === 'project';
  // Served under the host that names the folder: a collected model is not in
  // the library, and `resolve` finds it through the open document instead.
  const host = collected ? 'project' : 'objects';
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

  /**
   * A preview image sitting beside the model, if there is one.
   *
   * `<name>.png` next to `<name>.glb`, the same convention the metadata
   * sidecar already follows -- so it needs no index, works in folders, works
   * for shipped and user objects alike, and a user who wants a better picture
   * drops one in. `.png`, `.jpg` and `.webp` are already served over
   * `library://` because a glTF may reference them as textures.
   *
   * @param {String} base the model's name without extension
   * @returns {Object|null} `{ url }` or `{ staticPath }`, whichever addresses it
   */
  const thumbnailFor = (base) => {
    const found = ['.png', '.jpg', '.webp']
      .map((ext) => `${base}${ext}`)
      .find((candidate) => fs.existsSync(path.join(dir, candidate)));
    if (!found) return null;
    return shipped
      ? { thumbnailStaticPath: [SHIPPED_DIR, ...segmentsFor(found)].map(encodeURIComponent).join('/') }
      : { thumbnailUrl: `library://${host}/${segmentsFor(found).map(encodeURIComponent).join('/')}` };
  };

  // A user model is served over `library://`, which exists because the user's
  // library is outside the app and nothing else can reach it. A shipped one is
  // already part of the renderer's assets, so it goes the way every other
  // shipped asset does -- and the prefix for that is a renderer concern
  // (`VITE_STATIC_URL` is empty in dev, where Vite serves `public/` itself),
  // so main hands over the relative path and lets the renderer address it.
  const urlFor = (file) => (shipped
    ? null
    : `library://${host}/${segmentsFor(file).map(encodeURIComponent).join('/')}`);
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
        ...(thumbnailFor(path.basename(entry.name, path.extname(entry.name))) || {}),
        shipped,
        collected,
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
        // Which faces placements of it draw; absent is the type's own.
        ...(FACES.includes(primitive.faces) ? { faces: primitive.faces } : {}),
        shipped,
        collected,
        ...(thumbnailFor(path.basename(entry.name, '.json')) || {}),
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
function catalogue(root, origin) {
  let top = [];
  try {
    top = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    // No folder is an empty catalogue, not a failure: the user has simply not
    // put anything there yet, and a build may ship none at all.
    return [];
  }
  const all = entriesIn(root, null, origin);
  top
    .filter((entry) => entry.isDirectory())
    .forEach((entry) => all.push(...entriesIn(root, entry.name, origin)));
  return all;
}

/**
 * The object catalogue, merged across its roots.
 *
 * @public
 * @param {Object} [options]
 * @param {Boolean} [options.project] include what the open document carries;
 *   left out, a refresh can ask what this machine alone would supply
 * @returns {Array<Object>} catalogue entries
 */
function list({ project = true } = {}) {
  // Shipped first, then the user's over the top of it, then what the open
  // document carries over both. A key present twice resolves to the later --
  // the same order profiles follow, project-local then user library then
  // shipped -- so somebody can replace a supplied truss with their own without
  // deleting anything, and get the supplied one back by removing theirs; and
  // an export opened on another machine draws the truss it was made with.
  // Merged case-insensitively. The keys come from file names on a filesystem
  // that does not distinguish `Sub_Speaker` from `Sub_speaker`, so two spellings
  // of one model are one model -- and a user copy has to override the supplied
  // one even when the two were saved with different capitalisation. Compared
  // folded, stored unfolded: the entry keeps the key it was found under, which
  // is what a show records and what the browser shows.
  const merged = new Map();
  const fold = (key) => String(key).toLowerCase();
  catalogue(shippedRoot(), 'shipped').forEach((entry) => merged.set(fold(entry.key), entry));
  catalogue(objectsRoot(), 'library').forEach((entry) => merged.set(fold(entry.key), entry));
  const mountedObjects = project ? SERVED_DIRS.project.base() : null;
  if (mountedObjects) {
    catalogue(mountedObjects, 'project').forEach((entry) => merged.set(fold(entry.key), entry));
  }

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
function writePrimitive(name, primitive, folder = null, { overwrite = false } = {}) {
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
  const where = safeFolder ? `${safeFolder}/${safe}` : safe;
  // An imported model is a file the user brought, and a shape cannot stand in
  // for it -- refused whatever the caller asked, overwrite or not.
  if (MODEL_EXTENSIONS.some((ext) => fs.existsSync(path.join(dir, `${safe}${ext}`)))) {
    return { ok: false, reason: `${where} is an imported model and cannot be replaced by a shape.` };
  }
  // A shape of the same name is only replaced when the caller says so, which
  // the widget does after asking. `exists` tells it that asking is the thing
  // to do, rather than reporting a failure.
  let previous = null;
  if (fs.existsSync(target)) {
    if (!overwrite) {
      return { ok: false, exists: true, reason: `${where} already exists in the object library.` };
    }
    try {
      previous = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch (err) {
      previous = null;
    }
    // Only a shape's descriptor is ours to replace. Anything else under that
    // name is left exactly as it is.
    if (!previous || previous.kind !== PRIMITIVE_KIND) {
      return { ok: false, reason: `${where} is not a shape and cannot be overwritten.` };
    }
  }

  const record = {
    kind: PRIMITIVE_KIND,
    // The typed name, not the file name: the two differ whenever Windows had
    // an opinion, and the user should see what they wrote.
    name: String(name).trim(),
    type: primitive.type,
    size: primitive.size,
    color: primitive.color,
    ...(FACES.includes(primitive.faces) ? { faces: primitive.faces } : {}),
    // An overwrite keeps the entry's birth date and says when it changed.
    created: (previous && previous.created) || new Date().toISOString(),
    ...(previous ? { modified: new Date().toISOString() } : {}),
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
 * Stores a generated preview image beside its model.
 *
 * Beside the model rather than in a cache directory, because that is where an
 * author-supplied image goes -- so `list` finds it with the code it already
 * has, folders work, the user can replace or delete one like any other file,
 * and there is no second place for a picture to hide.
 *
 * The key is resolved through `list` rather than by rebuilding a path from it:
 * the catalogue already knows which root and which folder every key came from,
 * and reconstructing that here would be a second answer to the same question.
 *
 * Never overwrites: an image that exists was either supplied by the user or
 * generated already, and neither wants replacing behind their back.
 *
 * @public
 * @param {String} key the library key, `folder/name` or `name`
 * @param {String} dataUrl a `data:image/png;base64,...` url
 * @returns {Object} `{ ok }` or `{ ok: false, reason }`
 */
function writeThumbnail(key, dataUrl) {
  const entry = list().find((candidate) => candidate.key === key);
  if (!entry) return { ok: false, reason: 'No such object.' };
  // A collected model lives in a cache that goes when the document closes; a
  // preview written there would be lost, and one written to the library would
  // sit beside no model.
  if (entry.collected) return { ok: false, reason: 'The object belongs to the open export.' };

  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!match) return { ok: false, reason: 'Not a PNG data url.' };

  // A shipped model lives inside the install and is not ours to write to at
  // runtime. Those are rendered once during development, where `public/` is an
  // ordinary writable folder, and committed with the build.
  const root = entry.shipped ? shippedRoot() : objectsRoot();
  const dir = entry.folder ? path.join(root, entry.folder) : root;
  const base = path.basename(entry.file, path.extname(entry.file));
  const target = path.join(dir, `${base}.png`);
  if (fs.existsSync(target)) return { ok: false, reason: 'A preview already exists.' };

  try {
    fs.writeFileSync(target, Buffer.from(match[1], 'base64'));
  } catch (err) {
    // A read-only install is the ordinary case here, not a fault: the browser
    // simply keeps showing the placeholder.
    return { ok: false, reason: `Could not write ${target}: ${err.message}` };
  }
  return {
    ok: true, file: `${base}.png`, folder: entry.folder, shipped: entry.shipped,
  };
}

/**
 * Imports under way: copied into the library, not yet described. By id, each
 * `{ dir, file, copied }` -- the model's file name and every file the copy
 * added, so a cancel removes exactly those.
 */
const pendingImports = new Map();

/** Next pending import id. */
let nextImportId = 1;

/**
 * Whether a base name is free in a folder: no model, sidecar, descriptor or
 * preview uses it. A preview counts because `list` pairs `<name>.png` with the
 * model of that name.
 *
 * @param {String} dir absolute folder
 * @param {String} base name without extension
 * @returns {Boolean}
 */
function baseNameFree(dir, base) {
  const taken = [...MODEL_EXTENSIONS, '.json', '.png', '.jpg', '.webp'];
  return !taken.some((extension) => fs.existsSync(path.join(dir, `${base}${extension}`)));
}

/**
 * Copies a model the user picked, and the files it refers to, into the root of
 * `Library/Objects`.
 *
 * Copied because the library is the catalogue: a reference to a file outside
 * it would stop working the day that file moved. The model gets a name nothing
 * in the folder uses; a companion keeps its own name, because the model refers
 * to it by that name. A companion already present with the same bytes is
 * shared, and one present with different bytes is left alone and reported --
 * overwriting it would change a model already in the library.
 *
 * Nothing describes the model yet. `finishImport` writes its sidecar and
 * `cancelImport` takes the copy back out.
 *
 * @public
 * @param {String} source absolute path of the picked file
 * @returns {Object} `{ ok, id, entry, skipped }` or `{ ok: false, reason }`
 */
function importModel(source) {
  const extension = path.extname(source || '').toLowerCase();
  if (!IMPORTABLE_EXTENSIONS.includes(extension)) {
    return { ok: false, reason: `${extension || 'That file'} is not a model Beam can import.` };
  }
  const dir = objectsRoot();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { ok: false, reason: `Could not create ${dir}: ${err.message}` };
  }

  const stem = safeName(path.basename(source, path.extname(source))) || 'object';
  let base = stem;
  for (let n = 2; !baseNameFree(dir, base); n += 1) base = `${stem} ${n}`;
  const file = `${base}${extension}`;

  const copied = [];
  const skipped = [];
  const undo = () => copied.forEach((name) => {
    try { fs.unlinkSync(path.join(dir, name)); } catch (err) { /* already gone */ }
  });
  try {
    fs.copyFileSync(source, path.join(dir, file));
    copied.push(file);
    const from = path.dirname(source);
    companionsOf(source).forEach((relative) => {
      const origin = path.join(from, relative);
      const target = path.join(dir, relative);
      if (!fs.existsSync(origin)) {
        skipped.push(`${relative} (not found beside the model)`);
        return;
      }
      if (fs.existsSync(target)) {
        if (!fs.readFileSync(target).equals(fs.readFileSync(origin))) {
          skipped.push(`${relative} (a different file of that name is already in the library)`);
        }
        return;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(origin, target);
      copied.push(relative);
    });
  } catch (err) {
    undo();
    return { ok: false, reason: `Could not copy the model: ${err.message}` };
  }

  const id = nextImportId;
  nextImportId += 1;
  pendingImports.set(id, { dir, file, copied });
  return {
    ok: true,
    id,
    skipped,
    entry: {
      name: base,
      file,
      key: base,
      kind: 'model',
      url: `library://objects/${encodeURIComponent(file)}`,
    },
  };
}

/**
 * Describes an imported model and makes it a library object.
 *
 * Writes the sidecar with the units and up axis the user chose, and renames
 * the model when they changed its name. Only the model is renamed: its
 * companions are referred to by their own names from inside it.
 *
 * @public
 * @param {Number} id from `importModel`
 * @param {Object} settings `{ name, scale, upAxis }`
 * @returns {Object} `{ ok, key }` or `{ ok: false, reason }`
 */
function finishImport(id, { name, scale, upAxis } = {}) {
  const pending = pendingImports.get(id);
  if (!pending) return { ok: false, reason: 'That import is no longer open.' };
  const { dir } = pending;
  const extension = path.extname(pending.file);
  const current = path.basename(pending.file, extension);

  let base = current;
  const wanted = safeName(name);
  if (!wanted) return { ok: false, reason: 'That name cannot be used as a file name.' };
  if (wanted !== current) {
    if (!baseNameFree(dir, wanted)) {
      return { ok: false, reason: `${wanted} is already in the object library.` };
    }
    try {
      fs.renameSync(path.join(dir, pending.file), path.join(dir, `${wanted}${extension}`));
    } catch (err) {
      return { ok: false, reason: `Could not rename the model: ${err.message}` };
    }
    base = wanted;
  }

  const factor = Number(scale);
  const sidecar = {
    ...DEFAULT_METADATA,
    scale: Number.isFinite(factor) && factor > 0 ? factor : 1,
    upAxis: String(upAxis).toLowerCase() === 'z' ? 'z' : 'y',
  };
  try {
    fs.writeFileSync(path.join(dir, `${base}.json`), `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');
  } catch (err) {
    return { ok: false, reason: `Could not write ${base}.json: ${err.message}` };
  }
  pendingImports.delete(id);
  return { ok: true, key: keyFor(null, base) };
}

/**
 * Takes a cancelled import back out of the library: every file its copy
 * added, and nothing that was there before it.
 *
 * @public
 * @param {Number} id from `importModel`
 * @returns {Object} `{ ok }`
 */
function cancelImport(id) {
  const pending = pendingImports.get(id);
  if (!pending) return { ok: true };
  pending.copied.forEach((name) => {
    try { fs.unlinkSync(path.join(pending.dir, name)); } catch (err) { /* already gone */ }
  });
  pendingImports.delete(id);
  return { ok: true };
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
  const served = SERVED_DIRS[String(kind || '').toLowerCase()];
  if (!served || !rest.length) return null;

  // `path.resolve` collapses `..` before the containment test, so the test is
  // made against where the path actually lands rather than how it is written.
  //
  // Contained in the *kind's* folder, not merely in the library: against the
  // library root, `environments/../x.hdr` would land on a file beside the
  // folder and be served -- inside the library, with an allowed extension, so
  // nothing else would stop it.
  const base = served.base ? served.base() : path.join(root, served.dir);
  if (!base) return null;
  const target = path.resolve(base, `.${path.sep}${rest.join(path.sep)}`);
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;

  const extension = path.extname(target).toLowerCase();
  const allowed = served.extensions || [...MODEL_EXTENSIONS, ...COMPANION_EXTENSIONS];
  if (!allowed.includes(extension)) return null;

  // A symlink inside the root may still point outside it, so the containment
  // test is repeated against what the path really is.
  let real;
  try {
    real = fs.realpathSync(target);
  } catch (err) {
    return null;
  }
  let realBase;
  try {
    realBase = fs.realpathSync(base);
  } catch (err) {
    // No folder of that kind yet, so there is nothing in it to serve.
    return null;
  }
  const realRelative = path.relative(realBase, real);
  if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) return null;

  return fs.statSync(real).isFile() ? real : null;
}

export default {
  list,
  keyFor,
  resolve,
  metadataFor,
  objectsRoot,
  shippedRoot,
  writePrimitive,
  writeThumbnail,
  importModel,
  finishImport,
  cancelImport,
  companionsOf,
  safeName,
  MODEL_EXTENSIONS,
  IMPORTABLE_EXTENSIONS,
  OBJECTS_DIR,
  ENVIRONMENTS_DIR,
  ENVIRONMENT_EXTENSIONS,
  MEDIA_DIR,
  MEDIA_IMAGE_EXTENSIONS,
  MEDIA_VIDEO_EXTENSIONS,
  MEDIA_EXTENSIONS,
  LASERS_DIR,
  LASER_EXTENSIONS,
  GOBOS_DIR,
  GOBO_EXTENSIONS,
  PRIMITIVE_TYPES,
  PRIMITIVE_KIND,
  DEFAULT_METADATA,
};
