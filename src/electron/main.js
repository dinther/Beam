/* eslint-disable no-console */
/* eslint-disable import/no-extraneous-dependencies */
import {
  app,
  BrowserWindow,
  net,
  protocol,
  ipcMain,
} from 'electron';
import {
  electronApp,
  is,
  optimizer,
} from '@electron-toolkit/utils';
import path from 'path';
import icon from '../assets/images/beam_logo.png?asset';
import artnet from './artnet';
import jsonstore from './jsonstore';
import fileexport from './fileexport';

// GPU timer queries are disabled by default because precise timing is a
// side-channel and fingerprinting vector. Enabled in development only, so the
// perf overlay can report real GPU milliseconds, and never in a build that
// ships to anyone.
if (is.dev) {
  app.commandLine.appendSwitch('enable-webgl-draft-extensions');
}

// Where show files live, pinned by hand rather than inherited from the app
// name. Electron derives userData from `name` in package.json during
// development but from `productName` once packaged, so the two disagree by
// design -- and every rename moves the folder again. That has already orphaned
// a show once. Pinning it means both builds read and write the same
// %APPDATA%/Beam, and a future rename cannot move it.
app.setPath('userData', path.join(app.getPath('appData'), 'Beam'));

console.log('MAIN PROCESS STARTED');

process.on('exit', (code) => {
  console.log('💀 PROCESS EXIT EVENT', code);
});

process.on('beforeExit', (code) => {
  console.log('⚠️ BEFORE EXIT', code);
});

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
});

process.env.ELECTRON_ENABLE_LOGGING = '1';
process.env.ELECTRON_ENABLE_STACK_DUMPING = '1';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'static',
    privileges: {
      bypassCSP: true,
      standard: true,
      secure: true,
      supportFetchAPI: true,
      // The packaged renderer runs on a file:// origin, so every static://
      // request is cross-origin. Without this the fetch is blocked outright
      // and the handler's Access-Control-Allow-Origin header never applies.
      corsEnabled: true,
    },
  },
]);

let mainWindow = null;

function createWindow() {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 1200,
    minHeight: 800,

    vibrancy: 'under-window', // optional
    visualEffectState: 'active',
    show: false,
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      sandbox: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/preload.js'),
    },
  });

  // electron-vite sets ELECTRON_RENDERER_URL while `dev` is running. In dev we
  // load the live Vite dev server (http origin, assets over http); when packaged
  // we load the built index and serve assets over the `static://` protocol.
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    if (mainWindow) mainWindow.destroy();
    mainWindow = null;
  });
}

/**
 * Wires the main-process Art-Net engine to the renderer over IPC and opens the
 * receive socket. Inbound frames are forwarded to the focused window; the
 * renderer decides (per universe) whether to act on them.
 */
function setupArtnet() {
  const forward = (frame) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('artnet:frame', frame);
    }
  };

  ipcMain.handle('artnet:start', (_event, config) => {
    artnet.start(forward, config);
    return artnet.listening;
  });
  ipcMain.handle('artnet:stop', () => {
    artnet.stop();
    return artnet.listening;
  });

  // Start listening immediately — a visualizer's whole job is to receive.
  artnet.start(forward);
}

/**
 * Named JSON stores in the application data directory: `show` for the working
 * show, `preferences` for application settings.
 */
function setupJsonStore() {
  ipcMain.handle('store:read', (_event, name) => jsonstore.read(name));
  ipcMain.handle('store:write', (_event, name, json) => jsonstore.write(name, json));
  ipcMain.handle('store:clear', (_event, name) => jsonstore.clear(name));
  ipcMain.handle('store:path', (_event, name) => jsonstore.storePath(name));
}

/**
 * Saving generated documents for other applications to read.
 */
function setupFileExport() {
  ipcMain.handle('file:export', (_event, payload) => fileexport.save(payload));
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Windows groups taskbar buttons and attributes notifications by this
  // id, so it has to be ours rather than the toolkit's boilerplate default
  // -- and it has to match the appId electron-builder installs under, or a
  // pinned shortcut and the running window are treated as two apps.
  electronApp.setAppUserModelId('com.beatline.beam');

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  createWindow();
  setupArtnet();
  setupJsonStore();
  setupFileExport();

  app.on('activate', () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  /** Forward static files through custom protocol (with CORS for the file:// renderer) */
  protocol.handle('static', async (request) => {
    const url = request.url.substring(7);
    const staticRoot = path.join(__dirname, '../renderer/');
    const response = await net.fetch(`file://${staticRoot}/${url}`);
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  });
});

app.on('before-quit', () => {
  BrowserWindow.getAllWindows().forEach((w) => {
    w.destroy();
  });
});

app.on('before-quit', () => {
  protocol.unhandle('static');
});

app.on('window-all-closed', () => {
  artnet.stop();
  app.quit();
});
