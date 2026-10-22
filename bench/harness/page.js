/**
 * Cutout background-removal benchmark. Every subject has real transparency,
 * so it is composited onto many backdrops, round-tripped through JPEG like a
 * real upload, and each method's cutout is scored against the known answer.
 *
 * Methods:
 *   current  the original app: ormbg alone
 *   isnet    isnet-general-use alone
 *   app      what ships: isnet, the ormbg second opinion and the backdrop
 *            refinement, using the app's own compiled code
 *
 * Query options: sets=photos,vectors  bgs=red,white,...  limit=N  sheets=1  tag=name
 */
import { needsSecondOpinion, pickMask, refineWithBackdrop, toSquare } from './app.js';

const q = new URLSearchParams(location.search);
const SIDE = 1024;
const MAX_SIDE = 640;
const MODELS = {
  isnet: { model: 'isnet', side: SIDE, mean: [0.5, 0.5, 0.5], std: [1, 1, 1], post: 'minmax' },
  ormbg: { model: 'ormbg', side: SIDE, mean: [0, 0, 0], std: [1, 1, 1], post: 'none' },
};
const BGS = [
  ['white', '#ffffff'], ['black', '#000000'], ['red', '#e53935'], ['green', '#43a047'],
  ['blue', '#1e88e5'], ['yellow', '#fdd835'], ['orange', '#fb8c00'], ['purple', '#8e24aa'],
  ['pink', '#f8bbd0'], ['gray', '#9e9e9e'], ['navy', '#1a237e'], ['matched', null],
  ['gradient', null], ['radial', null], ['texture', null], ['shadow-white', '#ffffff'], ['shadow-teal', '#26a69a'],
];
/** Deliberately adversarial backdrops, reported but kept out of "broken". */
const ADVERSARIAL = new Set(['matched', 'black', 'texture']);
const log = (s) => bench.log(s);
const canvas = (w, h) => { const c = new OffscreenCanvas(w, h); return [c, c.getContext('2d', { willReadFrequently: true })]; };

async function loadSubjects() {
  const out = [];
  for (const set of (q.get('sets') || 'photos,vectors').split(',')) {
    for (const f of (await bench.list(set)).slice(0, Number(q.get('limit') || 999))) {
      const bmp = await createImageBitmap(await (await fetch(`/data/${set}/${f}`)).blob());
      const s = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
      const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
      const [c, ctx] = canvas(w, h);
      ctx.drawImage(bmp, 0, 0, w, h);
      const px = ctx.getImageData(0, 0, w, h).data;
      const gt = new Float32Array(w * h);
      const rs = [], gs = [], bs = [];
      for (let i = 0; i < w * h; i++) {
        gt[i] = px[i * 4 + 3] / 255;
        if (gt[i] > 0.9 && i % 7 === 0) { rs.push(px[i * 4]); gs.push(px[i * 4 + 1]); bs.push(px[i * 4 + 2]); }
      }
      const med = (a) => a.sort((x, y) => x - y)[a.length >> 1] ?? 128;
      out.push({ set, name: f.replace('.png', ''), bmp: c, w, h, px, gt, median: `rgb(${med(rs)},${med(gs)},${med(bs)})` });
    }
  }
  return out;
}

function drawBackground(ctx, w, h, [name, color], subject) {
  if (name === 'matched') { ctx.fillStyle = subject.median; ctx.fillRect(0, 0, w, h); return; }
  if (name === 'gradient') { const g = ctx.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#ff9a9e'); g.addColorStop(1, '#6a82fb'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); return; }
  if (name === 'radial') { const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7); g.addColorStop(0, '#fff8e1'); g.addColorStop(1, '#ff7043'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); return; }
  if (name === 'texture') {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    ctx.fillStyle = '#6d8b74'; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 160; i++) { ctx.fillStyle = `hsla(${rnd() * 360},${40 + rnd() * 40}%,${30 + rnd() * 50}%,0.55)`; ctx.beginPath(); ctx.arc(rnd() * w, rnd() * h, 8 + rnd() * 60, 0, 7); ctx.fill(); }
    return;
  }
  ctx.fillStyle = color; ctx.fillRect(0, 0, w, h);
  if (name.startsWith('shadow')) {
    const [sc, sctx] = canvas(w, h);
    sctx.drawImage(subject.bmp, 0, 0);
    sctx.globalCompositeOperation = 'source-in'; sctx.fillStyle = 'rgba(0,0,0,0.5)'; sctx.fillRect(0, 0, w, h);
    ctx.save(); ctx.filter = 'blur(10px)'; ctx.drawImage(sc, w * 0.04, h * 0.05); ctx.restore();
  }
}

