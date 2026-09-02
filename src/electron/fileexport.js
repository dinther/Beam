/* eslint-disable no-console */
/* eslint-disable import/no-extraneous-dependencies */
import { app, dialog } from 'electron';
import fs from 'fs';
import path from 'path';

/**
 * Saving generated documents to somewhere the user chooses (main process).
 *
 * Unlike the JSON stores, these files are for other applications to read, so
 * they go wherever that application looks rather than into our own data
 * directory. The renderer never names a path: it offers a starting folder and
 * a suggested file name, and the save dialog decides, so nothing is written
 * anywhere the user has not seen.
 */

/**
 * Folders worth starting a save dialog in, by key.
 *
 * MadMapper reads user fixtures from Documents\MadMapper\Fixtures on Windows
 * and the equivalent under the user's documents folder elsewhere, so a fixture
 * saved there is picked up without any further importing.
 *
 * @returns {Object} key to absolute path
 */
function startFolders() {
  return {
    madmapperFixtures: path.join(app.getPath('documents'), 'MadMapper', 'Fixtures'),
    documents: app.getPath('documents'),
  };
}

/**
 * Where each kind of export last went, for the life of this session.
 *
 * A MadMapper export is regenerated constantly -- every patch change, every
 * time a fixture moves -- and it goes back to the same file every time, so
 * asking again is a dialog to dismiss rather than a decision to make. The
 * first export of a session chooses; the rest follow it.
 *
 * Keyed rather than single, because the caller decides what counts as "the
 * same export" -- a layout and a set of definitions are not the same file.
 *
 * Deliberately not persisted. A remembered path is a convenience within a
 * sitting, and a path saved from weeks ago is a file the user has forgotten
 * about being silently overwritten.
 *
 * @constant {Map}
 */
const lastPaths = new Map();

/**
 * Asks where to put a document, then writes it.
 *
 * A companion is written beside it under the same base name and a different
 * extension, without a dialog of its own. Two files that are only useful
 * together should not be two decisions: an export for MadMapper is a layout
 * plus the definitions it quotes by name, and a layout saved without them
 * refers to fixtures that do not exist.
 *
 * @param {Object} payload
 * @param {String} payload.contents what to write
 * @param {String} payload.defaultName suggested file name, extension included
 * @param {String} [payload.startIn] key from `startFolders`
 * @param {Array} [payload.filters] Electron dialog filters
 * @param {String} [payload.title] dialog title
 * @param {Object} [payload.companion] `{ contents, extension }`, written
 *   alongside and overwritten without asking
 * @param {String} [payload.remember] key under which to remember the chosen
 *   path, and to reuse it silently while the file is still there
 * @returns {Promise<String|null>} the path written, or null when cancelled or
 *   the write failed
 */
/**
 * Writes a file, waiting out whatever is holding it.
 *
 * Windows refuses a write while another program has the file open, and the
 * programs these exports are *for* are exactly the ones that hold them open --
 * MadMapper reading a layout, or an editor the user opened to look at it. The
 * write fails with EBUSY or EPERM, and a moment later it succeeds, which is
 * why an export could look like it did nothing and then work on the third try.
 *
 * A few quick attempts covers a reader that is passing through. Anything
 * holding it longer is a real problem and is reported rather than swallowed.
 *
 * @param {String} target
 * @param {String} contents
 */
function writeWaiting(target, contents) {
  const RETRIES = 6;
  const PAUSE_MS = 120;
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.writeFileSync(target, contents, 'utf8');
      return;
    } catch (err) {
      const busy = err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES';
      if (!busy || attempt >= RETRIES) throw err;
      // Synchronous on purpose: this runs in the main process between a save
      // dialog and its answer, with nothing else to get on with, and the
      // alternative is threading an async retry through a path whose whole job
      // is to have finished by the time it returns.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, PAUSE_MS);
    }
  }
}

async function save({
  contents, defaultName, startIn, filters, title, companion, remember,
}) {
  if (typeof contents !== 'string') return null;
  const folders = startFolders();
  const folder = folders[startIn] || folders.documents;
  const known = remember ? lastPaths.get(remember) : null;

  // Declared out here so the failure report below can name the file.
  let target = null;
  try {
    if (known && fs.existsSync(known)) {
      // Chosen earlier this session and still there. Writing straight to it is
      // the whole point; a file the user deleted or moved is treated as a
      // choice to make again rather than one to restore.
      target = known;
    } else {
      const result = await dialog.showSaveDialog({
        title: title || 'Export',
        // The gone-missing path is still the best suggestion: same folder,
        // same name, so accepting it puts the file back where it was.
        defaultPath: known || path.join(folder, defaultName || 'export'),
        filters: filters || [],
        properties: ['createDirectory'],
      });
      if (result.canceled || !result.filePath) return null;
      target = result.filePath;
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeWaiting(target, contents);

    if (companion && typeof companion.contents === 'string' && companion.extension) {
      const base = path.basename(target, path.extname(target));
      const beside = path.join(path.dirname(target), `${base}.${companion.extension}`);
      writeWaiting(beside, companion.contents);
    }

    if (remember) lastPaths.set(remember, target);
    return target;
  } catch (err) {
    // Said out loud, not logged and forgotten.
    //
    // A remembered path writes with no dialog, so a silent failure looked
    // exactly like a success: no prompt, no message, and a file on disk still
    // holding whatever it held before. There is no way to tell that from an
    // export that worked, and the stale file reads as the export being wrong
    // rather than absent.
    console.error('[fileexport] could not save:', err.message);
    dialog.showErrorBox(
      'Could not write the export',
      `${target || 'The file'} could not be written.

${err.message}

`
      + 'If it is open in MadMapper or an editor, close it and export again.',
    );
    return null;
  }
}

export default { save };
