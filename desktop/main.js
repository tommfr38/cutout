/**
 * Cutout desktop. Loads the same interface as the website, but sends
 * automatic background removal to a native ONNX Runtime process instead of
 * WebAssembly, which is several times faster.
 */
const { app, BrowserWindow, ipcMain, net, protocol, shell, utilityProcess } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const UI_SCHEME = 'cutout';
const UI_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'ui')
  : path.join(__dirname, '..', 'dist', 'client');
const MODELS_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'models')
  : path.join(__dirname, 'models');
const MODEL_PATH = path.join(MODELS_ROOT, 'ormbg-q8.onnx');

// A standard, secure scheme so the page behaves like it does on the web:
// absolute paths, workers, fetch and the Cache API all work unchanged.
protocol.registerSchemesAsPrivileged([
  {
    scheme: UI_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

// ---------------------------------------------------------------- inference

let child = null;
let nextId = 1;
const pending = new Map();

function inferenceProcess() {
  if (child) return child;
  child = utilityProcess.fork(path.join(__dirname, 'inference.js'), [], {
    serviceName: 'cutout-inference',
  });
  child.on('message', (msg) => {
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg);
    else entry.reject(new Error(msg.error));
  });
  child.on('exit', () => {
    for (const entry of pending.values()) {
      entry.reject(new Error('The background remover stopped unexpectedly.'));
    }
    pending.clear();
    child = null;
  });
  send('configure', { modelPath: MODEL_PATH }).catch(() => {});
  return child;
}

function send(type, payload) {
  const proc = inferenceProcess();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    proc.postMessage({ id, type, payload });
  });
}

ipcMain.handle('cutout:remove-background', async (_event, rgba) => {
  const result = await send('remove-background', { rgba });
  return { mask: result.mask, width: result.width, height: result.height, ms: result.ms };
});

// ------------------------------------------------------------------- window

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: '#fafbfc',
    title: 'Cutout',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(`${UI_SCHEME}://app/index.html`);
  // Optional self-check; see smoke.js.
  if (process.env.CUTOUT_SMOKE_IMAGE) {
    win.webContents.once('did-finish-load', async () => {
      const ok = await require('./smoke')(win, process.env.CUTOUT_SMOKE_IMAGE);
      app.exit(ok ? 0 : 1);
    });
  }
  // Anything the page tries to open externally goes to the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:$/.test(new URL(url).protocol)) shell.openExternal(url);
    return { action: 'deny' };
  });
  return win;
}

app.whenReady().then(() => {
  protocol.handle(UI_SCHEME, (request) => {
    const { pathname } = new URL(request.url);
    const relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    // /models/ serves the bundled Smart Brush files; everything else is the
    // interface. Both reads are pinned inside their own directory.
    const isModel = relative.startsWith('/models/');
    const root = isModel ? MODELS_ROOT : UI_ROOT;
    const target = path.join(
      root,
      path.normalize(isModel ? relative.slice('/models'.length) : relative),
    );
    if (!target.startsWith(root)) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(target).toString());
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  child?.kill();
});