async function compose(subject, bg) {
  const { w, h } = subject;
  const [c, ctx] = canvas(w, h);
  drawBackground(ctx, w, h, bg, subject);
  ctx.drawImage(subject.bmp, 0, 0);
  const bmp = await createImageBitmap(await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 }));
  const [, ctx2] = canvas(w, h);
  ctx2.drawImage(bmp, 0, 0);
  return ctx2.getImageData(0, 0, w, h).data;
}

/** Model mask at model size, cached in out/cache across runs. */
async function predict(key, square, cacheKey) {
  const file = `cache/${cacheKey}-${key}.bin`;
  try {
    const r = await fetch(`/out/${file}`);
    if (r.ok) { const b = new Uint8ClampedArray(await r.arrayBuffer()); if (b.length === SIDE * SIDE) return b; }
  } catch {}
  const res = await bench.infer({ ...MODELS[key], rgba: square });
  const mask = new Uint8ClampedArray(res.mask);
  await bench.save(file, new Uint8Array(mask));
  return mask;
}

/** Upscales a model mask to the image, as the app does. */
function upscale(mask, w, h) {
  const m = new Uint8ClampedArray(SIDE * SIDE * 4);
  for (let i = 0; i < SIDE * SIDE; i++) { m[i * 4] = m[i * 4 + 1] = m[i * 4 + 2] = 255; m[i * 4 + 3] = mask[i]; }
  const [mc, mctx] = canvas(SIDE, SIDE);
  mctx.putImageData(new ImageData(m, SIDE, SIDE), 0, 0);
  const [, octx] = canvas(w, h);
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(mc, 0, 0, w, h);
  const od = octx.getImageData(0, 0, w, h).data;
  return Float32Array.from({ length: w * h }, (_, i) => od[i * 4 + 3] / 255);
}

function score(gt, alpha, rgba, fg, subject) {
  let inter = 0, uni = 0, ce = 0, cn = 0;
  for (let i = 0; i < gt.length; i++) {
    const g = gt[i], a = alpha[i];
    if (g > 0.5 && a > 0.5) inter++;
    if (g > 0.5 || a > 0.5) uni++;
    // Visible error: the cutout over mid grey against the truth, 0..255.
    if (g > 0.02 || a > 0.02) {
      const src = fg || rgba;
      for (let c = 0; c < 3; c++) ce += Math.abs(a * src[i * 4 + c] + (1 - a) * 128 - (g * subject.px[i * 4 + c] + (1 - g) * 128));
      cn += 3;
    }
  }
  return { iou: uni ? inter / uni : 1, err: cn ? ce / cn : 0 };
}

async function sheet(subject, rows, methods) {
  const cell = 150, pad = 4, cols = 1 + methods.length;
  const sw = Math.round(cell * subject.w / Math.max(subject.w, subject.h)), sh = Math.round(cell * subject.h / Math.max(subject.w, subject.h));
  const [c, ctx] = canvas(cols * (cell + pad) + 90, rows.length * (cell + pad) + 24);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#000'; ctx.font = '12px sans-serif';
  ['input', ...methods].forEach((m, j) => ctx.fillText(m, 90 + j * (cell + pad) + 4, 14));
  for (const [r, row] of rows.entries()) {
    const y = 20 + r * (cell + pad);
    ctx.fillStyle = '#000'; ctx.fillText(row.bg, 4, y + cell / 2);
    for (let j = 0; j < cols; j++) {
      const x = 90 + j * (cell + pad);
      for (let yy = 0; yy < sh; yy += 10) for (let xx = 0; xx < sw; xx += 10) { ctx.fillStyle = ((xx + yy) / 10) % 2 ? '#ccc' : '#fff'; ctx.fillRect(x + xx, y + yy, 10, 10); }
      const { w, h } = subject;
      const img = new Uint8ClampedArray(row.rgba);
      if (j > 0) {
        const res = row.results[methods[j - 1]];
        const src = res.fg || row.rgba;
        for (let i = 0; i < w * h; i++) { img[i * 4] = src[i * 4]; img[i * 4 + 1] = src[i * 4 + 1]; img[i * 4 + 2] = src[i * 4 + 2]; img[i * 4 + 3] = Math.round(res.alpha[i] * 255); }
      }
      const [tc, tctx] = canvas(w, h); tctx.putImageData(new ImageData(img, w, h), 0, 0);
      ctx.drawImage(tc, x, y, sw, sh);
    }
  }
  await bench.save(`sheets/${subject.set}-${subject.name}.png`, new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer()));
}

