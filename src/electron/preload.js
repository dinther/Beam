/* eslint-disable import/no-extraneous-dependencies */
import { contextBridge, ipcRenderer } from 'electron';
import NDI from './ndi';

/**
 * Renderer-facing Art-Net bridge.
 *
 * The renderer (Vue app) runs in an isolated world with no Node access, so the
 * Art-Net socket that lives in the main process is exposed here as `window.artnet`.
 * When the app runs in a plain browser (no Electron), `window.artnet` is simply
 * absent and the renderer falls back to manual-fader-only operation.
 */
// A MessagePort cannot cross the context bridge, but it can cross the DOM.
// Handing it on with `window.postMessage` is how a transferable reaches the
// page's own world, and it is what lets an inbound batch arrive there without
// being copied on the way. See setupArtnet in main.js.
ipcRenderer.on('artnet:port', (event) => {
  window.postMessage('artnet:frame-port', '*', [event.ports[0]]);
});

contextBridge.exposeInMainWorld('artnet', {
  /**
   * Subscribe to inbound ArtDMX.
   *
   * Delivers a batch per display frame rather than a message per packet:
   * `universes` holds the universe numbers that changed and `data` their
   * values end to end, 512 per universe.
   *
   * @param {(batch: {universes: Uint16Array, data: Uint8Array}) => void} callback
   * @returns {() => void} unsubscribe
   */
  onFrames: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('artnet:frames', listener);
    return () => ipcRenderer.removeListener('artnet:frames', listener);
  },
  /**
   * Asks for a transferable channel to receive batches on.
   *
   * The port arrives as a `window` message carrying `'artnet:frame-port'`;
   * listen for it before calling this.
   */
  requestFramePort: () => ipcRenderer.send('artnet:request-port'),
  /** Open the receive socket. */
  start: (config) => ipcRenderer.invoke('artnet:start', config),
  /** Close the receive socket. */
  stop: () => ipcRenderer.invoke('artnet:stop'),
  /**
   * The universes the show has patched, so sACN can join their multicast
   * groups and leave the ones it no longer needs.
   *
   * Art-Net needs nothing of the sort -- it is broadcast or unicast -- so this
   * is the one place the two protocols are not interchangeable to a caller.
   *
   * @param {Array} universes Beam universe numbers, counted from 0
   */
  listenTo: (universes) => ipcRenderer.invoke('sacn:listen-to', universes),
  /**
   * Who is sending on either wire, and which universes have two of them.
   *
   * @returns {Promise<{sources: Array, conflicts: Array}>}
   */
  sources: () => ipcRenderer.invoke('dmx:sources'),
});

/**
 * Saving generated documents somewhere the user picks.
 *
 * Separate from `jsonStore`, which owns our own state: these files are written
 * for other applications to read, so the destination is chosen in a save dialog
 * rather than being ours to decide.
 */
contextBridge.exposeInMainWorld('fileExport', {
  /**
   * @param {Object} payload contents, defaultName, startIn, filters, title,
   *   an optional companion `{ contents, extension }` written beside it, and
   *   an optional `remember` key that reuses this session's chosen path
   * @returns {Promise<String|null>} path written, or null when cancelled
   */
  save: (payload) => ipcRenderer.invoke('file:export', payload),
});

/**
 * Named JSON stores in the application data directory.
 *
 * Application settings only -- window layout, debug flags, the migration
 * marker. Shows are not state: they live in RAM until the user saves them to a
 * document of their own, and nothing here writes one behind their back.
 */
contextBridge.exposeInMainWorld('jsonStore', {
  /** @returns {Promise<Object|null>} parsed contents, or null if absent */
  read: (name) => ipcRenderer.invoke('store:read', name),
  /**
   * @param {String} name
   * @param {String} json serialised contents
   * @returns {Promise<Boolean>} whether the write succeeded
   */
  write: (name, json) => ipcRenderer.invoke('store:write', name, json),
  /** @returns {Promise<Boolean>} whether anything was removed */
  clear: (name) => ipcRenderer.invoke('store:clear', name),
  /** @returns {Promise<String>} absolute path of the file */
  path: (name) => ipcRenderer.invoke('store:path', name),
});

/**
 * The user's fixture library: generated profiles, saved structures, and local
 * corrections to shipped profiles.
 *
 * One file per item, so saving one profile touches one file rather than
 * re-serialising the library. Items are named by key -- `manufacturer/model`
 * for profiles and overrides, a name for structures -- and never by path: the
 * file name is a convenience the main process derives, not an identity.
 */
