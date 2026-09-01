/* eslint-disable import/no-extraneous-dependencies */
import { app, shell } from 'electron';
import fs from 'fs';
import path from 'path';

/**
 * Where a recording is written, and the streaming that lets it be any length.
 *
 * The renderer cannot hold a recording in memory: at a realistic bitrate an
 * unlimited take is gigabytes, and `MediaRecorder` with no timeslice hands the
 * whole thing over in one Blob at the end. So chunks arrive here as they are
 * encoded and go straight to a write stream. Nothing accumulates anywhere.
 *
 * The renderer names nothing. It asks for a recording under a project name and
 * is told where the file landed -- so no path from the page ever reaches the
 * disk, the same rule `documentstore` follows for shows.
 */

/** Container extension. One codec, one container -- see `recorder.js`. */
const EXTENSION = '.mp4';

/**
 * Where recordings go, under the user's own Videos folder.
 *
 * Not beside the project. Video is not a project asset the way a profile or a
 * structure is -- it is the output, it is large, and it is going somewhere
 * else the moment it exists. Videos is where the operating system already
 * indexes it, where a media player opens by default, and where an upload
 * dialog starts.
 *
 * Asked of Electron rather than spelled out: Videos is routinely redirected to
 * another drive or a network home, and a hardcoded path is wrong when it is.
 */
const VIDEO_FOLDER = 'Beam';

/** Open recordings, by id. */
const open = new Map();

/** Source of the next id. Never reused, so a late chunk cannot find a stream. */
let nextId = 1;

/**
 * Strips what Windows will not accept in a file name.
 *
 * A project name is whatever the user typed, and it becomes a file name here
 * without passing through a dialog that would have refused it. Reserved device
 * names matter as much as the banned characters: `CON.mp4` cannot be created.
 *
 * @param {String} name candidate
 * @returns {String} a name Windows will take
 */
function sanitise(name) {
  const cleaned = String(name || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    // Windows silently drops a trailing dot or space, so a name ending in one
    // is not the name that gets created.
    .replace(/[. ]+$/, '')
    .trim();
  if (!cleaned) return 'untitled';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) return `${cleaned}_`;
  return cleaned;
}

/**
 * The folder recordings go in.
 *
 * @returns {String} absolute folder path
 */
function folderFor() {
  return path.join(app.getPath('videos'), VIDEO_FOLDER);
}

/**
 * A path in `folder` that nothing occupies.
 *
 * Recording twice must not overwrite the first take -- that is somebody's work
 * and there is no undo for it. The suffix counts rather than stamping a time,
 * so a folder of takes reads in the order they were made.
 *
 * @param {String} folder absolute folder
 * @param {String} base sanitised name, no extension
 * @returns {String} absolute path that does not exist
 */
function freePath(folder, base) {
  let candidate = path.join(folder, `${base}${EXTENSION}`);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(folder, `${base}-${n}${EXTENSION}`);
    n += 1;
  }
  return candidate;
}

/**
 * Opens a recording and its file.
 *
 * @param {Object} payload
 * @param {String} payload.name project name the file is called after
 * @returns {Object} `{ ok, id, path, folder }`, or `{ ok: false, error }`
 */
function begin({ name } = {}) {
  const folder = folderFor();
  try {
    fs.mkdirSync(folder, { recursive: true });
  } catch (err) {
    console.error(`[videorecorder] could not create ${folder}: ${err.message}`);
    return { ok: false, error: `Could not create ${folder}` };
  }

  const target = freePath(folder, sanitise(name));
  let stream;
  try {
    stream = fs.createWriteStream(target);
  } catch (err) {
    console.error(`[videorecorder] could not open ${target}: ${err.message}`);
    return { ok: false, error: `Could not write to ${target}` };
  }

  const id = nextId;
  nextId += 1;
  const recording = {
    id, target, stream, bytes: 0, failed: null,
  };
  // A disk that fills mid-take fails here rather than at `end`, and the error
  // has to survive until something asks. Without this the stream throws into
  // nothing and the recording looks fine until the file will not play.
  stream.on('error', (err) => {
    recording.failed = err.message;
    console.error(`[videorecorder] write failed on ${target}: ${err.message}`);
  });
  open.set(id, recording);
  console.log(`[videorecorder] recording ${id} -> ${target}`);
  return {
    ok: true, id, path: target, folder,
  };
}

/**
 * Appends one encoded chunk.
 *
 * @param {Number} id recording id
 * @param {ArrayBuffer} chunk encoded bytes
 * @returns {Object} `{ ok, bytes }`, or `{ ok: false, error }`
 */
function write(id, chunk) {
  const recording = open.get(id);
  if (!recording) return { ok: false, error: 'No such recording' };
  if (recording.failed) return { ok: false, error: recording.failed };
  try {
    const bytes = Buffer.from(chunk);
    recording.stream.write(bytes);
    recording.bytes += bytes.length;
    return { ok: true, bytes: recording.bytes };
  } catch (err) {
    recording.failed = err.message;
    return { ok: false, error: err.message };
  }
}

/**
 * Closes a recording.
 *
 * @param {Number} id recording id
 * @returns {Promise<Object>} `{ ok, path, bytes }`, or `{ ok: false, error }`
 */
function end(id) {
  const recording = open.get(id);
  if (!recording) return Promise.resolve({ ok: false, error: 'No such recording' });
  open.delete(id);
  return new Promise((resolve) => {
    recording.stream.end(() => {
      if (recording.failed) {
        resolve({ ok: false, error: recording.failed, path: recording.target });
        return;
      }
      console.log(`[videorecorder] recording ${id} closed, ${recording.bytes} bytes`);
      resolve({ ok: true, path: recording.target, bytes: recording.bytes });
    });
  });
}

/**
 * Closes a recording and removes the file.
 *
 * For a take that failed before it was worth keeping. A zero-byte `.mp4` left
 * in the exports folder is worse than no file, because it looks like a take.
 *
 * @param {Number} id recording id
 * @returns {Promise<Object>} `{ ok }`
 */
function abort(id) {
  const recording = open.get(id);
  if (!recording) return Promise.resolve({ ok: false, error: 'No such recording' });
  open.delete(id);
  return new Promise((resolve) => {
    recording.stream.end(() => {
      try {
        fs.unlinkSync(recording.target);
      } catch (err) {
        console.error(`[videorecorder] could not remove ${recording.target}: ${err.message}`);
      }
      resolve({ ok: true });
    });
  });
}

/**
 * Shows a finished recording in the file manager.
 *
 * Confined to files this module made, because the renderer supplies the path:
 * anything else and a page could ask for any file on the disk to be revealed.
 *
 * @param {String} target absolute path
 * @returns {Boolean} whether it was shown
 */
function reveal(target) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) return false;
  if (path.extname(target).toLowerCase() !== EXTENSION) return false;
  const relative = path.relative(folderFor(), target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  if (!fs.existsSync(target)) return false;
  shell.showItemInFolder(target);
  return true;
}

/**
 * Closes everything still open.
 *
 * Called when the window goes away. A recording still running at that point has
 * no owner left to stop it, and an unclosed write stream loses its tail.
 */
function closeAll() {
  [...open.keys()].forEach((id) => { end(id); });
}

export default {
  begin, write, end, abort, reveal, closeAll, folderFor, sanitise,
};
