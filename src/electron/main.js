/* eslint-disable no-console */
/* eslint-disable import/no-extraneous-dependencies */
import {
  app,
  BrowserWindow,
  MessageChannelMain,
  net,
  protocol,
  ipcMain,
  Menu,
} from 'electron';
import {
  electronApp,
  is,
  optimizer,
} from '@electron-toolkit/utils';
import path from 'path';
import icon from '../assets/images/beam_logo.png?asset';
import artnet from './artnet';
import sacn from './sacn';
import jsonstore from './jsonstore';
import library from './library';
import objectstore from './objectstore';
import documentstore from './documentstore';
import videorecorder from './videorecorder';
import environmentstore from './environmentstore';
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
    // Models the user dropped into their library, served as files. A .glb is
    // megabytes of binary: handing it over IPC would mean a structured clone
    // per load, where a URL lets GLTFLoader stream it. Read-only, and
    // `objectstore.resolve` decides what may be read -- see there for why the
    // renderer is not trusted to name a path.
    scheme: 'library',
    privileges: {
      bypassCSP: true,
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
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

/**
 * A project named on the command line, waiting for the renderer to be ready.
 *
 * Double-clicking a `.beam` starts the application with that path in argv, or
 * hands it to the copy already running. Either way it arrives long before there
 * is anything to open it with, so it waits here until the renderer asks.
 */
let pendingDocument = null;

/**
 * Whether the splash still owes the user an appearance this launch.
 *
 * Lives here because this process is the only one that can tell starting the
 * application from the renderer restarting itself. New Project and Open both
 * finish with `window.location.reload()` -- the comment above each says why --
 * and a reload re-evaluates every renderer module, so no flag over there can
 * survive one. From main's point of view a reload is not a launch, which is
 * the whole distinction.
 */
let splashUnclaimed = true;

/**
 * The project among a set of command line arguments, if there is one.
 *
 * Only our own extension counts. Everything else on that line belongs to
 * Chromium or, in development, to electron-vite.
 *
 * @param {Array} argv
 * @returns {String|null} absolute path, or null
 */
function documentFromArgv(argv) {
  return argv.slice(1).find((arg) => arg.toLowerCase().endsWith('.beam')) || null;
}

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
    // Hidden *and* unreachable. `autoHideMenuBar` only tucks it away: Alt
    // still summons it, which on Windows resizes the content area -- and Alt
    // is a modifier this app uses, for the fine step on a dragged number. A
    // pointer locked to a number field got warped by the resize and arrived as
    // a single 1159-pixel movement, which is how a fixture jumped across the
    // room mid-drag. The app has its own toolbar; the default menu is only a
    // trap for a key we want.
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
    // Before the window is gone: a recording still running has just lost the
    // page that was feeding it, and an unclosed write stream loses its tail.
    videorecorder.closeAll();
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
  /**
   * The renderer's transferable channel, once it has asked for one.
   *
   * `webContents.send` structured-clones its payload, and with
   * `contextIsolation` on the preload has to copy it again to get it across
   * the context bridge. That is two copies of every batch: for a 512 x 512
   * panel, 1,536 universes is 786 KB a flush, so about 94 MB/s of pure copying
   * to move bytes between two processes on the same machine.
   *
   * A port lands straight in the page's own world, so the context-bridge copy
   * goes away and one copy carries the batch instead of two.
   *
   * It is only one, not none. `MessagePortMain.postMessage` accepts a transfer
   * list of `MessagePortMain` objects and nothing else -- handing it the
   * batch's ArrayBuffers throws, which is exactly how this arrived silent the
   * first time: every flush raised inside the timer and not one universe was
   * delivered. Getting to zero copies needs a SharedArrayBuffer, not a
   * transfer.
   */
  let framePort = null;

  const forward = (batch) => {
    if (framePort) {
      try {
        framePort.postMessage(batch);
        return;
      } catch (err) {
        // Never let a broken fast path mean no DMX at all. A dead port is
        // dropped and the copying path below carries this batch and the rest.
        console.error('[artnet] frame port failed, falling back to IPC:', err.message);
        framePort = null;
      }
    }
    // Until the renderer asks for a port -- and in any renderer that never
    // does -- the original copying path still works.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('artnet:frames', batch);
    }
  };

  // Asked for by the renderer rather than pushed at it, so there is no window
  // in which a port is delivered before anything is listening for it.
  ipcMain.on('artnet:request-port', (event) => {
    if (framePort) framePort.close();
    const { port1, port2 } = new MessageChannelMain();
    framePort = port2;
    framePort.on('close', () => {
      if (framePort === port2) framePort = null;
    });
    framePort.start();
    event.sender.postMessage('artnet:port', null, [port1]);
  });

  ipcMain.handle('artnet:start', (_event, config) => {
    artnet.start(forward, config);
    return artnet.listening;
  });
  ipcMain.handle('artnet:stop', () => {
    artnet.stop();
    return artnet.listening;
  });

  // Which multicast groups are worth joining is the show's business: one group
  // per universe is 386 IGMP memberships on a 256 x 256 tile, and switches
  // start dropping groups well before that. The renderer says what is patched.
  ipcMain.handle('sacn:listen-to', (_event, universes) => {
    sacn.listenTo(universes);
    return sacn.joined.size;
  });
  // Who is sending, on either wire, and where two of them collide.
  ipcMain.handle('dmx:sources', () => ({
    sources: [...artnet.sourceReport(), ...sacn.sourceReport()],
    conflicts: sacn.conflicts(),
  }));

  // Start listening immediately — a visualizer's whole job is to receive. Both
  // protocols at once: they are different sockets writing one address space,
  // and asking the user to pick first is asking them to know what the other
  // application is doing before they can see anything at all.
  artnet.start(forward);
  sacn.start(forward);
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