contextBridge.exposeInMainWorld('library', {
  /**
   * @param {String} kind 'profiles', 'structures' or 'overrides'
   * @returns {Promise<Object>} key to contents
   */
  readAll: (kind) => ipcRenderer.invoke('library:readAll', kind),
  /**
   * @param {String} kind
   * @param {String} key
   * @param {String} json serialised contents of the item
   * @returns {Promise<Boolean>} whether the write succeeded
   */
  write: (kind, key, json) => ipcRenderer.invoke('library:write', kind, key, json),
  /** @returns {Promise<Boolean>} whether anything was removed */
  remove: (kind, key) => ipcRenderer.invoke('library:remove', kind, key),
  /** @returns {Promise<String>} absolute path of the library root */
  root: () => ipcRenderer.invoke('library:root'),
  /**
   * 3D models the user has put in `Library/Objects`.
   *
   * Metadata only. Each carries a `library://` url, which is what a loader
   * wants -- the bytes never come through here, because a .glb is megabytes
   * and this channel copies whatever crosses it.
   *
   * @returns {Promise<Array>} `{ name, file, url, bytes, modified }`
   */
  objects: () => ipcRenderer.invoke('library:objects'),
  /**
   * Writes a created object into `Library/Objects` as a descriptor.
   *
   * A built shape is parameters, not geometry, so it is stored as the numbers
   * the user chose and rebuilt on load -- which keeps it editable and keeps a
   * cube from costing a megabyte. Refuses a name already taken by anything in
   * that folder, model or object.
   *
   * @param {String} name
   * @param {Object} primitive `{ type, size, color }`
   * @returns {Promise<Object>} `{ ok, name, file }` or `{ ok: false, reason }`
   */
  createObject: (name, primitive) => ipcRenderer.invoke('library:createObject', name, primitive),
  /**
   * Stores a rendered preview beside the model it pictures.
   *
   * @param {String} key the library key
   * @param {String} dataUrl a PNG data url
   * @returns {Promise<Object>} `{ ok }` or `{ ok: false, reason }`
   */
  writeThumbnail: (key, dataUrl) => ipcRenderer.invoke('library:writeThumbnail', key, dataUrl),
  /**
   * Environment images in `Library/Environments`.
   *
   * Metadata only. Each carries a `library://` url, which is what `RGBELoader`
   * and `EXRLoader` are given -- a radiance image is megabytes of binary, and a
   * URL lets it stream rather than crossing IPC as a structured clone.
   *
   * @returns {Promise<Array>} `{ key, name, url }`
   */
  environments: () => ipcRenderer.invoke('library:environments'),
  /**
   * Asks for a radiance image and copies it into the library.
   *
   * Copied rather than referenced so that a preference names a file inside the
   * library, never an absolute path from outside it.
   *
   * @returns {Promise<Object>} `{ ok, entry }` or `{ ok: false, reason }`
   */
  addEnvironment: () => ipcRenderer.invoke('library:addEnvironment'),
});

/**
 * Show documents, at paths the user chose.
 *
 * A `.beam` is a zip holding the show, so a Save dialog behaves the way one
 * should: a name in, a file of that name out. Paths come from the dialogs here
 * rather than being invented by the renderer, and the main process will only
 * read or write files carrying our own extension.
 */
/**
 * Facts about this run of the application, settled before the app mounts.
 *
 * Preload re-runs on every renderer load, including the reloads New Project
 * and Open end with, so the claim below reaches a main process that has not
 * restarted -- which is exactly how a reload is told from a launch.
 */
contextBridge.exposeInMainWorld('appSession', {
  /** True only for the renderer load that started the application. */
  splashDue: ipcRenderer.sendSync('app:claimSplash'),
});

/**
 * Video recording, written to disk as it encodes.
 *
 * The page never names a file. It asks for a recording under the project's name
 * and is told where the file landed, so the only paths this can write are ones
 * the main process chose.
 */
