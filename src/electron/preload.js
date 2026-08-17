/* eslint-disable import/no-extraneous-dependencies */
import { contextBridge, ipcRenderer } from 'electron';

/**
 * Renderer-facing Art-Net bridge.
 *
 * The renderer (Vue app) runs in an isolated world with no Node access, so the
 * Art-Net socket that lives in the main process is exposed here as `window.artnet`.
 * When the app runs in a plain browser (no Electron), `window.artnet` is simply
 * absent and the renderer falls back to manual-fader-only operation.
 */
contextBridge.exposeInMainWorld('artnet', {
  /**
   * Subscribe to inbound ArtDMX frames.
   * @param {(frame: {universe: number, data: Uint8Array}) => void} callback
   * @returns {() => void} unsubscribe
   */
  onFrame: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('artnet:frame', listener);
    return () => ipcRenderer.removeListener('artnet:frame', listener);
  },
  /** Open the receive socket. */
  start: (config) => ipcRenderer.invoke('artnet:start', config),
  /** Close the receive socket. */
  stop: () => ipcRenderer.invoke('artnet:stop'),
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
   * @param {Object} payload contents, defaultName, startIn, filters, title
   * @returns {Promise<String|null>} path written, or null when cancelled
   */
  save: (payload) => ipcRenderer.invoke('file:export', payload),
});

/**
 * Named JSON stores in the application data directory.
 *
 * This is a desktop application, so its state lives in files that can be
 * inspected and backed up rather than in browser storage. `show` holds the
 * working show; `preferences` holds application settings, which deliberately
 * do not travel with a show.
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
});

/**
 * Show documents, at paths the user chose.
 *
 * A project is a folder holding one `.beam` document named for it. Paths come
 * from the dialogs here rather than being invented by the renderer, and the main
 * process will only read or write files carrying our own extension.
 */
contextBridge.exposeInMainWorld('documentStore', {
  /** @returns {Promise<Object|null>} parsed document, or null when unreadable */
  read: (target) => ipcRenderer.invoke('document:read', target),
  /** @returns {Promise<Boolean>} whether the write succeeded */
  write: (target, json) => ipcRenderer.invoke('document:write', target, json),
  /** @returns {Promise<String|null>} chosen path, or null when cancelled */
  open: () => ipcRenderer.invoke('document:open'),
  /** @returns {Promise<String|null>} chosen path, or null when cancelled */
  saveAs: (name) => ipcRenderer.invoke('document:saveAs', name),
  /** @returns {Promise<String|null>} the single document in a folder */
  documentIn: (folder) => ipcRenderer.invoke('document:in', folder),
  /** @returns {Promise<String>} where a folder's document should sit */
  pathFor: (folder) => ipcRenderer.invoke('document:pathFor', folder),
  /** @returns {Promise<String>} the project's name, taken from its folder */
  projectName: (target) => ipcRenderer.invoke('document:projectName', target),
  /** @returns {Promise<String>} where the save dialog starts */
  root: () => ipcRenderer.invoke('document:root'),
  /** @returns {Promise<String|null>} a project subfolder, created on demand */
  subfolder: (target, which) => ipcRenderer.invoke('document:subfolder', target, which),
});
