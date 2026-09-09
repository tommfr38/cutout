/**
 * Renders the app icon (build/icon.png, 1024 square) so the installers do not
 * ship with the default Electron logo. Run with `npm run icon`, which uses
 * Electron because it already provides a canvas and a PNG encoder.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const HTML = `<!doctype html><meta charset="utf-8"><body style="margin:0">
<canvas id="c" width="1024" height="1024"></canvas>
<script>
const ctx = document.getElementById('c').getContext('2d');
// Rounded square in the brand's near-black.
const r = 224;
ctx.fillStyle = '#17202c';
ctx.beginPath();
ctx.moveTo(r, 0); ctx.lineTo(1024 - r, 0); ctx.quadraticCurveTo(1024, 0, 1024, r);
ctx.lineTo(1024, 1024 - r); ctx.quadraticCurveTo(1024, 1024, 1024 - r, 1024);
ctx.lineTo(r, 1024); ctx.quadraticCurveTo(0, 1024, 0, 1024 - r);
ctx.lineTo(0, r); ctx.quadraticCurveTo(0, 0, r, 0);
ctx.fill();
// Scissors, drawn on lucide's 24 unit grid and scaled up.
const s = 34, ox = 512 - 12 * s, oy = 512 - 12 * s;
ctx.translate(ox, oy); ctx.scale(s, s);
ctx.strokeStyle = '#c5f05a';
ctx.lineWidth = 2.1;
ctx.lineCap = 'round';
ctx.lineJoin = 'round';
const line = (x1, y1, x2, y2) => { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };
const circle = (cx, cy, rad) => { ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.stroke(); };
circle(6, 6, 3);
circle(6, 18, 3);
line(8.12, 8.12, 12, 12);
line(20, 4, 8.12, 15.88);
line(14.8, 14.8, 20, 20);
window.__png = document.getElementById('c').toDataURL('image/png');
</script></body>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1024, height: 1024 });
  await win.loadURL('data:text/html;base64,' + Buffer.from(HTML).toString('base64'));
  const dataUrl = await win.webContents.executeJavaScript('window.__png');
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('icon written to', out, fs.statSync(out).size, 'bytes');
  app.exit(0);
});
