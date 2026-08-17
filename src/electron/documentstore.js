/* eslint-disable no-console */
/* eslint-disable import/no-extraneous-dependencies */
import { dialog } from 'electron';
import {
  unzipSync, zipSync, strFromU8, strToU8,
} from 'fflate';
import fs from 'fs';
import path from 'path';
import paths from './paths';

/**
 * Show documents at paths the user chose (main process).
 *
 * A show is a document, not application state. It lives wherever the user put
 * it, under whatever name they gave it, and the application never decides that
 * -- it only offers a sensible place to start.
 *
 * A `.beam` is a zip. That is what lets a Save dialog behave the way everyone
 * expects: you type a name, you get a file with that name, and nothing is
 * created or moved behind you. A project *folder* would have meant typing a
 * file name and receiving a directory, which is what made every earlier version
 * of this jarring. The container also makes Export nearly free -- it is the
 * same file with the referenced resources collected into it.
 *
 * Inside:
 *
 *   manifest.json   what wrote this, and which format it is
 *   show.json       the show itself
 *   Library/...     only in an export, where resources travel with the show
 *
 * Deliberately absent: backups and version history. Automatic recovery is
 * application data and belongs in AppData; keeping old versions of someone's
 * work is their filesystem's job, not ours.
 */

/** Extension of a show document, and what the dialogs filter on. */
const EXTENSION = '.beam';

/** Entry holding the show itself. */
const SHOW_ENTRY = 'show.json';

/** Entry describing the container. */
const MANIFEST_ENTRY = 'manifest.json';

/** Where collected resources sit in an export. */
const LIBRARY_PREFIX = 'Library/';

/** Container format, bumped only when an older reader would misread a newer file. */
const FORMAT = 1;

/**
 * Where the save dialog starts when the user has no better idea.
 *
 * Only a starting point: nothing stops a project living somewhere else
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
 * document operation is confined to absolute paths carrying our own extension
 * -- the dialogs already return exactly that, and nothing else has any business
 * being written by this module.
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
 * What a project is called: its own file name, without the extension.
 *
 * @param {String} target path of a document
 * @returns {String} project name
 */
function projectNameFor(target) {
  return path.basename(target, EXTENSION);
}

/**
 * Opens the container.
 *
 * @param {String} target absolute path
 * @returns {Object|null} entry name to bytes, or null when unreadable
 */
function entriesOf(target) {
  try {
    return unzipSync(new Uint8Array(fs.readFileSync(target)));
  } catch (err) {
    console.error(`[documentstore] could not open ${target}: ${err.message}`);
    return null;
  }
}

/**
 * Reads the show out of a document.
 *
 * @param {String} target absolute path of the document
 * @returns {Object|null} the show, or null when unreadable
 */
function read(target) {
  if (!isDocumentPath(target)) return null;
  const entries = entriesOf(target);
  if (!entries) return null;
  if (!entries[SHOW_ENTRY]) {
    console.error(`[documentstore] ${target} carries no ${SHOW_ENTRY}`);
    return null;
  }
  try {
    return JSON.parse(strFromU8(entries[SHOW_ENTRY]));
  } catch (err) {
    console.error(`[documentstore] ${target} has an unreadable show: ${err.message}`);
    return null;
  }
}

/**
 * Resources a document carries besides the show.
 *
 * Only an export has any. An ordinary save references the user's library where
 * it stands, so that editing a profile still reaches every show using it; an
 * export is the deliberate exception, the frozen copy.
 *
 * @param {String} target absolute path of the document
 * @returns {Object} entry name to parsed contents
 */
function readResources(target) {
  if (!isDocumentPath(target)) return {};
  const entries = entriesOf(target);
  if (!entries) return {};
  return Object.keys(entries)
    .filter((name) => name.startsWith(LIBRARY_PREFIX) && name.toLowerCase().endsWith('.json'))
    .reduce((collected, name) => {
      try {
        return { ...collected, [name]: JSON.parse(strFromU8(entries[name])) };
      } catch (err) {
        console.error(`[documentstore] skipping ${name} in ${target}: ${err.message}`);
        return collected;
      }
    }, {});
}

/**
 * Writes a document.
 *
 * Built to a temporary file and renamed over the target, so an interrupted save
 * cannot leave a half-written show behind. Takes serialised JSON because the
 * renderer's state is wrapped in reactive proxies that structured clone cannot
 * carry across IPC.
 *
 * @param {String} target absolute path of the document
 * @param {String} json serialised show
 * @param {Object} [resources] entry path to serialised contents, collected into
 *   the container -- which makes this an export rather than an ordinary save
 * @returns {Boolean} whether the write succeeded
 */
function write(target, json, resources) {
  if (!isDocumentPath(target) || typeof json !== 'string') return false;
  const collected = resources || {};
  const manifest = {
    format: FORMAT,
    application: 'Beatline Beam',
    savedAt: new Date().toISOString(),
    collected: Object.keys(collected).length > 0,
  };
  const entries = {
    [MANIFEST_ENTRY]: strToU8(JSON.stringify(manifest, null, 2)),
    [SHOW_ENTRY]: strToU8(json),
  };
  Object.entries(collected).forEach(([name, contents]) => {
    if (typeof contents === 'string') entries[name] = strToU8(contents);
  });
  const temporary = `${target}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // A show is small and mostly repeated JSON, so compression costs
    // milliseconds and saves most of the file.
    fs.writeFileSync(temporary, Buffer.from(zipSync(entries, { level: 6 })));
    fs.renameSync(temporary, target);
    return true;
  } catch (err) {
    console.error(`[documentstore] could not write ${target}: ${err.message}`);
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    } catch (cleanupErr) {
      console.error(`[documentstore] could not clear ${temporary}: ${cleanupErr.message}`);
    }
    return false;
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
 * The suggested folder has to exist or Windows quietly ignores it and offers
 * wherever the application last wrote instead -- which is how a first save once
 * came to point at AppData. So the root is created here, at the moment the user
 * has actually asked to save something. Whatever they choose is then taken
 * literally: the file lands exactly where they said it would.
 *
 * @param {String} [suggestedName] project name, extension excluded
 * @param {String} [title] dialog title
 * @returns {Promise<String|null>} chosen path, or null when cancelled
 */
async function saveDialog(suggestedName, title) {
  const name = suggestedName && String(suggestedName).trim() ? String(suggestedName) : 'Untitled';
  const root = projectRoot();
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (err) {
    console.error(`[documentstore] could not create ${root}: ${err.message}`);
  }
  const result = await dialog.showSaveDialog({
    title: title || 'Save project',
    defaultPath: path.join(root, `${name}${EXTENSION}`),
    filters: [{ name: 'Beam project', extensions: ['beam'] }],
    properties: ['createDirectory'],
  });
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
}

export default {
  read,
  readResources,
  write,
  openDialog,
  saveDialog,
  projectNameFor,
  projectRoot,
  LIBRARY_PREFIX,
  EXTENSION,
};
