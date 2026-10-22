// Benchmark host: a hidden window runs the cases; native ONNX Runtime does
// the inference in a plain Node child process.
const { app, BrowserWindow, ipcMain, net, protocol } = require('electron');
const { fork, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const BENCH = path.join(__dirname, '..');
const REPO = path.join(BENCH, '..');
const MODELS = {
  isnet: path.join(REPO, 'public/models/isnet-general-use/onnx/model_quantized.onnx'),
  ormbg: path.join(REPO, 'desktop/models/ormbg-q8.onnx'),
};
protocol.registerSchemesAsPrivileged([{ scheme: 'bench', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

const child = fork(path.join(__dirname, 'infer-node.cjs'), [], {
  execPath: execSync('which node').toString().trim(),
  serialization: 'advanced',
  env: { ...process.env, ORT_MODULE: path.join(REPO, 'desktop/node_modules/onnxruntime-node') },
});
let nextId = 1;
const pending = new Map();
child.on('message', (m) => {
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.ok) p.resolve(m);
  else p.reject(new Error(m.error));
});
ipcMain.handle('infer', (_e, req) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  child.send({ id, ...req, model: MODELS[req.model] });
}));
ipcMain.handle('save', (_e, rel, data) => {
  const f = path.join(BENCH, 'out', rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
});
ipcMain.handle('list', (_e, dir) => fs.readdirSync(path.join(BENCH, 'data', dir)).filter((f) => f.endsWith('.png')).sort());
ipcMain.on('log', (_e, s) => console.log(s));
ipcMain.on('done', () => { child.kill(); app.exit(0); });

void app.whenReady().then(() => {
  for (const [name, file] of Object.entries(MODELS)) if (!fs.existsSync(file)) { console.error(`missing model ${name}: ${file}`); app.exit(1); }
  protocol.handle('bench', (req) => net.fetch(pathToFileURL(path.join(BENCH, decodeURIComponent(new URL(req.url).pathname))).toString()));
  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), backgroundThrottling: false } });
  // Surface page errors, which a hidden window would otherwise swallow.
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) console.error(`page: ${message}`); });
  win.webContents.on('render-process-gone', (_e, d) => { console.error(`page crashed: ${d.reason}`); app.exit(1); });
  void win.loadURL('bench://x/harness/index.html' + (process.env.BENCH_QUERY ? '?' + process.env.BENCH_QUERY : ''));
});
