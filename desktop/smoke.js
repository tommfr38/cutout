/**
 * Self-check for the packaged app, run with CUTOUT_SMOKE_IMAGE=<path to a
 * photo>. It pushes that image through the real interface and the native
 * background remover, prints what came back, and exits non-zero on failure.
 * Useful in CI, where nobody is looking at the window.
 */
const fs = require('node:fs');
const path = require('node:path');

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

/**
 * Second phase, enabled with CUTOUT_SMOKE_SMART=1: brush over the middle of
 * the picture with the Smart Brush and report whether a selection came back.
 * Unlike automatic removal, this model is not bundled, so the first use needs
 * a connection.
 */
async function runSmartBrush(win) {
  return win.webContents.executeJavaScript(`(async () => {
    const started = performance.now();
    const tool = [...document.querySelectorAll('.tool')].find((t) => t.textContent.includes('Smart Brush'));
    if (!tool) return { ok: false, error: 'Smart Brush tool missing' };
    tool.click();
    await new Promise((r) => setTimeout(r, 300));
    const cv = document.querySelector('canvas.view');
    const box = cv.getBoundingClientRect();
    cv.setPointerCapture = () => {};
    cv.releasePointerCapture = () => {};
    const at = (type, x, y) => cv.dispatchEvent(new PointerEvent(type, {
      pointerId: 21, pointerType: 'mouse', bubbles: true, cancelable: true,
      clientX: box.x + x, clientY: box.y + y, button: 0, buttons: type === 'pointerup' ? 0 : 1,
    }));
    const cx = box.width / 2, cy = box.height / 2;
    at('pointerdown', cx, cy - 40);
    for (let i = 1; i <= 8; i++) { at('pointermove', cx + i, cy - 40 + i * 8); await new Promise((r) => setTimeout(r, 12)); }
    at('pointerup', cx + 8, cy + 24);
    const deadline = performance.now() + 120000;
    while (performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      const working = document.querySelector('.busy') ||
        document.querySelector('.canvas-bottom span')?.textContent?.includes('FINDING');
      if (!working) break;
    }
    const notice = document.querySelector('.notice')?.textContent ?? null;
    return { ok: !notice, notice, wallMs: Math.round(performance.now() - started) };
  })()`);
}

async function run(win, imagePath) {
  const bytes = fs.readFileSync(imagePath);
  const dataUrl = `data:${MIME[path.extname(imagePath).toLowerCase()] ?? 'image/jpeg'};base64,${bytes.toString('base64')}`;
  const name = path.basename(imagePath);
  return win.webContents.executeJavaScript(`(async () => {
    const started = performance.now();
    if (!window.cutoutDesktop) return { ok: false, error: 'native bridge missing' };
    const blob = await (await fetch(${JSON.stringify(dataUrl)})).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], ${JSON.stringify(name)}, { type: blob.type }));
    const input = document.querySelector('input[type=file]');
    if (!input) return { ok: false, error: 'interface did not render' };
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const deadline = performance.now() + 60000;
    while (performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      if (!document.querySelector('.busy') && document.querySelector('.canvas-bottom')) break;
    }
    const notice = document.querySelector('.notice')?.textContent ?? null;
    const wallMs = Math.round(performance.now() - started);
    // Export the result and measure it, so a blank or fully opaque mask fails.
    let alpha = null;
    const origCreate = URL.createObjectURL;
    let captured = null;
    URL.createObjectURL = function (b) { captured = b; return origCreate.call(URL, b); };
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {};
    document.querySelectorAll('button').forEach((b) => { if (b.textContent.includes('Download')) b.click(); });
    for (let i = 0; i < 50 && !captured; i++) await new Promise((r) => setTimeout(r, 100));
    URL.createObjectURL = origCreate;
    HTMLAnchorElement.prototype.click = origClick;
    if (captured) {
      const bmp = await createImageBitmap(captured);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      c.getContext('2d').drawImage(bmp, 0, 0);
      const d = c.getContext('2d').getImageData(0, 0, bmp.width, bmp.height).data;
      let clear = 0, solid = 0;
      for (let i = 3; i < d.length; i += 4) { if (d[i] === 0) clear++; else if (d[i] === 255) solid++; }
      const total = d.length / 4;
      alpha = { width: bmp.width, height: bmp.height, clearPct: +(100 * clear / total).toFixed(1), solidPct: +(100 * solid / total).toFixed(1) };
    }
    return {
      ok: !notice && !!alpha && alpha.clearPct > 5 && alpha.solidPct > 5,
      notice,
      wallMs,
      title: document.querySelector('.document-name')?.textContent ?? null,
      alpha,
    };
  })()`);
}

module.exports = async function smokeTest(win, imagePath) {
  try {
    const result = await run(win, imagePath);
    console.log('SMOKE:', JSON.stringify(result));
    if (result.ok && process.env.CUTOUT_SMOKE_SMART === '1') {
      const smart = await runSmartBrush(win);
      console.log('SMOKE SMART:', JSON.stringify(smart));
      return smart.ok;
    }
    return result.ok;
  } catch (err) {
    console.log('SMOKE:', JSON.stringify({ ok: false, error: err.message }));
    return false;
  }
};
