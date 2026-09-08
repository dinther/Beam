/* eslint-disable no-console */
/* eslint-disable import/no-extraneous-dependencies */
import {
  app,
  BrowserWindow,
  MessageChannelMain,
  desktopCapturer,
  net,
  protocol,
  ipcMain,
  Menu,
  screen,
  session,
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
import EtherDreamDac from './etherdream';
import LaserCubeDac from './lasercube';
import IdnDac from './idn';
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

/** The store the window's last position, size and maximised state live in. */
const WINDOW_STATE = 'window-state';
/** Coalesces a burst of move/resize events into one write. */
let windowStateTimer = null;

/**
 * Whether a window rectangle would land somewhere a display can actually show
 * it.
 *
 * The case this exists for: the window was last on a second monitor that is no
 * longer attached. Restoring its saved position then puts it in empty space
 * where it cannot be reached. So a saved position is only used when it still
 * overlaps a current display enough to grab -- enough of the top edge to catch
 * the title bar -- and otherwise dropped, leaving the OS to centre the window
 * on the primary display.
 *
 * @param {Object} bounds `{ x, y, width, height }`
 * @returns {Boolean}
 */
function boundsOnADisplay(bounds) {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    const right = Math.min(area.x + area.width, bounds.x + bounds.width);
    const bottom = Math.min(area.y + area.height, bounds.y + bounds.height);
    const overlapW = right - Math.max(area.x, bounds.x);
    const overlapH = bottom - Math.max(area.y, bounds.y);
    // A strip wide and tall enough to hold and drag by, not a single pixel.
    return overlapW > 120 && overlapH > 48;
  });
}

/** The last saved window state, or null if there is none or it is unusable. */
function storedWindowState() {
  const state = jsonstore.read(WINDOW_STATE);
  if (!state || typeof state !== 'object') return null;
  if (!Number.isFinite(state.width) || !Number.isFinite(state.height)) return null;
  return state;
}

/**
 * Writes the window's current position, size and maximised state.
 *
 * `getNormalBounds` rather than `getBounds`, so a maximised window remembers
 * the size to *restore* to, not the full-screen size -- otherwise un-maximising
 * after a restart would do nothing.
 */
function persistWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getNormalBounds();
  jsonstore.write(WINDOW_STATE, JSON.stringify({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized: mainWindow.isMaximized(),
  }));
}

/** Persists after a short quiet, so a drag or resize writes once at its end. */
function queueWindowStateSave() {
  if (windowStateTimer) clearTimeout(windowStateTimer);
  windowStateTimer = setTimeout(persistWindowState, 400);
}

