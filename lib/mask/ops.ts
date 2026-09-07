/**
 * Alpha-mask primitives. A mask is a Uint8ClampedArray of width*height
 * values (0 = transparent, 255 = opaque). Every function returns the
 * dirty rectangle it touched so callers can composite incrementally.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Mask {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export const emptyRect = (): Rect => ({ x: 0, y: 0, w: 0, h: 0 });

export function unionRect(a: Rect, b: Rect): Rect {
  if (a.w === 0 || a.h === 0) return { ...b };
  if (b.w === 0 || b.h === 0) return { ...a };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const r = Math.max(a.x + a.w, b.x + b.w);
  const btm = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: r - x, h: btm - y };
}

export function clampRect(r: Rect, width: number, height: number): Rect {
  const x = Math.max(0, Math.floor(r.x));
  const y = Math.max(0, Math.floor(r.y));
  const r2 = Math.min(width, Math.ceil(r.x + r.w));
  const b2 = Math.min(height, Math.ceil(r.y + r.h));
  return { x, y, w: Math.max(0, r2 - x), h: Math.max(0, b2 - y) };
}

/** Copies a rectangular region out of a mask. */
export function extract(mask: Mask, r: Rect): Uint8ClampedArray {
  const out = new Uint8ClampedArray(r.w * r.h);
  for (let row = 0; row < r.h; row++) {
    const src = (r.y + row) * mask.width + r.x;
    out.set(mask.data.subarray(src, src + r.w), row * r.w);
  }
  return out;
}

/** Writes a rectangular patch back into a mask. */
export function patch(mask: Mask, r: Rect, data: Uint8ClampedArray) {
  for (let row = 0; row < r.h; row++) {
    const dst = (r.y + row) * mask.width + r.x;
    mask.data.set(data.subarray(row * r.w, (row + 1) * r.w), dst);
  }
}

/**
 * Stamps a soft round brush along the segment from (x0,y0) to (x1,y1).
 * `value` is the target alpha (0 = erase, 255 = restore); `hardness`
 * 0..1 controls the edge falloff.
 */
export function strokeSegment(
  mask: Mask,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
  value: 0 | 255,
  hardness = 0.75,
): Rect {
  const { width, height, data } = mask;
  const r = Math.max(0.5, radius);
  const dirty = clampRect(
    {
      x: Math.min(x0, x1) - r - 1,
      y: Math.min(y0, y1) - r - 1,
      w: Math.abs(x1 - x0) + 2 * r + 2,
      h: Math.abs(y1 - y0) + 2 * r + 2,
    },
    width,
    height,
  );
  if (dirty.w === 0 || dirty.h === 0) return dirty;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const inner = r * hardness;
  const falloff = Math.max(0.001, r - inner);
  for (let py = dirty.y; py < dirty.y + dirty.h; py++) {
    for (let px = dirty.x; px < dirty.x + dirty.w; px++) {
      // distance from pixel centre to the segment
      const cx = px + 0.5;
      const cy = py + 0.5;
      let t = len2 > 0 ? ((cx - x0) * dx + (cy - y0) * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = x0 + t * dx - cx;
      const ey = y0 + t * dy - cy;
      const d = Math.sqrt(ex * ex + ey * ey);
      if (d >= r) continue;
      const cover = d <= inner ? 1 : 1 - (d - inner) / falloff;
      const i = py * width + px;
      const cur = data[i];
      data[i] = cur + (value - cur) * cover;
    }
  }
  return dirty;
}

/** Fills the interior of a closed polygon (image coordinates) with `value`. */
export function fillPolygon(mask: Mask, poly: { x: number; y: number }[], value: 0 | 255): Rect {
  if (poly.length < 3) return emptyRect();
  const { width, height, data } = mask;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const dirty = clampRect({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }, width, height);
  if (dirty.w === 0 || dirty.h === 0) return dirty;
  const n = poly.length;
  const xs: number[] = [];
  for (let py = dirty.y; py < dirty.y + dirty.h; py++) {
    const sy = py + 0.5;
    xs.length = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const a = poly[i];
      const b = poly[j];
      if (a.y < sy !== b.y < sy) {
        xs.push(a.x + ((sy - a.y) * (b.x - a.x)) / (b.y - a.y));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(dirty.x, Math.round(xs[k]));
      const xb = Math.min(dirty.x + dirty.w, Math.round(xs[k + 1]));
      if (xb > xa) data.fill(value, py * width + xa, py * width + xb);
    }
  }
  return dirty;
}

/**
 * Applies a model-produced mask (any size) to the working mask by scaling it
 * to full resolution with bilinear filtering. `mode` decides how it combines:
 *  - 'replace': alpha = model * originalAlpha
 *  - 'erase':   alpha = alpha * (1 - model)
 *  - 'restore': alpha = max(alpha, model * originalAlpha)
 */
export function applyScaledMask(
  mask: Mask,
  originalAlpha: Uint8ClampedArray | null,
  src: { data: Uint8ClampedArray; width: number; height: number },
  mode: 'replace' | 'erase' | 'restore',
  region?: Rect,
): Rect {
  const scaled = scaleMask(src, mask.width, mask.height);
  const r = region ? clampRect(region, mask.width, mask.height) : { x: 0, y: 0, w: mask.width, h: mask.height };
  const { data, width } = mask;
  for (let py = r.y; py < r.y + r.h; py++) {
    for (let px = r.x; px < r.x + r.w; px++) {
      const i = py * width + px;
      const m = scaled[i] / 255;
      const orig = originalAlpha ? originalAlpha[i] : 255;
      if (mode === 'replace') data[i] = orig * m;
      else if (mode === 'erase') data[i] = data[i] * (1 - m);
      else data[i] = Math.max(data[i], orig * m);
    }
  }
  return r;
}

/** Bilinear resize of a single-channel mask via the 2D canvas (fast, GPU-backed). */
export function scaleMask(
  src: { data: Uint8ClampedArray; width: number; height: number },
  width: number,
  height: number,
): Uint8ClampedArray {
  if (src.width === width && src.height === height) return src.data;
  const rgba = new Uint8ClampedArray(src.width * src.height * 4);
  for (let i = 0, j = 0; i < src.data.length; i++, j += 4) {
    rgba[j] = rgba[j + 1] = rgba[j + 2] = 255;
    rgba[j + 3] = src.data[i];
  }
  const small = new OffscreenCanvas(src.width, src.height);
  small.getContext('2d')!.putImageData(new ImageData(rgba, src.width, src.height), 0, 0);
  const big = new OffscreenCanvas(width, height);
  const ctx = big.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(small, 0, 0, width, height);
  const out = ctx.getImageData(0, 0, width, height).data;
  const mask = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 3; i < mask.length; i++, j += 4) mask[i] = out[j];
  return mask;
}

/** Bounding box of non-zero pixels, or null if empty. */
export function boundsOf(src: { data: Uint8ClampedArray; width: number; height: number }): Rect | null {
  let minX = src.width,
    minY = src.height,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < src.height; y++) {
    const row = y * src.width;
    for (let x = 0; x < src.width; x++) {
      if (src.data[row + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
