/* eslint-disable no-console */
/* eslint-disable import/no-extraneous-dependencies */
import { app } from 'electron';
import fs from 'fs';
import path from 'path';

/**
 * Named JSON files on disk (main process).
 *
 * Settings are kept as plain JSON in the platform's application data
 * directory -- on Windows %APPDATA%\<app>\. The user's own work does not live
 * here: their library is in Documents and their shows are wherever they saved
 * them.
 *
 * Writes go to a temporary file first and are then renamed over the target, so
 * an interrupted save cannot leave a half-written file behind.
 *
 * Settings only. A show is a document the user names and saves; it is never
 * quietly written here, and nothing reads one back at startup.
 */

/** Rejects anything that is not a plain file name. */
function safeName(name) {
  return /^[a-z0-9_-]+$/i.test(name) ? name : null;
}

/**
 * Absolute path of a named store.
 *
 * @param {String} name
 * @returns {String|null}
 */
function storePath(name) {
  const safe = safeName(name);
  return safe ? path.join(app.getPath('userData'), `${safe}.json`) : null;
}

/**
 * Reads a named store.
 *
 * @param {String} name
 * @returns {Object|null} parsed contents, or null when nothing is stored or
 *   the file cannot be read
 */
function read(name) {
  const target = storePath(name);
  if (!target) return null;
  try {
    if (!fs.existsSync(target)) return null;
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (err) {
    console.error(`[jsonstore] could not read ${name}:`, err.message);
    return null;
  }
}

/**
 * Writes a named store.
 *
 * Takes serialised JSON rather than an object: the renderer's state is wrapped
 * in reactive proxies that cannot survive structured cloning across IPC, and
 * it has to be serialised anyway to be written.
 *
 * @param {String} name
 * @param {String} json serialised contents
 * @returns {Boolean} whether the write succeeded
 */
function write(name, json) {
  const target = storePath(name);
  if (!target) return false;
  const temporary = `${target}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temporary, json, 'utf8');
    fs.renameSync(temporary, target);
    return true;
  } catch (err) {
    console.error(`[jsonstore] could not write ${name}:`, err.message);
    return false;
  }
}

/**
 * Removes a named store.
 *
 * @param {String} name
 * @returns {Boolean} whether anything was removed
 */
function clear(name) {
  const target = storePath(name);
  if (!target) return false;
  try {
    if (!fs.existsSync(target)) return false;
    fs.unlinkSync(target);
    return true;
  } catch (err) {
    console.error(`[jsonstore] could not clear ${name}:`, err.message);
    return false;
  }
}

export default {
  read, write, clear, storePath,
};
