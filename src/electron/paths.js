/* eslint-disable import/no-extraneous-dependencies */
import { app } from 'electron';
import path from 'path';

/**
 * Where the user's own work lives (main process).
 *
 * One place, because two of them would drift: projects default to saving here
 * and the library sits here, so a change to one that missed the other would put
 * a user's structures somewhere their shows were not.
 *
 * AppData is deliberately not this. AppData is for settings -- window layout,
 * debug flags, caches, autorecover. A structure someone saved is not a setting;
 * they will want to find the file again, copy it to another machine, or send it
 * to somebody, and none of that is true of a preferences file.
 */

/**
 * Root of everything the user makes with Beam.
 *
 * `Beatline` is a family container, so anything after this sits beside it rather
 * than starting a third tree. Asked of Electron rather than spelled out, because
 * Documents is routinely redirected -- to OneDrive, to a network home directory,
 * to a localised name -- and a hardcoded path is wrong on all three.
 *
 * @returns {String} absolute path
 */
function beamRoot() {
  return path.join(app.getPath('documents'), 'Beatline', 'Beam');
}

/**
 * Library items shipped with the app, to be seeded into the user's own.
 *
 * Kept beside the packaged app rather than inside its archive, so that a
 * curious user can open the demo files where they are installed as well as
 * where they land.
 *
 * @returns {String} absolute path
 */
function seedRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'library')
    : path.join(app.getAppPath(), 'resources', 'library');
}

export default { beamRoot, seedRoot };
