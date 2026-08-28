/* eslint-disable no-console */
/* eslint-disable import/no-extraneous-dependencies */
import fs from 'fs';
import path from 'path';
import { dialog } from 'electron';
import library from './library';
import objectstore from './objectstore';

/**
 * @file The user's environment images (main process).
 *
 * An environment is a photograph of a room's light, and Beam uses two of them:
 * one for the house lights up and one for show time. Until this existed the
 * scene had a single procedural `RoomEnvironment` whose intensity was scaled by
 * the house control, which meant show time was a *dimmed photographic studio* --
 * the same bright-panel-overhead distribution, only darker -- and at the bottom
 * of the range there was nothing left for a metal or a glossy floor to reflect.
 * Two images let each end be shaped like the room it actually is.
 *
 * Files live in the library beside the models rather than being referenced
 * wherever the user happens to keep them, for the reason `objectstore` gives:
 * the renderer is not trusted to name a path, and serving from a known folder
 * is a stronger guarantee than validating an arbitrary one. `add()` is what
 * makes that bearable -- it takes a file from anywhere and copies it in, so the
 * containment is ours to keep rather than the user's to work around.
 *
 * A preference stores the *file name*, never a path. The library can move
 * between machines and the setting still means the same image.
 */

/** Where the user's environment images live. */
function environmentsRoot() {
  return path.join(library.libraryRoot(), objectstore.ENVIRONMENTS_DIR);
}

/**
 * The environments folder, created on demand.
 *
 * Made when first asked for rather than at startup. Asking covers opening the
 * settings, which is the moment the folder becomes worth having: that is where
 * its contents are offered, so that is when somebody wants somewhere to put a
 * file. An installation that never opens the dialog never grows the folder.
 *
 * @returns {String} absolute path
 */
function ensureRoot() {
  const root = environmentsRoot();
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (err) {
    console.error('[environments] cannot create folder:', err.message);
  }
  return root;
}

/**
 * @function list
 * @brief Every environment image in the library.
 *
 * Flat, not recursive. There are only ever a handful of these and they are
 * chosen from a dropdown, so a folder tree would be structure without a
 * purpose.
 *
 * @public
 * @returns {Array<Object>} `{ key, name, url }`, sorted by name
 */
function list() {
  // Created here rather than only in `add()`, so that a user who would sooner
  // copy files in with the file manager has a folder to copy them into.
  const root = ensureRoot();
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    // Unreadable is not a failure worth throwing over: an empty list shows the
    // two built-in choices, which is a working dialog.
    return [];
  }
  return entries
    .filter((entry) => entry.isFile()
      && objectstore.ENVIRONMENT_EXTENSIONS.includes(path.extname(entry.name).toLowerCase()))
    .map((entry) => ({
      key: entry.name,
      name: path.basename(entry.name, path.extname(entry.name)),
      // The same protocol the models use. A radiance image is megabytes of
      // binary and the loaders want a URL to stream, not a structured clone.
      url: `library://environments/${encodeURIComponent(entry.name)}`,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * @function add
 * @brief Asks for a file and copies it into the library.
 *
 * The copy is the point. Referencing the file where it sits would put an
 * absolute path from outside the library into a preference, and then every
 * later load would have to trust it.
 *
 * @public
 * @async
 * @param {Object} window the browser window to attach the dialog to
 * @returns {Promise<Object>} `{ ok, entry }`, or `{ ok: false, reason }`
 */
async function add(window) {
  const result = await dialog.showOpenDialog(window, {
    title: 'Add environment image',
    properties: ['openFile'],
    filters: [
      { name: 'Radiance and OpenEXR', extensions: ['hdr', 'exr'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return { ok: false, reason: 'cancelled' };

  const source = result.filePaths[0];
  const extension = path.extname(source).toLowerCase();
  if (!objectstore.ENVIRONMENT_EXTENSIONS.includes(extension)) {
    return { ok: false, reason: `${extension || 'that file'} is not a radiance image` };
  }

  const root = ensureRoot();
  // `safeName` is the library's own rule for what may become a file name, so an
  // image named by someone else cannot decide where it lands.
  const base = objectstore.safeName(path.basename(source, extension)) || 'environment';
  let name = `${base}${extension}`;
  let target = path.join(root, name);
  // Never silently overwrite: two images with one name are two images.
  for (let n = 2; fs.existsSync(target); n += 1) {
    name = `${base} ${n}${extension}`;
    target = path.join(root, name);
  }

  try {
    fs.copyFileSync(source, target);
  } catch (err) {
    console.error('[environments] copy failed:', err.message);
    return { ok: false, reason: err.message };
  }

  return {
    ok: true,
    entry: {
      key: name,
      name: path.basename(name, extension),
      url: `library://environments/${encodeURIComponent(name)}`,
    },
  };
}

export default { list, add, environmentsRoot };