function summary(rows) {
  const methods = ['current', 'isnet', 'app'];
  const mean = (rs, m) => rs.reduce((s, r) => s + r[m].err, 0) / rs.length;
  const broken = (rs, m) => { const real = rs.filter((r) => !ADVERSARIAL.has(r.bg)); return real.filter((r) => r[m].err > 10).length / real.length; };
  const pad = (s, n) => String(s).padStart(n);
  log(`\nVisible error (lower is better) and share visibly broken (error > 10, adversarial backdrops excluded)`);
  log(`${''.padEnd(10)}${methods.map((m) => pad(m, 18)).join('')}`);
  for (const set of new Set(rows.map((r) => r.set))) {
    const rs = rows.filter((r) => r.set === set);
    log(`${set.padEnd(10)}${methods.map((m) => pad(`${mean(rs, m).toFixed(2)} / ${(broken(rs, m) * 100).toFixed(0)}%`, 18)).join('')}`);
  }
  log(`\nBy backdrop, visible error:`);
  for (const [bg] of BGS) {
    const rs = rows.filter((r) => r.bg === bg);
    if (rs.length) log(`${bg.padEnd(14)}${methods.map((m) => pad(mean(rs, m).toFixed(1), 10)).join('')}${ADVERSARIAL.has(bg) ? '   (adversarial)' : ''}`);
  }
}

async function main() {
  const subjects = await loadSubjects();
  const bgs = BGS.filter(([n]) => !q.get('bgs') || q.get('bgs').split(',').includes(n));
  log(`subjects=${subjects.length} backdrops=${bgs.length}`);
  const rows = [];
  for (const [si, subject] of subjects.entries()) {
    const sheetRows = [];
    for (const bg of bgs) {
      const { w, h } = subject;
      const rgba = await compose(subject, bg);
      const square = toSquare({ data: rgba, width: w, height: h }, SIDE);
      const key = `${subject.set}-${subject.name}-${bg[0]}`;
      const isnet = await predict('isnet', square, key);
      const ormbg = await predict('ormbg', square, key);
      let chosen = isnet;
      if (needsSecondOpinion(square, SIDE, SIDE, isnet) && pickMask(square, SIDE, SIDE, isnet, ormbg) === 'backup') chosen = ormbg;
      const refined = refineWithBackdrop(rgba, w, h, upscale(chosen, w, h));
      const results = {
        current: { alpha: upscale(ormbg, w, h) },
        isnet: { alpha: upscale(isnet, w, h) },
        app: { alpha: Float32Array.from(refined.alpha, (v) => v / 255), fg: refined.fg },
      };
      const row = { set: subject.set, subject: subject.name, bg: bg[0] };
      for (const [m, r] of Object.entries(results)) row[m] = score(subject.gt, r.alpha, rgba, r.fg, subject);
      rows.push(row);
      sheetRows.push({ bg: bg[0], rgba, results });
    }
    if (q.get('sheets')) await sheet(subject, sheetRows, ['current', 'isnet', 'app']);
    log(`[${si + 1}/${subjects.length}] ${subject.set}/${subject.name}`);
  }
  await bench.save(`results-${q.get('tag') || 'run'}.json`, new TextEncoder().encode(JSON.stringify(rows)));
  summary(rows);
  bench.done();
}
main().catch((e) => { log('ERROR ' + e.stack); bench.done(); });
