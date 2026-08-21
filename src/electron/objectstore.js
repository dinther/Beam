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
 * Model containers worth offering.
 *
 * `.glb` is the packed one and what anyone exporting for a game engine
 * produces; `.gltf` is the same data as JSON with its buffers beside it, which
 * works over this protocol because relative URLs resolve against it.
 *
 * @constant {Array<String>}
 */
const MODEL_EXTENSIONS = ['.glb', '.gltf'];

/** Anything the loader may fetch alongside a `.gltf`: its buffers and textures. */
const COMPANION_EXTENSIONS = ['.bin', '.png', '.jpg', '.jpeg', '.webp', '.ktx2', '.basis'];

/** @returns {String} absolute path of the objects folder */
function objectsRoot() {
  return path.join(library.libraryRoot(), OBJECTS_DIR);
}

/**
 * Every model in the folder.
 *
 * Shallow on purpose: a models folder the user browses in Explorer is easier
 * to reason about flat, and nothing yet needs to group them.
 *
 * @public
 * @returns {Array<Object>} `{ name, file, url, bytes, modified }`, by name
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
  return entries
    .filter((entry) => entry.isFile()
      && MODEL_EXTENSIONS.includes(path.extname(entry.name).toLowerCase()))
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
        // What the renderer hands to GLTFLoader.
        url: `library://${OBJECTS_DIR}/${encodeURIComponent(entry.name)}`,
        bytes: stats.size,
        modified: stats.mtimeMs,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
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
  // `path.resolve` collapses `..` before the containment test, so the test is
  // made against where the path actually lands rather than how it is written.
  const target = path.resolve(root, `.${path.sep}${requestPath}`);
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
  objectsRoot,
  MODEL_EXTENSIONS,
};