/**
 * The user's fixture library, one file per item.
 */
function setupLibrary() {
  // Before the renderer can ask for anything: a show that names a demo
  // structure has to find it on the first load, not the second.
  library.seedDefaults();
  ipcMain.handle('library:readAll', (_event, kind) => library.readAll(kind));
  ipcMain.handle('library:write', (_event, kind, key, json) => library.writeItem(kind, key, json));
  ipcMain.handle('library:remove', (_event, kind, key) => library.removeItem(kind, key));
  ipcMain.handle('library:root', () => library.libraryRoot());
  // The folder is the catalogue: whatever is in Library/Objects is what the
  // app offers, with no index to fall out of step with it.
  ipcMain.handle('library:objects', () => objectstore.list());
  // Creating an object writes a descriptor rather than a model: a built shape
  // is a handful of numbers, so it stays editable and costs nothing to store.
  ipcMain.handle(
    'library:createObject',
    (event, name, primitive) => objectstore.writePrimitive(name, primitive),
  );
  // Previews are rendered in the renderer -- it is the one with a GPU and a
  // loader -- and stored here, beside the model they picture.
  ipcMain.handle(
    'library:writeThumbnail',
    (event, key, dataUrl) => objectstore.writeThumbnail(key, dataUrl),
  );

  // Environment images. Listed rather than browsed: the renderer picks a name
  // out of the library, and `objectstore.resolve` turns that name into a file.
  ipcMain.handle('library:environments', () => environmentstore.list());
  // The dialog is attached to the window so it is modal to Beam rather than
  // floating loose, which is how every other file prompt here behaves.
  ipcMain.handle('library:addEnvironment', () => environmentstore.add(mainWindow));
}

/**
 * Video recordings of the visualizer, streamed to disk as they encode.
 *
 * Chunk writes are `handle` rather than `send` so a full disk or a closed
 * stream reaches the page as a rejected promise it can stop on, instead of
 * failing silently for the rest of the take.
 */
function setupVideoRecorder() {
  ipcMain.handle('video:begin', (_event, payload) => videorecorder.begin(payload));
  ipcMain.handle('video:write', (_event, id, chunk) => videorecorder.write(id, chunk));
  ipcMain.handle('video:end', (_event, id) => videorecorder.end(id));
  ipcMain.handle('video:abort', (_event, id) => videorecorder.abort(id));
  ipcMain.handle('video:reveal', (_event, target) => videorecorder.reveal(target));
}

/**
 * Show documents at paths the user chose.
 */
function setupDocumentStore() {
  ipcMain.handle('document:read', (_event, target) => documentstore.read(target));
  ipcMain.handle('document:resources', (_event, target) => documentstore.readResources(target));
  ipcMain.handle('document:write', (_event, target, json, resources) => documentstore.write(target, json, resources));
  ipcMain.handle('document:open', () => documentstore.openDialog());
  ipcMain.handle('document:saveAs', (_event, name, title) => documentstore.saveDialog(name, title));
  ipcMain.handle('document:projectName', (_event, target) => documentstore.projectNameFor(target));
  ipcMain.handle('document:root', () => documentstore.projectRoot());
  // Claimed rather than read: the renderer opens it once, and a reload must not
  // reopen a file the user has since moved on from.
  ipcMain.handle('document:claimPending', () => {
    const target = pendingDocument;
    pendingDocument = null;
    return target;
  });

  // Synchronous on purpose, and the one place that earns it: preload asks
  // before any renderer code runs, so the answer is already in hand when the
  // app mounts. Asked asynchronously the splash would flash up and vanish on
  // every New Project.
  ipcMain.on('app:claimSplash', (event) => {
    event.returnValue = splashUnclaimed;
    splashUnclaimed = false;
  });
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
// A second launch is not a second application. Windows starts one per
// double-clicked file, so without this each project would open its own copy of
// Beam, each with its own idea of what is open.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const target = documentFromArgv(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (target) mainWindow.webContents.send('document:requested', target);
    } else {
      pendingDocument = target;
    }
  });
}

app.whenReady().then(() => {
  pendingDocument = documentFromArgv(process.argv);

  // Windows groups taskbar buttons and attributes notifications by this
  // id, so it has to be ours rather than the toolkit's boilerplate default
  // -- and it has to match the appId electron-builder installs under, or a
  // pinned shortcut and the running window are treated as two apps.
  electronApp.setAppUserModelId('com.beatline.beam');

  // See `autoHideMenuBar`: removing the menu entirely is what stops Alt from
  // reaching it. F12 and reload come from `optimizer.watchWindowShortcuts`
  // below rather than from here, so they are unaffected.
  Menu.setApplicationMenu(null);

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
  setupLibrary();
  setupDocumentStore();
  setupVideoRecorder();

  app.on('activate', () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  /**
   * Library models, by URL rather than by IPC.
   *
   * Answers a refusal with 404 rather than an explanation: a renderer asking
   * for a path it may not have is not owed the difference between "outside the
   * library" and "not a model".
   */
  protocol.handle('library', async (request) => {
    // Host and path together: the scheme is `standard`, so the first segment
    // is parsed as a host and would otherwise be dropped. `objectstore.resolve`
    // reads it as the kind of thing being asked for.
    const url = new URL(request.url);
    const target = objectstore.resolve(decodeURIComponent(`${url.host}${url.pathname}`));
    if (!target) return new Response('Not found', { status: 404 });
    const response = await net.fetch(`file://${target}`);
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
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
  protocol.unhandle('library');
});

app.on('window-all-closed', () => {
  artnet.stop();
  sacn.stop();
  app.quit();
});
