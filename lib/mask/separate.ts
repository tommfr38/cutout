/**
 * Background separation for images whose background is a flat colour or a
 * smooth gradient: studio and product shots, logos, illustrations, and most
 * "subject on a coloured backdrop" pictures.
 *
 * The automatic model was trained mostly on people, and its guesses get
 * shaky on strongly coloured backdrops and on flat graphics. When the
 * backdrop is plain, though, it can simply be measured: fit its colour to the
 * image border, then recover each pixel's opacity from how far it is from that
 * colour. The model is only consulted where colour alone cannot decide:
 * subject areas the same colour as the backdrop, enclosed holes in photos, and
 * shadows. See docs/MODELS.md for the measurements behind the thresholds.
 */

type Model = { quad: boolean; coef: number[][]; noise: number; inlierFrac: number; flat: boolean };

function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-9;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-9));
}

const basis = (x: number, y: number, quad: boolean) =>
  quad ? [1, x, y, x * x, y * y, x * y] : [1, x, y];

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = Float32Array.from(values).sort();
  return s[s.length >> 1];
}

/**
 * Robustly fits the border colour as a plane (or, for curved gradients, a
 * quadratic) in x and y, per channel. Border pixels belonging to a subject
 * that touches the edge are rejected as outliers.
 */
export function fitBackground(rgba: Uint8ClampedArray, w: number, h: number): Model {
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.015));
  const total = 2 * band * (w + h);
  const stride = Math.max(1, Math.floor(total / 6000));
  const xs: number[] = [];
  const ys: number[] = [];
  const cs: number[][] = [];
  let k = 0;
  const take = (x: number, y: number) => {
    if (k++ % stride) return;
    const i = (y * w + x) * 4;
    xs.push(x / (w - 1 || 1));
    ys.push(y / (h - 1 || 1));
    cs.push([rgba[i], rgba[i + 1], rgba[i + 2]]);
  };
  for (let y = 0; y < band; y++) for (let x = 0; x < w; x++) { take(x, y); take(x, h - 1 - y); }
  for (let x = 0; x < band; x++) for (let y = band; y < h - band; y++) { take(x, y); take(w - 1 - x, y); }

  let best: Model | null = null;
  for (const quad of [false, true]) {
    const m = quad ? 6 : 3;
    let inl = new Uint8Array(xs.length).fill(1);
    let coef: number[][] = [];
    let res = new Float32Array(xs.length);
    for (let it = 0; it < 5; it++) {
      coef = [0, 1, 2].map((c) => {
        const A = Array.from({ length: m }, () => Array.from<number>({ length: m }).fill(0));
        const bv = Array.from<number>({ length: m }).fill(0);
        for (let i = 0; i < xs.length; i++) {
          if (!inl[i]) continue;
          const f = basis(xs[i], ys[i], quad);
          for (let r = 0; r < m; r++) {
            bv[r] += f[r] * cs[i][c];
            for (let s = 0; s < m; s++) A[r][s] += f[r] * f[s];
          }
        }
        for (let r = 0; r < m; r++) A[r][r] += 1e-6;
        return solveLinear(A, bv);
      });
      res = new Float32Array(xs.length);
      for (let i = 0; i < xs.length; i++) {
        const f = basis(xs[i], ys[i], quad);
        let d2 = 0;
        for (let c = 0; c < 3; c++) {
          let v = 0;
          for (let r = 0; r < m; r++) v += coef[c][r] * f[r];
          d2 += (cs[i][c] - v) ** 2;
        }
        res[i] = Math.sqrt(d2);
      }
      const med = median(Array.from(res).filter((_, i) => inl[i]));
      const cut = Math.max(10, 2.5 * med);
      inl = Uint8Array.from(res, (r) => (r < cut ? 1 : 0));
    }
    const inRes = Array.from(res).filter((_, i) => inl[i]);
    const fit: Model = { quad, coef, noise: median(inRes), inlierFrac: inRes.length / xs.length, flat: false };
    const score = (f: Model) => f.noise + (1 - f.inlierFrac) * 20;
    if (!best || score(fit) < score(best) - 1) best = fit;
  }
  best!.flat = best!.inlierFrac >= 0.55 && best!.noise <= 7;
  return best!;
}

