import { isDesktopApp } from '@/lib/engine/native';
import type { RgbImage } from '@/lib/engine/types';
import type { Mask } from '@/lib/mask/ops';

/** Largest number of pixels we keep at full resolution. */
export const MAX_PIXELS_DESKTOP = 24_000_000;
export const MAX_PIXELS_MOBILE = 12_000_000;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Longest side of the image handed to the models. */
export const MODEL_SIDE = 1024;

export interface LoadedImage {
  width: number;
  height: number;
  rgba: ImageData;
  /** Original alpha if the source had transparency, else null. */
  originalAlpha: Uint8ClampedArray | null;
  /** True when the image had to be reduced to fit memory limits. */
  reduced: boolean;
  sourceWidth: number;
  sourceHeight: number;
}

export async function loadImageFile(file: File, maxPixels: number): Promise<LoadedImage> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error('That file is larger than 25 MB. Please choose a smaller image.');
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error("This file couldn't be opened as an image. Try a JPG, PNG or WebP.");
  }
  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;
  let width = sourceWidth;
  let height = sourceHeight;
  const pixels = width * height;
  let reduced = false;
  if (pixels > maxPixels) {
    const s = Math.sqrt(maxPixels / pixels);
    width = Math.max(1, Math.floor(width * s));
    height = Math.max(1, Math.floor(height * s));
    reduced = true;
  }
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const rgba = ctx.getImageData(0, 0, width, height);
  // Detect transparency in the source.
  let hasAlpha = false;
  const d = rgba.data;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] !== 255) {
      hasAlpha = true;
      break;
    }
  }
  let originalAlpha: Uint8ClampedArray | null = null;
  if (hasAlpha) {
    originalAlpha = new Uint8ClampedArray(width * height);
    for (let i = 0, j = 3; i < originalAlpha.length; i++, j += 4) originalAlpha[i] = d[j];
  }
  return { width, height, rgba, originalAlpha, reduced, sourceWidth, sourceHeight };
}

/**
 * Downscaled, opaque copy of the image for the models. Transparent pixels
 * are flattened onto white so they don't leak garbage colour into the model.
 */
export function modelImage(rgba: ImageData): RgbImage {
  const scale = Math.min(1, MODEL_SIDE / Math.max(rgba.width, rgba.height));
  const w = Math.max(1, Math.round(rgba.width * scale));
  const h = Math.max(1, Math.round(rgba.height * scale));
  const src = new OffscreenCanvas(rgba.width, rgba.height);
  src.getContext('2d')!.putImageData(rgba, 0, 0);
  const dst = new OffscreenCanvas(w, h);
  const ctx = dst.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  const out = ctx.getImageData(0, 0, w, h);
  return { data: out.data, width: w, height: h };
}

/**
 * The automatic model takes a fixed square, so the image is stretched to fit
 * and the resulting mask is stretched back when it is applied.
 */
export function squareModelImage(rgba: ImageData, side = MODEL_SIDE): RgbImage {
  const src = new OffscreenCanvas(rgba.width, rgba.height);
  src.getContext('2d')!.putImageData(rgba, 0, 0);
  const dst = new OffscreenCanvas(side, side);
  const ctx = dst.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, side, side);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, side, side);
  const out = ctx.getImageData(0, 0, side, side);
  return { data: out.data, width: side, height: side };
}

/**
 * Input for automatic removal. The native engine takes the square directly;
 * the WebAssembly one is handed the aspect-correct image and squares it itself
 * as part of preprocessing.
 */
export function autoModelInput(rgba: ImageData): RgbImage {
  return isDesktopApp() ? squareModelImage(rgba) : modelImage(rgba);
}

export type Background =
  | { type: 'transparent' }
  | { type: 'color'; color: string }
  | { type: 'image'; bitmap: ImageBitmap; name: string };

/** Draws `bg` to cover the rectangle (0,0,w,h) on `ctx`. */
export function paintBackground(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  bg: Background,
  w: number,
  h: number,
) {
  if (bg.type === 'color') {
    ctx.fillStyle = bg.color;
    ctx.fillRect(0, 0, w, h);
  } else if (bg.type === 'image') {
    const s = Math.max(w / bg.bitmap.width, h / bg.bitmap.height);
    const bw = bg.bitmap.width * s;
    const bh = bg.bitmap.height * s;
    ctx.drawImage(bg.bitmap, (w - bw) / 2, (h - bh) / 2, bw, bh);
  }
}

export type ExportFormat = 'png' | 'webp' | 'jpeg';

export async function exportImage(
  rgba: ImageData,
  mask: Mask,
  bg: Background,
  format: ExportFormat,
): Promise<Blob> {
  const { width, height } = rgba;
  const out = new OffscreenCanvas(width, height);
  const ctx = out.getContext('2d')!;
  if (format === 'jpeg' && bg.type === 'transparent') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
  } else {
    paintBackground(ctx, bg, width, height);
  }
  const data = new Uint8ClampedArray(rgba.data);
  for (let i = 0, j = 3; i < mask.data.length; i++, j += 4) data[j] = mask.data[i];
  const layer = new OffscreenCanvas(width, height);
  layer.getContext('2d')!.putImageData(new ImageData(data, width, height), 0, 0);
  ctx.drawImage(layer, 0, 0);
  const type = format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg';
  return out.convertToBlob({ type, quality: format === 'png' ? undefined : 0.92 });
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function baseName(name: string) {
  return name.replace(/\.[^.]+$/, '') || 'image';
}
