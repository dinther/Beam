/* eslint-disable no-console */
/* eslint-disable import/no-extraneous-dependencies */
import { app, dialog } from 'electron';
import {
  unzipSync, zipSync, strFromU8, strToU8,
} from 'fflate';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import library from './library';
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
 * created or moved behind you. A project *folder* would mean typing a file
 * name and receiving a directory. The container also makes Export nearly
 * free -- it is the
 * same file with the referenced resources collected into it.
 *
 * Inside:
 *
 *   manifest.json   what wrote this, and which format it is
 *   show.json       the show itself
 *   Library/...     only in an export, where resources travel with the show
 *
 * An export is read by *mounting* it: its `Library/` entries are unpacked into
 * a cache folder laid out exactly like the user's library, and for as long as
 * the document is open that folder is consulted first -- profiles and
 * overrides handed to the renderer, models served over `library://project`.
 * Unpacking rather than serving out of the zip lets every reader that already
 * walks a library folder walk this one unchanged. The cache is application
 * data: it is cleared when the document is closed and when the app starts.
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
 * The document whose collected resources are unpacked, if any.
 *
 * One at a time: the renderer holds one show, so there is one document open.
 * `root` is the unpacked `Library/` folder, or null for a document that
 * carried nothing.
 *
 * @type {Object|null} `{ target, root }`
 */
let mounted = null;

/**
 * Where unpacked exports live: under the settings folder, because a cache is
 * application data, not the user's work.
 *
 * @returns {String} absolute path
 */
function cacheRoot() {
  return path.join(app.getPath('userData'), 'collected');
}

/**
 * Removes a folder and everything in it, quietly.
 *
 * @param {String} folder absolute path
 */
function removeFolder(folder) {
  try {
    fs.rmSync(folder, { recursive: true, force: true });
  } catch (err) {
    console.error(`[documentstore] could not clear ${folder}: ${err.message}`);
  }
}

/**
 * The unpacked library of the open document, or null when it carried none.
 *
 * @public
 * @returns {String|null} absolute path of a folder laid out like the library
 */
function mountRoot() {
  return mounted ? mounted.root : null;
}

/**
 * Forgets the open document and clears what was unpacked for it.
 *
 * @public
 */
function unmount() {
  if (mounted && mounted.root) removeFolder(path.dirname(mounted.root));
  mounted = null;
}

/**
 * Clears every unpacked export, for a start after a crash left some behind.
 *
 * @public
 */
function clearCache() {
  mounted = null;
  removeFolder(cacheRoot());
}

/**
 * Makes a document the open one, unpacking what it carries.
 *
 * Entry names come from the file, so they are not trusted to stay inside the
 * cache folder: anything that would land elsewhere is skipped by name and the
 * rest still mounts. A document with nothing collected mounts too -- it is
 * still the open document, and a save of it must not carry a previous
 * document's files along.
 *
 * @public
 * @param {String} target absolute path of the document
 * @returns {Object} `{ profiles, overrides }`, each keyed as the library keys
 *   them and empty when the document carries none
 */
function mount(target) {
  unmount();
  if (!isDocumentPath(target)) return { profiles: {}, overrides: {} };
  mounted = { target, root: null };

  const entries = entriesOf(target) || {};
  const names = Object.keys(entries).filter((name) => name.startsWith(LIBRARY_PREFIX)
    && !name.endsWith('/') && entries[name].length > 0);
  if (!names.length) return { profiles: {}, overrides: {} };

  const digest = crypto.createHash('sha1').update(target).digest('hex').slice(0, 12);
  const root = path.join(cacheRoot(), digest, 'Library');
  names.forEach((name) => {
    const file = path.resolve(root, name.slice(LIBRARY_PREFIX.length));
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      console.error(`[documentstore] skipping ${name} in ${target}: outside the library`);
      return;
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, entries[name]);
    } catch (err) {
      console.error(`[documentstore] could not unpack ${name} from ${target}: ${err.message}`);
    }
  });
  mounted.root = root;
  return {
    profiles: library.readAll('profiles', root),
    overrides: library.readAll('overrides', root),
  };
}

/**
 * Every file under the mounted library, as container entries.
 *
 * This is what lets a save of an opened export stay an export: the show is
 * rewritten and the files it arrived with go back in beside it, byte for
 * byte. Without it, the first save on another machine would strip the file
 * of exactly what made it open there.
 *
 * @returns {Object} entry name to bytes; empty when nothing is mounted
 */
function mountedEntries() {
  const root = mountRoot();
  if (!root || !fs.existsSync(root)) return {};
  const entries = {};
  const walk = (folder) => {
    fs.readdirSync(folder, { withFileTypes: true }).forEach((entry) => {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        walk(file);
      } else if (entry.isFile()) {
        const relative = path.relative(root, file).split(path.sep).join('/');
        try {
          entries[`${LIBRARY_PREFIX}${relative}`] = new Uint8Array(fs.readFileSync(file));
        } catch (err) {
          console.error(`[documentstore] could not read ${file}: ${err.message}`);
        }
      }
    });
  };
  try {
    walk(root);
  } catch (err) {
    console.error(`[documentstore] could not walk ${root}: ${err.message}`);
  }
  return entries;
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
 * @param {Object} [resources] entry path to contents -- a string for text, a
 *   `Uint8Array` for a model or an image -- collected into the container,
 *   which makes this an export rather than an ordinary save. Left out, an
 *   ordinary save of a mounted export carries the mounted files forward.
 * @returns {Boolean} whether the write succeeded
 */
function write(target, json, resources) {
  if (!isDocumentPath(target) || typeof json !== 'string') return false;
  const collected = resources || mountedEntries();
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
    else if (contents instanceof Uint8Array) entries[name] = contents;
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
  mount,
  unmount,
  mountRoot,
  clearCache,
  write,
  openDialog,
  saveDialog,
  projectNameFor,
  projectRoot,
  LIBRARY_PREFIX,
  EXTENSION,
};