/** Expected background colour at every pixel, as interleaved RGB floats. */
function backgroundField(model: Model, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h * 3);
  const m = model.quad ? 6 : 3;
  for (let y = 0; y < h; y++) {
    const ny = y / (h - 1 || 1);
    for (let x = 0; x < w; x++) {
      const f = basis(x / (w - 1 || 1), ny, model.quad);
      const o = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) {
        let v = 0;
        for (let r = 0; r < m; r++) v += model.coef[c][r] * f[r];
        out[o + c] = v;
      }
    }
  }
  return out;
}

interface Separation {
  alpha: Float32Array;
  /** Backdrop-coloured pixels reachable from the border (not enclosed holes). */
  outside: Uint8Array;
  /** Fitted backdrop colour per pixel, interleaved RGB. */
  B: Float32Array;
  /** Colour distance from the backdrop. */
  dist: Float32Array;
  /** Index of the nearest solid subject pixel, or -1. */
  src: Int32Array;
  /** Distance between that subject colour and the backdrop. */
  contrast: Float32Array;
  tHigh: number;
}

/**
 * Opacity from a known backdrop: a pixel is a*F + (1-a)*B, with B the
 * fitted backdrop colour and F the colour of the nearest clearly-foreground
 * pixel, so a = (I-B)·(F-B) / |F-B|².
 */
function separate(rgba: Uint8ClampedArray, w: number, h: number, model: Model): Separation {
  const n = w * h;
  const B = backgroundField(model, w, h);
  const tLow = Math.max(12, 3 * model.noise + 8);
  const tHigh = tLow + 45;
  const dist = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const q = i * 3;
    dist[i] = Math.hypot(rgba[p] - B[q], rgba[p + 1] - B[q + 1], rgba[p + 2] - B[q + 2]);
  }
  // Nearest clearly-foreground pixel, spread outwards breadth-first.
  const R = 10;
  const src = new Int32Array(n).fill(-1);
  const depth = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  // Colour references come only from pixels well inside the subject. An edge
  // pixel is part backdrop, and using it as the reference would make every
  // edge look fully opaque, drawing a dark or coloured outline.
  const strong = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (dist[i] >= tHigh) strong[i] = 1;
  const isSeed = (i: number) => {
    const x = i % w;
    const y = (i / w) | 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (!strong[ny * w + nx]) return false;
      }
    }
    return true;
  };
  for (let i = 0; i < n; i++) if (strong[i] && isSeed(i)) { src[i] = i; queue[tail++] = i; }
  while (head < tail) {
    const i = queue[head++];
    if (depth[i] >= R) continue;
    const x = i % w;
    const y = (i / w) | 0;
    const visit = (j: number) => {
      if (src[j] !== -1 || dist[j] < tLow * 0.5) return;
      src[j] = src[i];
      depth[j] = depth[i] + 1;
      queue[tail++] = j;
    };
    if (x > 0) visit(i - 1);
    if (x < w - 1) visit(i + 1);
    if (y > 0) visit(i - w);
    if (y < h - 1) visit(i + w);
  }
  const alpha = new Float32Array(n);
  const contrast = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const d = dist[i];
    if (d <= tLow) continue;
    const s = src[i];
    if (s === i || (s < 0 && d >= tHigh)) { alpha[i] = 1; continue; }
    const p = i * 4;
    const q = i * 3;
    if (s >= 0) {
      const sp = s * 4;
      const fr = rgba[sp] - B[q];
      const fgr = rgba[sp + 1] - B[q + 1];
      const fb = rgba[sp + 2] - B[q + 2];
      const ff = fr * fr + fgr * fgr + fb * fb;
      const a = ((rgba[p] - B[q]) * fr + (rgba[p + 1] - B[q + 1]) * fgr + (rgba[p + 2] - B[q + 2]) * fb) / (ff || 1);
      alpha[i] = a < 0 ? 0 : a > 1 ? 1 : a;
      contrast[i] = Math.sqrt(ff);
    } else {
      alpha[i] = (d - tLow) / (tHigh - tLow);
    }
  }
  // Backdrop-coloured pixels connected to the border.
  const outside = new Uint8Array(n);
  head = 0;
  tail = 0;
  const seed = (i: number) => {
    if (!outside[i] && alpha[i] < 0.5) { outside[i] = 1; queue[tail++] = i; }
  };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    const y = (i / w) | 0;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (y > 0) seed(i - w);
    if (y < h - 1) seed(i + w);
  }
  return { alpha, outside, B, dist, src, contrast, tHigh };
}

