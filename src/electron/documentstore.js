/* eslint-disable no-console */
/* eslint-disable import/no-extraneous-dependencies */
import { dialog } from 'electron';
import fs from 'fs';
import path from 'path';
import paths from './paths';

/**
 * Show documents at paths the user chose (main process).
 *
 * A show is a document, not application state. It lives in a project folder the
 * user named and put wherever they wanted, and the application never decides
 * where that is -- it only offers a sensible place to start.
 *
 * A project is a folder holding one `.beam` document, named for the project,
 * alongside whatever that project generates. Windows has no bundle concept, so
 * the document is the thing that gets associated and double-clicked while the
 * folder is what the user thinks of as the project:
 *
 *   Dodecahedron Rig/
 *     Dodecahedron Rig.beam
 *     autorecover/  backups/  exports/
 *
 * The folder wins. `documentIn` returns whichever single `.beam` is inside
 * whatever it happens to be called, so renaming the folder in Explorer leaves a
 * project that still opens, and the document is renamed to match next time it is
 * saved.
 *
 * Nothing here is wired to the interface yet: this is the storage half only, and
 * the show still loads and saves through the named store until the document
 * lifecycle lands.
 */

/** Extension of a show document, and what the dialogs filter on. */
const EXTENSION = '.beam';

/** Subfolders a project keeps beside its document. */
const SUBFOLDERS = ['autorecover', 'backups', 'exports'];

/**
 * Where the save dialog starts when the user has no better idea.
 *
 * Only a starting point: it is created the first time something is saved into
 * it and never otherwise, and nothing stops a project living somewhere else
 * entirely. `Beatline` is a family container, so TapBox and anything after it
 * sit beside this rather than scattering.
 *
 * @returns {String} absolute path
 */
function projectRoot() {
  return paths.beamRoot();
}

/**
 * Whether a path is one we will read or write.
 *
 * The renderer names paths, so it could name any file on the disk. Every
 * document operation is therefore confined to absolute paths ending in our own
 * extension -- the dialogs already return exactly that, and nothing else has any
 * business being written by this module.
 *
 * @param {String} target candidate path
 * @returns {Boolean} whether it may be used
 */
function isDocumentPath(target) {
  return typeof target === 'string'
    && target.length > 0
    && path.isAbsolute(target)
    && path.extname(target).toLowerCase() === EXTENSION;
}

/**
 * The document inside a project folder, whatever it is called.
 *
 * @param {String} folder project folder
 * @returns {String|null} absolute path of the document, or null when the folder
 *   holds no document, or more than one and so names no single project
 */
function documentIn(folder) {
  try {
    const found = fs.readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === EXTENSION)
      .map((entry) => path.join(folder, entry.name));
    return found.length === 1 ? found[0] : null;
  } catch (err) {
    return null;
  }
}

/**
 * What a project is called: the folder's name, not the document's.
 *
 * @param {String} target path of a document
 * @returns {String} project name
 */
function projectNameFor(target) {
  return path.basename(path.dirname(target));
}

/**
 * Where the document *should* sit for a project folder.
 *
 * Used to notice that a folder has been renamed while the document inside it has
 * not, which is the state `documentIn` deliberately tolerates and a save is
 * expected to tidy up.
 *
 * @param {String} folder project folder
 * @returns {String} absolute path the document should have
 */
function documentPathFor(folder) {
  return path.join(folder, `${path.basename(folder)}${EXTENSION}`);
}

/**
 * Reads a document.
 *
 * @param {String} target absolute path of the document
 * @returns {Object|null} parsed contents, or null when unreadable
 */
function read(target) {
  if (!isDocumentPath(target)) return null;
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (err) {
    console.error(`[documentstore] could not read ${target}: ${err.message}`);
    return null;
  }
}

/**
 * Writes a document, creating the project folder around it if needed.
 *
 * Written to a temporary file and renamed over the target, so an interrupted
 * save cannot leave a half-written show behind. Takes serialised JSON because
 * the renderer's state is wrapped in reactive proxies that structured clone
 * cannot carry across IPC.
 *
 * @param {String} target absolute path of the document
 * @param {String} json serialised contents
 * @returns {Boolean} whether the write succeeded
 */
function write(target, json) {
  if (!isDocumentPath(target) || typeof json !== 'string') return false;
  const temporary = `${target}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temporary, json, 'utf8');
    fs.renameSync(temporary, target);
    return true;
  } catch (err) {
    console.error(`[documentstore] could not write ${target}: ${err.message}`);
    return false;
  }
}

/**
 * Creates the folders a project keeps beside its document.
 *
 * Made on demand rather than at save time so an empty project folder is not
 * littered with three empty directories the user has to wonder about.
 *
 * @param {String} target absolute path of the document
 * @param {String} which one of `SUBFOLDERS`
 * @returns {String|null} absolute path of the subfolder, or null
 */
function subfolder(target, which) {
  if (!isDocumentPath(target) || !SUBFOLDERS.includes(which)) return null;
  const folder = path.join(path.dirname(target), which);
  try {
    fs.mkdirSync(folder, { recursive: true });
    return folder;
  } catch (err) {
    console.error(`[documentstore] could not create ${folder}: ${err.message}`);
    return null;
  }
}

/**
 * Asks which document to open.
 *
 * @returns {Promise<String|null>} chosen path, or null when cancelled
 */
async function openDialog() {
  const result = await dialog.showOpenDialog({
    title: 'Open project',
    defaultPath: projectRoot(),
    filters: [{ name: 'Beam project', extensions: ['beam'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
}

/**
 * Asks where to save a document.
 *
 * Suggests the project's own name as the file name, since the folder and the
 * document share it.
 *
 * @param {String} [suggestedName] project name, extension excluded
 * @returns {Promise<String|null>} chosen path, or null when cancelled
 */
async function saveDialog(suggestedName) {
  const name = suggestedName && String(suggestedName).trim() ? String(suggestedName) : 'Untitled';
  const result = await dialog.showSaveDialog({
    title: 'Save project',
    defaultPath: path.join(projectRoot(), name, `${name}${EXTENSION}`),
    filters: [{ name: 'Beam project', extensions: ['beam'] }],
    properties: ['createDirectory'],
  });
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
}

export default {
  read,
  write,
  openDialog,
  saveDialog,
  documentIn,
  documentPathFor,
  projectNameFor,
  projectRoot,
  subfolder,
  EXTENSION,
};
