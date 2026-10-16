import fs from 'fs';
import path from 'path';
import jsonstore from './jsonstore';

/**
 * The projects last opened or saved, newest first, for File > Open Recent
 * (main process).
 *
 * Kept in the application's data directory, as `savefolders.js` keeps its
 * folders: a path belongs to this machine. A project that has been moved or
 * deleted drops off the list the next time it is read.
 */

const STORE = 'recent-projects';
const KEEP = 8;

/** Paths compare without case on Windows, where the file system does too. */
const same = (a, b) => (process.platform === 'win32'
  ? a.toLowerCase() === b.toLowerCase()
  : a === b);

function stored() {
  const paths = jsonstore.read(STORE);
  return Array.isArray(paths) ? paths.filter((entry) => typeof entry === 'string') : [];
}

/**
 * Puts a project at the top of the list.
 *
 * @param {String} target absolute path of the project
 */
function remember(target) {
  if (!target) return;
  const paths = [target, ...stored().filter((entry) => !same(entry, target))].slice(0, KEEP);
  jsonstore.write(STORE, JSON.stringify(paths, null, 2));
}

/**
 * The recent projects that still exist.
 *
 * @param {String} extension the project file extension, with its dot
 * @returns {Array} `{ path, name, folder }`, newest first
 */
function list(extension) {
  return stored()
    .filter((entry) => {
      try {
        return fs.statSync(entry).isFile();
      } catch (err) {
        return false;
      }
    })
    .map((entry) => ({
      path: entry,
      name: path.basename(entry, extension),
      folder: path.dirname(entry),
    }));
}

export default { remember, list };