/** Pixels whose whole (2r+1)² neighbourhood is inside the mask. */
function erode(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const I = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += mask[y * w + x];
      I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row;
    }
  }
  const out = new Uint8Array(w * h);
  const full = (2 * r + 1) ** 2;
  for (let y = r; y < h - r; y++) {
    for (let x = r; x < w - r; x++) {
      const x0 = x - r, y0 = y - r, x1 = x + r + 1, y1 = y + r + 1;
      const s = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
      if (s === full) out[y * w + x] = 1;
    }
  }
  return out;
}

/** 4-connected regions of a mask, as lists of pixel indices. */
function regions(mask: Uint8Array, w: number, h: number): number[][] {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const out: number[][] = [];
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || seen[s]) continue;
    const px: number[] = [];
    let top = 0;
    stack[top++] = s;
    seen[s] = 1;
    while (top) {
      const i = stack[--top];
      px.push(i);
      const x = i % w;
      const y = (i / w) | 0;
      const push = (j: number) => {
        if (mask[j] && !seen[j]) { seen[j] = 1; stack[top++] = j; }
      };
      if (x > 0) push(i - 1);
      if (x < w - 1) push(i + 1);
      if (y > 0) push(i - w);
      if (y < h - 1) push(i + w);
    }
    out.push(px);
  }
  return out;
}

/**
 * Median backdrop distance over a region's core, 2 px in from its edge, or
 * null for regions too thin to have one. The core matters: JPEG ringing along
 * outlines makes even a strip of pure backdrop look textured at its edges.
 */
function coreMedian(px: number[], dist: Float32Array, w: number, h: number): number | null {
  const inRegion = new Set(px);
  const core: number[] = [];
  for (const i of px) {
    const x = i % w;
    const y = (i / w) | 0;
    let inside = true;
    for (let dy = -2; dy <= 2 && inside; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || !inRegion.has(ny * w + nx)) {
          inside = false;
          break;
        }
      }
    }
    if (inside) core.push(dist[i]);
  }
  if (!core.length) return null;
  core.sort((a, b) => a - b);
  return core[core.length >> 1];
}

/** A uniformly darkened version of the backdrop: a shadow. */
function shadowLike(rgba: Uint8ClampedArray, B: Float32Array, i: number): boolean {
  const p = i * 4;
  const q = i * 3;
  const k0 = rgba[p] / Math.max(B[q], 1);
  const k1 = rgba[p + 1] / Math.max(B[q + 1], 1);
  const k2 = rgba[p + 2] / Math.max(B[q + 2], 1);
  const lo = Math.min(k0, k1, k2);
  const hi = Math.max(k0, k1, k2);
  return hi < 0.97 && lo > 0.2 && hi - lo < 0.15;
}

/**
 * The subject stands clear of the backdrop: the colour maths leads, and the
 * model only settles subject areas that resemble the backdrop.
 */