contextBridge.exposeInMainWorld('videoRecorder', {
  /**
   * @param {Object} payload `{ name, documentPath }`
   * @returns {Promise<Object>} `{ ok, id, path, folder }` or `{ ok: false, error }`
   */
  begin: (payload) => ipcRenderer.invoke('video:begin', payload),
  /**
   * @param {Number} id recording id
   * @param {ArrayBuffer} chunk encoded bytes
   * @returns {Promise<Object>} `{ ok, bytes }` or `{ ok: false, error }`
   */
  write: (id, chunk) => ipcRenderer.invoke('video:write', id, chunk),
  /** @returns {Promise<Object>} `{ ok, path, bytes }` or `{ ok: false, error }` */
  end: (id) => ipcRenderer.invoke('video:end', id),
  /** Closes a take and deletes its file. @returns {Promise<Object>} `{ ok }` */
  abort: (id) => ipcRenderer.invoke('video:abort', id),
  /** Shows a finished recording in Explorer. @returns {Promise<Boolean>} */
  reveal: (target) => ipcRenderer.invoke('video:reveal', target),
});

contextBridge.exposeInMainWorld('documentStore', {
  /** @returns {Promise<Object|null>} the show, or null when unreadable */
  read: (target) => ipcRenderer.invoke('document:read', target),
  /** @returns {Promise<Object>} resources an export carries, keyed by entry */
  resources: (target) => ipcRenderer.invoke('document:resources', target),
  /**
   * @param {String} target
   * @param {String} json serialised show
   * @param {Object} [resources] entry path to serialised contents; collecting
   *   these is what makes the file an export rather than an ordinary save
   * @returns {Promise<Boolean>} whether the write succeeded
   */
  write: (target, json, resources) => ipcRenderer.invoke('document:write', target, json, resources),
  /** @returns {Promise<String|null>} chosen path, or null when cancelled */
  open: () => ipcRenderer.invoke('document:open'),
  /** @returns {Promise<String|null>} chosen path, or null when cancelled */
  saveAs: (name, title) => ipcRenderer.invoke('document:saveAs', name, title),
  /** @returns {Promise<String>} the project's name, taken from its file name */
  projectName: (target) => ipcRenderer.invoke('document:projectName', target),
  /** @returns {Promise<String>} where the save dialog starts */
  root: () => ipcRenderer.invoke('document:root'),
  /**
   * A project the application was launched with, claimed once.
   *
   * @returns {Promise<String|null>} absolute path, or null when there is none
   */
  claimPending: () => ipcRenderer.invoke('document:claimPending'),
  /**
   * A project handed to the running application by a second launch -- someone
   * double-clicking a `.beam` while Beam is already open.
   *
   * @param {(target: String) => void} callback
   * @returns {() => void} unsubscribe
   */
  onRequested: (callback) => {
    const listener = (_event, target) => callback(target);
    ipcRenderer.on('document:requested', listener);
    return () => ipcRenderer.removeListener('document:requested', listener);
  },
});

/**
 * Video in, over NDI.
 *
 * Unlike every other bridge here, nothing crosses to the main process: the
 * addon runs in this process (see `ndi.js`), so a frame is already where it
 * needs to be. What it cannot do is cross the **context** bridge -- that
 * clones, and cloning 8 MB sixty times a second is 500 MB/s spent copying
 * something we already have.
 *
 * So frames go the way the Art-Net port does, by `window.postMessage`, which
 * reaches the page's own world and can carry a transfer list. The buffer is
 * moved, not copied -- detached here the instant it is sent, which is safe
 * because every frame arrives in an ArrayBuffer of its own.
 */
contextBridge.exposeInMainWorld('ndi', {
  /**
   * @param {Number} [waitMs] how long to let discovery run
   * @returns {Promise<Array>} `{ name, urlAddress }`
   */
  sources: (waitMs) => NDI.sources(waitMs),
  /**
   * Opens a source. Frames arrive as `window` messages carrying
   * `{ channel: 'ndi:frame', handle, width, height, format, stride, buffer }`;
   * listen for them before calling this.
   *
   * @param {String} name exactly as `sources` reported it
   * @returns {Promise<Number>} handle, for `close`
   */
  open: async (name) => {
    let handle = null;
    handle = await NDI.open(name, (frame) => {
      window.postMessage({
        channel: 'ndi:frame',
        handle,
        width: frame.width,
        height: frame.height,
        format: frame.format,
        stride: frame.stride,
        buffer: frame.buffer,
      }, '*', [frame.buffer]);
    });
    return handle;
  },
  /** @param {Number} handle from `open` */
  close: (handle) => NDI.close(handle),
});
