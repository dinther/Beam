/* eslint-disable no-console */
/* eslint-disable import/no-extraneous-dependencies */
import { app } from 'electron';
import fs from 'fs';
import path from 'path';

/**
 * Show persistence on disk (main process).
 *
 * The working show is kept as a plain JSON file in the platform's application
 * data directory, the way a desktop application is expected to behave -- on
 * Windows that is %APPDATA%\<app>\show.json. It can be inspected, backed up and
 * copied between machines, none of which is true of browser storage.
 *
 * Writes go to a temporary file first and are then renamed over the target, so
 * an interrupted save cannot leave a half-written show behind.
 */

const SHOW_FILENAME = 'show.json';

/** Absolute path of the persisted show. */
function showPath() {
  return path.join(app.getPath('userData'), SHOW_FILENAME);
}

/**
 * Reads the persisted show.
 *
 * @returns {Object|null} parsed show data, or null when nothing is stored or
 *   the file cannot be read
 */
function read() {
  const target = showPath();
  try {
    if (!fs.existsSync(target)) return null;
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (err) {
    console.error('[showstore] could not read show:', err.message);
    return null;
  }
}

/**
 * Writes the show to disk.
 *
 * Takes serialised JSON rather than an object: the renderer's show data is
 * wrapped in reactive proxies that cannot survive structured cloning across
 * IPC, and it has to be serialised anyway to be written.
 *
 * @param {String} json serialised show data
 * @returns {Boolean} whether the write succeeded
 */
function write(json) {
  const target = showPath();
  const temporary = `${target}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temporary, json, 'utf8');
    fs.renameSync(temporary, target);
    return true;
  } catch (err) {
    console.error('[showstore] could not write show:', err.message);
    return false;
  }
}

/**
 * Removes the persisted show.
 *
 * @returns {Boolean} whether anything was removed
 */
function clear() {
  const target = showPath();
  try {
    if (!fs.existsSync(target)) return false;
    fs.unlinkSync(target);
    return true;
  } catch (err) {
    console.error('[showstore] could not clear show:', err.message);
    return false;
  }
}

export default {
  read, write, clear, showPath,
};
