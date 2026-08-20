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
async function save({
  contents, defaultName, startIn, filters, title, companion, remember,
}) {
  if (typeof contents !== 'string') return null;
  const folders = startFolders();
  const folder = folders[startIn] || folders.documents;
  const known = remember ? lastPaths.get(remember) : null;

  try {
    let target = null;
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
    fs.writeFileSync(target, contents, 'utf8');

    if (companion && typeof companion.contents === 'string' && companion.extension) {
      const base = path.basename(target, path.extname(target));
      const beside = path.join(path.dirname(target), `${base}.${companion.extension}`);
      fs.writeFileSync(beside, companion.contents, 'utf8');
    }

    if (remember) lastPaths.set(remember, target);
    return target;
  } catch (err) {
    console.error('[fileexport] could not save:', err.message);
    return null;
  }
}

export default { save };