function separationLeads(rgba: Uint8ClampedArray, w: number, h: number, ml: Float32Array, sep: Separation, texMin: number) {
  const n = w * h;
  const alpha = Float32Array.from(sep.alpha);
  const interior = erode(Uint8Array.from(ml, (v) => (v > 0.5 ? 1 : 0)), w, h, 4);
  const cand = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (sep.alpha[i] < 0.5 && interior[i] && ml[i] > 0.85) cand[i] = 1;
  for (const px of regions(cand, w, h)) {
    // Real backdrop matches the fitted colour almost exactly at its core; a
    // subject that merely resembles it has texture and shading. Regions too
    // thin to judge are small subject details and are kept.
    const c = coreMedian(px, sep.dist, w, h);
    if (c === null || c >= texMin) for (const i of px) alpha[i] = Math.max(sep.alpha[i], ml[i]);
  }
  // Shadows read as subject to the colour maths; the model knows better.
  for (let i = 0; i < n; i++) {
    if (sep.alpha[i] >= 0.5 && ml[i] < 0.1 && shadowLike(rgba, sep.B, i)) alpha[i] = ml[i];
  }
  return alpha;
}

/**
 * The subject shares colours with the backdrop: the model leads, and the
 * colour maths only tidies up after it.
 */
function modelLeads(w: number, h: number, ml: Float32Array, sep: Separation, texMin: number) {
  const n = w * h;
  const alpha = Float32Array.from(ml);
  // Patches the model kept that are exactly the backdrop colour and connected
  // to it, like the gap between a tail and a back.
  const cand = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (ml[i] > 0.5 && sep.alpha[i] < 0.5) cand[i] = 1;
  for (const px of regions(cand, w, h)) {
    let connected = false;
    for (const i of px) if (sep.outside[i]) { connected = true; break; }
    if (!connected) continue;
    const c = coreMedian(px, sep.dist, w, h);
    if (c !== null && c < texMin) for (const i of px) alpha[i] = sep.alpha[i];
  }
  // Where subject and backdrop clearly contrast, the colour maths places the
  // edge more exactly than the model's upscaled mask.
  for (let i = 0; i < n; i++) {
    const m = ml[i];
    if (m <= 0.02 || m >= 0.98) continue;
    if (sep.src[i] < 0 || sep.contrast[i] < 2.5 * sep.tHigh) continue;
    alpha[i] = sep.alpha[i];
  }
  return alpha;
}

/**
 * Removes the backdrop's tint from soft edges by un-mixing each pixel:
 * I = a·F + (1−a)·B, so F = (I − (1−a)·B) / a. Very faint pixels lean on the
 * nearest solid subject colour, since dividing by a tiny a amplifies noise.
 */
function decontaminate(rgba: Uint8ClampedArray, w: number, h: number, alpha: Float32Array, sep: Separation) {
  const fg = new Uint8ClampedArray(rgba);
  for (let i = 0; i < w * h; i++) {
    const a = alpha[i];
    if (a <= 0.02 || a >= 0.98) continue;
    const p = i * 4;
    const q = i * 3;
    const s = sep.src[i];
    for (let c = 0; c < 3; c++) {
      let f = (rgba[p + c] - (1 - a) * sep.B[q + c]) / a;
      if (s >= 0 && a < 0.4) f = rgba[s * 4 + c] + (f - rgba[s * 4 + c]) * (a / 0.4);
      fg[p + c] = f;
    }
  }
  return fg;
}

/**
 * A hole in a cutout shows the backdrop through it. An enclosed region the
 * model left out, whose colour matches nothing seen around the outside of the
 * subject, is most likely part of the subject, like the play triangle in a
 * logo. Used when the backdrop is too busy for the colour maths.
 */
