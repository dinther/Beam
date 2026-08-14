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