function createWindow() {
  // Last time's position and size, if any and if a display can still show them.
  const state = storedWindowState();
  const options = {
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
  };

  // Restore last time's size, and its position too when a display can still
  // show it. Size is clamped up to the minimum; a position on a monitor that is
  // gone is dropped, leaving the window centred on the primary display.
  //
  // With no saved state -- the genuine first run -- open a large window centred
  // on the primary display rather than maximised. The app used to always
  // maximise; remembering the window means honouring what the user leaves it
  // as, so forcing maximise every launch was exactly the behaviour to drop.
  if (state) {
    options.width = Math.max(options.minWidth, Math.round(state.width));
    options.height = Math.max(options.minHeight, Math.round(state.height));
    if (Number.isFinite(state.x) && Number.isFinite(state.y)
      && boundsOnADisplay({
        x: state.x, y: state.y, width: options.width, height: options.height,
      })) {
      options.x = Math.round(state.x);
      options.y = Math.round(state.y);
    }
  } else {
    const area = screen.getPrimaryDisplay().workArea;
    options.width = Math.max(options.minWidth, Math.round(area.width * 0.9));
    options.height = Math.max(options.minHeight, Math.round(area.height * 0.9));
    options.x = area.x + Math.round((area.width - options.width) / 2);
    options.y = area.y + Math.round((area.height - options.height) / 2);
  }

  // Create the browser window.
  mainWindow = new BrowserWindow(options);

  // Write the state back as it changes: once at the end of a drag or resize,
  // and immediately on a maximise change.
  mainWindow.on('resize', queueWindowStateSave);
  mainWindow.on('move', queueWindowStateSave);
  mainWindow.on('maximize', persistWindowState);
  mainWindow.on('unmaximize', persistWindowState);
  // On the way down rather than after: `getNormalBounds` needs the window to
  // still exist, and `closed` has already destroyed it.
  mainWindow.on('close', persistWindowState);

  // electron-vite sets ELECTRON_RENDERER_URL while `dev` is running. In dev we
  // load the live Vite dev server (http origin, assets over http); when packaged
  // we load the built index and serve assets over the `static://` protocol.
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('ready-to-show', () => {
    // Only a window last left maximised reopens maximised; everything else opens
    // at the size and position set in the options above. No forced maximise.
    if (state && state.maximized) mainWindow.maximize();
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
 * The virtual laser DACs, one per protocol.
 *
 * Laser software finds a DAC on the network and streams galvo points to it;
 * Beam answers as one so the software needs nothing installed. Ether Dream
 * for MadLaser and everything else that speaks the open protocol; LaserCube
 * for LaserOS, which speaks to nothing else. Both are receive-only.
 */
/**
 * The DACs Beam answers as, and which of them are switched on.
 *
 * **IDN is the one that runs.** It is the only protocol of the three that can
 * say its own name: its discovery answers carry a host name and its service map
 * a service name, both set to "Beam", which is what a producer then shows in its
 * device list. Ether Dream's beacon has nowhere to put a string at all, so it
 * can only ever appear as "Etherdream" -- it works perfectly well and is a
 * better-specified protocol, but a rig with one virtual laser in it should say
 * what that laser is. Switched off rather than deleted: flip the flag if a
 * producer turns up that speaks Ether Dream and nothing else.
 *
 * **The LaserCube is built and kept, but off.** It works -- it answers a real
 * LaserCube's discovery and carries its point format -- but the only software
 * that would talk to it here is LaserOS, and LaserOS gates its DACs behind an
 * ATSHA204 challenge Beam cannot answer. Rather than delete a working
 * implementation of a protocol that is a day's work to write, it stays here
 * unstarted: flip the flag and it listens again. Nothing binds its ports while
 * it is off, which also leaves them free for LaserOS itself.
 */
const LASER_ENABLED = {
  etherdream: false,
  lasercube: false,
  idn: true,
};

const lasers = {
  etherdream: new EtherDreamDac(),
  lasercube: new LaserCubeDac(),
  idn: new IdnDac(),
};

function setupLaser() {
  // A laser batch is ~24 KB a flush, a thirtieth of what a big DMX rig
  // sends, so it takes the plain IPC path rather than a transferred port.
  const forward = (kind) => (batch) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('laser:frames', { protocol: kind, ...batch });
    }
  };

  // Starting is a promise because binding can fail, and for the LaserCube it
  // fails for one specific reason worth naming: LaserOS on this machine
  // holds the same ports. A DAC that cannot bind is reported as not
  // listening rather than crashing the app.
  const startLaser = async (kind) => {
    const dac = lasers[kind];
    if (!dac) return false;
    if (!LASER_ENABLED[kind]) return false;
    try {
      await dac.start(forward(kind));
    } catch (err) {
      console.error(`[laser] ${kind} did not start:`, err.message);
    }
    return dac.listening;
  };

  ipcMain.handle('laser:start', (_event, kind) => startLaser(kind));
  ipcMain.handle('laser:stop', (_event, kind) => {
    const dac = lasers[kind];
    if (dac) dac.stop();
    return dac ? dac.listening : false;
  });
  ipcMain.handle('laser:report', () => Object.values(lasers).map((dac) => dac.report()));

  // The show's own lasers, so IDN can offer one named service per fixture.
  // Only IDN carries names; the others have nowhere to put one.
  // Which producer stream feeds which laser is first-come and therefore
  // arbitrary; this swaps them when they land the wrong way round.
  ipcMain.handle('laser:rotateStreams', () => {
    if (lasers.idn && lasers.idn.rotateStreams) lasers.idn.rotateStreams();
    return true;
  });

  ipcMain.handle('laser:services', (_event, services) => {
    if (lasers.idn && lasers.idn.setServices) lasers.idn.setServices(services);
    return true;
  });

  // Whatever is switched on, from the start, like the DMX receivers: a
  // visualizer's job is to receive, and the software on the other end is
  // looking for a device the moment it opens.
  Object.keys(lasers).filter((kind) => LASER_ENABLED[kind]).forEach(startLaser);
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

/**
 * Let the renderer capture desktop audio for a video recording.
 *
 * `getDisplayMedia` reaches the main process through this handler and gets
 * nothing at all without one -- Electron has no default. `audio: 'loopback'`
 * is what makes Windows hand over the system audio mix, which is the point:
 * a recording of the visualizer is worth much more with the track on it.
 *
 * A screen source has to be named even though only the audio is wanted -- the
 * API will not return audio alone. The renderer stops the video track the
 * moment the stream arrives, so nothing is captured from the screen; see
 * `captureDesktopAudio` in `recorder.js`.
 *
 * Verified in Electron 41.7.1: the track arrives labelled "System audio" with
 * `deviceId: loopback`, and the constraints the renderer asks for are honoured
 * (stereo, no AGC, no echo cancellation, no noise suppression). Without those
 * it defaults to mono voice processing, which pumps and smears music.
 */
function setupDesktopAudio() {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] })
      .then((sources) => {
        if (!sources.length) {
          callback({});
          return;
        }
        callback({ video: sources[0], audio: 'loopback' });
      })
      .catch((err) => {
        console.error(`[audio] could not enumerate screens: ${err.message}`);
        callback({});
      });
  }, { useSystemPicker: false });
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

  setupDesktopAudio();
  createWindow();
  setupArtnet();
  setupLaser();
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
  Object.values(lasers).forEach((dac) => dac.stop());
  app.quit();
});
