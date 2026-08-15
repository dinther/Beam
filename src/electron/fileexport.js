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
 * Asks where to put a document, then writes it.
 *
 * @param {Object} payload
 * @param {String} payload.contents what to write
 * @param {String} payload.defaultName suggested file name, extension included
 * @param {String} [payload.startIn] key from `startFolders`
 * @param {Array} [payload.filters] Electron dialog filters
 * @param {String} [payload.title] dialog title
 * @returns {Promise<String|null>} the path written, or null when cancelled or
 *   the write failed
 */
async function save({
  contents, defaultName, startIn, filters, title,
}) {
  if (typeof contents !== 'string') return null;
  const folders = startFolders();
  const folder = folders[startIn] || folders.documents;
  try {
    const result = await dialog.showSaveDialog({
      title: title || 'Export',
      defaultPath: path.join(folder, defaultName || 'export'),
      filters: filters || [],
      properties: ['createDirectory'],
    });
    if (result.canceled || !result.filePath) return null;
    fs.mkdirSync(path.dirname(result.filePath), { recursive: true });
    fs.writeFileSync(result.filePath, contents, 'utf8');
    return result.filePath;
  } catch (err) {
    console.error('[fileexport] could not save:', err.message);
    return null;
  }
}

export default { save };
