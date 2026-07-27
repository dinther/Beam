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
  optimizer,
} from '@electron-toolkit/utils';
import path from 'path';
import icon from '../assets/images/studio_standalone_logo.svg';
import artnet from './artnet';

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

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile('./out/renderer/index.html');
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
  ipcMain.on('artnet:send', (_event, packet) => artnet.send(packet));

  // Start listening immediately — a visualizer's whole job is to receive.
  artnet.start(forward);
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron');

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  createWindow();
  setupArtnet();

  app.on('activate', () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  /** Forward static files through custom protocol */
  protocol.handle('static', (request) => {
    const url = request.url.substring(7);
    const staticRoot = path.join(__dirname, '../renderer/');
    return net.fetch(`file://${staticRoot}/${url}`);
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