function fillForeignHoles(rgba: Uint8ClampedArray, w: number, h: number, ml: Float32Array): Float32Array {
  const n = w * h;
  const out = Float32Array.from(ml);
  const left = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (ml[i] < 0.5) left[i] = 1;
  const samples: number[] = [];
  const holes: number[][] = [];
  for (const px of regions(left, w, h)) {
    const touchesBorder = px.some((i) => {
      const x = i % w;
      const y = (i / w) | 0;
      return x === 0 || y === 0 || x === w - 1 || y === h - 1;
    });
    if (touchesBorder) {
      const step = Math.max(1, Math.floor(px.length / 1500));
      for (let k = 0; k < px.length; k += step) samples.push(px[k]);
    } else if (px.length >= 30) {
      holes.push(px);
    }
  }
  if (!samples.length) return out;
  for (const px of holes) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (const i of px) {
      r += rgba[i * 4];
      g += rgba[i * 4 + 1];
      b += rgba[i * 4 + 2];
    }
    r /= px.length;
    g /= px.length;
    b /= px.length;
    let nearest = Infinity;
    for (const i of samples) {
      const d = Math.hypot(rgba[i * 4] - r, rgba[i * 4 + 1] - g, rgba[i * 4 + 2] - b);
      if (d < nearest) nearest = d;
    }
    if (nearest > FOREIGN_HOLE) for (const i of px) out[i] = 1;
  }
  return out;
}

/**
 * Final levels curve: the models leave a faint haze, values just short of
 * fully opaque over solid areas and just above clear over the backdrop.
 * Snapping the extremes removes it while a smooth ramp keeps genuinely soft
 * edges such as hair. The gentlest curve tested on the benchmark.
 */
function cleanLevels(alpha: Float32Array): Float32Array {
  const lo = 0.03;
  const hi = 0.95;
  return alpha.map((a) => {
    const t = Math.min(1, Math.max(0, (a - lo) / (hi - lo)));
    return t * t * (3 - 2 * t);
  });
}

/** Colour distance beyond which an enclosed hole cannot be backdrop. Tuned on the benchmark. */
const FOREIGN_HOLE = 60;

/**
 * Above this share of the model's confident subject sitting close to the
 * backdrop colour, the subject and backdrop are too alike for the colour maths
 * to lead. Tuned on the benchmark in docs/MODELS.md.
 */
const MAX_OVERLAP = 0.1;

export interface Refined {
  /** Opacity 0..255 at full resolution. */
  alpha: Uint8ClampedArray;
  /** Colours with the backdrop's tint removed from soft edges, or null if unchanged. */
  fg: Uint8ClampedArray | null;
  /** Whether a plain backdrop was found and used. */
  plainBackdrop: boolean;
  /** How the decision went, for the console. */
  note: string;
}

/**
 * Combines the model's opacity (`ml`, 0..1 at full resolution) with what can
 * be measured from a plain backdrop. With a busy backdrop, returns the model's
 * answer unchanged.
 */
export function refineWithBackdrop(rgba: Uint8ClampedArray, w: number, h: number, ml: Float32Array): Refined {
  const model = fitBackground(rgba, w, h);
  if (!model.flat) {
    const note = `busy backdrop (border noise ${model.noise.toFixed(1)}, fit ${(model.inlierFrac * 100).toFixed(0)}%)`;
    const alpha = cleanLevels(fillForeignHoles(rgba, w, h, ml));
    return { alpha: Uint8ClampedArray.from(alpha, (v) => v * 255), fg: null, plainBackdrop: false, note };
  }
  const sep = separate(rgba, w, h, model);
  // Core distance below which a region counts as backdrop; tuned on the
  // labelled regions of the benchmark in docs/MODELS.md.
  const texMin = Math.max(10, 3 * model.noise + 6);
  let confident = 0;
  let near = 0;
  for (let i = 0; i < w * h; i++) {
    if (ml[i] > 0.9) {
      confident++;
      if (sep.dist[i] < sep.tHigh) near++;
    }
  }
  const overlap = confident ? near / confident : 0;
  const leads = overlap <= MAX_OVERLAP ? 'colour' : 'model';
  const alpha = cleanLevels(
    leads === 'colour' ? separationLeads(rgba, w, h, ml, sep, texMin) : modelLeads(w, h, ml, sep, texMin),
  );
  return {
    alpha: Uint8ClampedArray.from(alpha, (v) => v * 255),
    fg: decontaminate(rgba, w, h, alpha, sep),
    plainBackdrop: true,
    note: `plain backdrop, ${leads} leads (overlap ${(overlap * 100).toFixed(1)}%, noise ${model.noise.toFixed(1)})`,
  };
}
