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
  /** Emit an ArtDMX packet: { universe, data, ip, port } */
  send: (packet) => ipcRenderer.send('artnet:send', packet),
  /** Open the receive socket. */
  start: (config) => ipcRenderer.invoke('artnet:start', config),
  /** Close the receive socket. */
  stop: () => ipcRenderer.invoke('artnet:stop'),
});

/**
 * Show persistence.
 *
 * The working show lives in a file in the application data directory rather
 * than in browser storage: this is a desktop application, and its state should
 * be inspectable and backup-able like any other program's.
 */
contextBridge.exposeInMainWorld('showStore', {
  /** @returns {Promise<Object|null>} the persisted show, or null if none */
  read: () => ipcRenderer.invoke('show:read'),
  /**
   * @param {String} json serialised show data
   * @returns {Promise<Boolean>} whether the write succeeded
   */
  write: (json) => ipcRenderer.invoke('show:write', json),
  /** @returns {Promise<Boolean>} whether anything was removed */
  clear: () => ipcRenderer.invoke('show:clear'),
  /** @returns {Promise<String>} absolute path of the show file */
  path: () => ipcRenderer.invoke('show:path'),
});
