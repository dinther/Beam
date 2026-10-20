/* eslint-disable import/no-extraneous-dependencies */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
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
  /**
   * Turns sender mode on or off: inbound frames are held back and Beam sends
   * sACN instead.
   *
   * @param {Boolean} enabled
   * @param {Object} [opts] `{ protocol: 'sacn'|'artnet', target }`, the target
   *   an Art-Net address, broadcast when empty
   * @returns {Promise<Boolean>} whether Beam is now sending
   */
  setSending: (enabled, opts) => ipcRenderer.invoke('dmx:set-sending', enabled, opts),
  /**
   * Sends one universe while in sender mode.
   *
   * @param {Number} universe Beam universe, counted from 0
   * @param {Uint8Array} data 512 slots
   */
  send: (universe, data) => ipcRenderer.send('dmx:send', universe, data),
});

/**
 * Renderer-facing laser bridge.
 *
 * The virtual laser DACs live in the main process (see `setupLaser` in
 * main.js); what the renderer gets is the points they have played, batched
 * per display frame, and a readout of what each DAC is doing.
 */
contextBridge.exposeInMainWorld('laser', {
  /**
   * Subscribe to played laser points.
   *
   * A batch is `{ protocol, rate, points }`: which DAC played them, the point
   * rate they were played at, and the points as six unsigned 16-bit values
   * each -- x, y as signed bit patterns (`(v << 16) >> 16`), then r, g, b, i.
   * A Ponk batch is `{ protocol: 'ponk', service, name, format, paths }`
   * instead: one MadMapper output's frame of paths, by stream id and name.
   *
   * @param {(batch: {protocol: String, rate: Number, points: Uint16Array}) => void} callback
   * @returns {() => void} unsubscribe
   */
  onFrames: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('laser:frames', listener);
    return () => ipcRenderer.removeListener('laser:frames', listener);
  },
  /**
   * The addresses a laser device may be bound to: this machine's real IPv4
   * interface addresses, routable ones first.
   *
   * @returns {Promise<Array>} each `{ address, label, internal, primary }`
   */
  addresses: () => ipcRenderer.invoke('laser:addresses'),
  /**
   * What each DAC is doing: whether it is listening, who is sending, the
   * rate, and how full its buffer is.
   *
   * @returns {Promise<Array>} one plain record per DAC
   */
  report: () => ipcRenderer.invoke('laser:report'),

  /**
   * Tells the main process how every laser in the show wants to be fed, so it
   * can start and stop the devices to match.
   *
   * @param {Array} inputs each `{ uid, name, protocol, address, service }`
   * @returns {Promise<Array>} one `{ uid, ok, reason }` per input -- `ok`
   *   false when another laser already holds that device
   */
  configure: (inputs) => ipcRenderer.invoke('laser:configure', inputs),
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
   * @param {Object} payload contents or pdfFromHtml, defaultName, startIn, filters, title,
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
 * for profiles, a name for structures -- and never by path: the
 * file name is a convenience the main process derives, not an identity.
 */
contextBridge.exposeInMainWorld('library', {
  /**
   * @param {String} kind 'profiles' or 'structures'
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
  createObject: (name, primitive, options) => ipcRenderer.invoke('library:createObject', name, primitive, options),
  /**
   * Stores a rendered preview beside the model it pictures.
   *
   * @param {String} key the library key
   * @param {String} dataUrl a PNG data url
   * @returns {Promise<Object>} `{ ok }` or `{ ok: false, reason }`
   */
  writeThumbnail: (key, dataUrl) => ipcRenderer.invoke('library:writeThumbnail', key, dataUrl),
  /**
   * Asks for a model file and copies it, with the files it refers to, into
   * `Library/Objects`. It is not an object until `finishImport` describes it.
   *
   * @returns {Promise<Object>} `{ ok, id, entry, skipped }` or `{ ok: false, reason }`
   */
  importObject: () => ipcRenderer.invoke('library:importObject'),
  /**
   * Writes an imported model's units and up axis, and its name if changed.
   *
   * @param {Number} id from `importObject`
   * @param {Object} settings `{ name, scale, upAxis }`
   * @returns {Promise<Object>} `{ ok, key }` or `{ ok: false, reason }`
   */
  finishImport: (id, settings) => ipcRenderer.invoke('library:finishImport', id, settings),
  /**
   * Removes a cancelled import's files from the library.
   *
   * @param {Number} id from `importObject`
   * @returns {Promise<Object>} `{ ok }`
   */
  cancelImport: (id) => ipcRenderer.invoke('library:cancelImport', id),
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
  /**
   * Image and video files a video source may be: the open document's, the
   * library's and the shipped ones, one per file name.
   *
   * @returns {Promise<Array>} `{ key, name, kind, origin, url }`
   */
  media: () => ipcRenderer.invoke('library:media'),
  /**
   * Asks for an image or video file and copies it into `Library/Media`.
   *
   * @returns {Promise<Object>} `{ ok, entry }` or `{ ok: false, reason }`
   */
  addMedia: () => ipcRenderer.invoke('library:addMedia'),
  /**
   * ILDA files a laser clip list can play: the open document's, the user's
   * `Library/Lasers` and the ones that ship with Beam.
   *
   * @returns {Promise<Array>} `{ key, name, origin, url }`
   */
  laserClips: () => ipcRenderer.invoke('library:laserClips'),
  /**
   * Gobo and animation disc images a placement may swap into its wheels: the
   * open document's and those in `Library/Gobos`.
   *
   * @returns {Promise<Array>} `{ key, name, origin, url }`
   */
  gobos: () => ipcRenderer.invoke('library:gobos'),
  /**
   * Asks for images and copies them into `Library/Gobos`.
   *
   * @returns {Promise<Object>} `{ ok, entries, refused }` or `{ ok: false, reason }`
   */
  addGobos: () => ipcRenderer.invoke('library:addGobos'),
  /**
   * Asks for ILDA files and copies them into `Library/Lasers`.
   *
   * @returns {Promise<Object>} `{ ok, entries, refused }` or `{ ok: false, reason }`
   */
  addLaserClips: () => ipcRenderer.invoke('library:addLaserClips'),
  /**
   * Laser memory cards: named clip lists in `Library/Lasers/Cards`, and those
   * the open document carries.
   *
   * @returns {Promise<Array>} `{ key, name, clips, origin }`
   */
  laserCards: () => ipcRenderer.invoke('library:laserCards'),
  /**
   * Writes a card to the library.
   *
   * @param {String} name
   * @param {Array} clips
   * @returns {Promise<Object>} `{ ok, key }` or `{ ok: false, reason }`
   */
  saveLaserCard: (name, clips) => ipcRenderer.invoke('library:saveLaserCard', name, clips),
  /**
   * Copies a clip list's files to a chosen folder, numbered in list order.
   *
   * @param {Array} clips `{ name, file }`
   * @returns {Promise<Object>} `{ ok, folder, written, missing }` or `{ ok: false, reason }`
   */
  exportLaserClips: (clips) => ipcRenderer.invoke('library:exportLaserClips', clips),
  /**
   * GDTF fixtures in `Library/Profiles`, metadata only. The bytes are served
   * as `library://profiles/<file>`.
   *
   * @returns {Promise<Array>} `{ key, file, name, manufacturer, fixtureTypeId, dataVersion }`
   */
  gdtfList: () => ipcRenderer.invoke('library:gdtfList'),
  /** Asks for .gdtf files. @returns {Promise<Array<String>>} absolute paths */
  pickGdtf: () => ipcRenderer.invoke('library:pickGdtf'),
  /**
   * Copies one .gdtf into the library. A file of the same fixture type is
   * reported as a conflict unless `replace` is set.
   *
   * @param {String} source absolute path
   * @param {Object} [options] `{ replace }`
   * @returns {Promise<Object>} `{ ok, entry }`, `{ ok: false, conflict }`
   *   or `{ ok: false, reason }`
   */
  importGdtf: (source, options) => ipcRenderer.invoke('library:importGdtf', source, options),
  removeGdtf: (key) => ipcRenderer.invoke('library:removeGdtf', key),
  gdtfMarks: () => ipcRenderer.invoke('library:gdtfMarks'),
  setGdtfBad: (what, bad) => ipcRenderer.invoke('library:setGdtfBad', what, bad),
  setFavourite: (what, on) => ipcRenderer.invoke('library:setFavourite', what, on),
  /**
   * The path of a file dropped on the window. The page cannot see paths; the
   * preload can, and hands over only this one.
   *
   * @param {File} file
   * @returns {String}
   */
  pathForFile: (file) => webUtils.getPathForFile(file),
});

/**
 * GDTF Share. The account is stored by the main process, encrypted, and is
 * never handed back: `status` says only whether one is stored and whose.
 */
contextBridge.exposeInMainWorld('gdtfShare', {
  /** @returns {Promise<Object>} `{ available, user }` */
  status: () => ipcRenderer.invoke('gdtfShare:status'),
  /**
   * Checks an account with GDTF Share and stores it if it is good.
   *
   * @returns {Promise<Object>} `{ ok, error }`
   */
  saveAccount: (user, password) => ipcRenderer.invoke('gdtfShare:saveAccount', user, password),
  /** @returns {Promise<Object>} `{ ok }` */
  forgetAccount: () => ipcRenderer.invoke('gdtfShare:forgetAccount'),
  /**
   * The cached list, without asking the Share.
   *
   * @returns {Promise<Object>} `{ ok, list, fetched }`
   */
  saved: () => ipcRenderer.invoke('gdtfShare:saved'),
  /**
   * Every revision on the Share, cached unless `refresh`.
   *
   * @returns {Promise<Object>} `{ ok, list, fetched, error }`
   */
  list: (refresh) => ipcRenderer.invoke('gdtfShare:list', refresh),
  /**
   * Downloads a revision to a temporary .gdtf for the import.
   *
   * @returns {Promise<Object>} `{ ok, path, error }`
   */
  download: (rid, hint) => ipcRenderer.invoke('gdtfShare:download', rid, hint),
  /** @returns {Promise<Object>} revision id imported, by fixture type ID */
  imported: () => ipcRenderer.invoke('gdtfShare:imported'),
  /** Notes a revision as imported. @returns {Promise<Object>} every record */
  recordImport: (fixtureTypeId, rid) => ipcRenderer.invoke('gdtfShare:recordImport', fixtureTypeId, rid),
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
   * @param {Number} position byte offset in the file
   * @param {Uint8Array} chunk the bytes
   * @returns {Promise<Object>} `{ ok, bytes }` or `{ ok: false, error }`
   */
  write: (id, position, chunk) => ipcRenderer.invoke('video:write', id, position, chunk),
  /** @returns {Promise<Object>} `{ ok, path, bytes }` or `{ ok: false, error }` */
  end: (id) => ipcRenderer.invoke('video:end', id),
  /** Closes a take and deletes its file. @returns {Promise<Object>} `{ ok }` */
  abort: (id) => ipcRenderer.invoke('video:abort', id),
  /** Shows a finished recording in Explorer. @returns {Promise<Boolean>} */
  reveal: (target) => ipcRenderer.invoke('video:reveal', target),
});

/** The window itself: full screen and stay on top, for the View menu. */
contextBridge.exposeInMainWorld('appWindow', {
  /** @returns {Promise<Boolean>} whether the window is now full screen */
  setFullScreen: (on) => ipcRenderer.invoke('window:set-full-screen', on),
  /** @returns {Promise<Boolean>} */
  isFullScreen: () => ipcRenderer.invoke('window:is-full-screen'),
  /** @returns {Promise<Boolean>} whether the window now stays on top */
  setAlwaysOnTop: (on) => ipcRenderer.invoke('window:set-always-on-top', on),
  /** Calls back with true or false whenever full screen changes, whoever changed it. */
  onFullScreen: (callback) => {
    ipcRenderer.on('window:full-screen', (_event, on) => callback(on));
  },
});

contextBridge.exposeInMainWorld('documentStore', {
  /** @returns {Promise<Object|null>} the show, or null when unreadable */
  read: (target) => ipcRenderer.invoke('document:read', target),
  /**
   * Makes a document the open one. What it carries -- an export's collected
   * profiles and models -- is unpacked and consulted ahead of the
   * library until the next mount or unmount.
   *
   * @param {String} target
   * @returns {Promise<Object>} `{ profiles, gdtf }`, keyed as the library
   *   keys them; models are found through `library.objects()`
   */
  mount: (target) => ipcRenderer.invoke('document:mount', target),
  /** Forgets the open document: a new or imported show has none. */
  unmount: () => ipcRenderer.invoke('document:unmount'),
  /**
   * Saves the show. A document that carries files keeps carrying the ones the
   * show still references, and only those.
   *
   * @param {String} target
   * @param {String} json serialised show
   * @param {Object} wanted `{ profiles, objects }`, each an array of keys
   * @returns {Promise<Object>} `{ ok, carried, profiles, gdtf }`
   */
  write: (target, json, wanted) => ipcRenderer.invoke('document:write', target, json, wanted),
  /**
   * Writes an export: the show with every profile and model it references
   * collected into the file, found by key in the library and shipped assets.
   *
   * @param {String} target
   * @param {String} json serialised show
   * @param {Object} wanted `{ profiles, objects }`, each an array of keys
   * @returns {Promise<Object>} `{ ok, collected, missing }`
   */
  export: (target, json, wanted) => ipcRenderer.invoke('document:export', target, json, wanted),
  /**
   * Replaces what the open document carries with this machine's library
   * copies, for the items the show references. Only the unpacked copy
   * changes; the file takes it on the next save.
   *
   * @param {Object} wanted `{ profiles, objects }`, each an array of keys
   * @returns {Promise<Object>} `{ carried, refreshed, kept, objects, profiles, gdtf }`
   */
  refresh: (wanted) => ipcRenderer.invoke('document:refresh', wanted),
  /** @returns {Promise<String|null>} chosen path, or null when cancelled */
  open: () => ipcRenderer.invoke('document:open'),
  /** @returns {Promise<String|null>} chosen path, or null when cancelled */
  saveAs: (name, title, folderKey) => ipcRenderer.invoke('document:saveAs', name, title, folderKey),
  /** @returns {Promise<String>} the project's name, taken from its file name */
  projectName: (target) => ipcRenderer.invoke('document:projectName', target),
  /** @returns {Promise<String>} where the save dialog starts */
  root: () => ipcRenderer.invoke('document:root'),
  /** @returns {Promise<Array>} `{ path, name, folder }`, newest first */
  recent: () => ipcRenderer.invoke('document:recent'),
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
