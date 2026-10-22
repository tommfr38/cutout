/**
 * Cheap checks on an automatic mask, used to decide when to ask the backup
 * model for a second opinion. Both work on the model-sized square image and
 * masks (0..255).
 */

/** Share of the frame the mask calls subject. */
export function coverage(mask: Uint8ClampedArray): number {
  let hit = 0;
  let seen = 0;
  for (let i = 0; i < mask.length; i += 7, seen++) if (mask[i] > 127) hit++;
  return seen ? hit / seen : 0;
}

/**
 * Share of the mask's outline that lies on a real edge in the image. A correct
 * cutout follows edges; a broken one cuts straight through flat colour.
 */
export function edgeScore(rgba: Uint8ClampedArray, w: number, h: number, mask: Uint8ClampedArray): number {
  let on = 0;
  let total = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mask[i] < 128) continue;
      if (mask[i - 1] >= 128 && mask[i + 1] >= 128 && mask[i - w] >= 128 && mask[i + w] >= 128) continue;
      total++;
      let g = 0;
      for (const [a, b] of [[i - 1, i + 1], [i - w, i + w], [i - w - 1, i + w + 1], [i - w + 1, i + w - 1]]) {
        const p = a * 4;
        const q = b * 4;
        g = Math.max(g, Math.abs(rgba[p] - rgba[q]) + Math.abs(rgba[p + 1] - rgba[q + 1]) + Math.abs(rgba[p + 2] - rgba[q + 2]));
      }
      if (g > 40) on++;
    }
  }
  return total ? on / total : 1;
}

/** Thresholds tuned on the benchmark in docs/MODELS.md. */
const SPARSE = 0.06;
const OFF_EDGE = 0.5;

/** Whether the primary model's answer is worth a second opinion. */
export function needsSecondOpinion(rgba: Uint8ClampedArray, w: number, h: number, mask: Uint8ClampedArray) {
  return coverage(mask) < SPARSE || edgeScore(rgba, w, h, mask) < OFF_EDGE;
}

/** Picks between the primary and backup masks: whichever follows the image's edges better. */
export function pickMask(rgba: Uint8ClampedArray, w: number, h: number, primary: Uint8ClampedArray, backup: Uint8ClampedArray) {
  const sp = edgeScore(rgba, w, h, primary);
  const sb = edgeScore(rgba, w, h, backup);
  const cp = coverage(primary);
  const useBackup = sb > sp || (cp < SPARSE && coverage(backup) > cp);
  return useBackup ? 'backup' : 'primary';
}

/** Resizes an image to the model's square, as the model saw it. */
export function toSquare(image: { data: Uint8ClampedArray; width: number; height: number }, side: number): Uint8ClampedArray {
  if (image.width === side && image.height === side) return image.data;
  const src = new OffscreenCanvas(image.width, image.height);
  src.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  const dst = new OffscreenCanvas(side, side);
  const ctx = dst.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, side, side);
  return ctx.getImageData(0, 0, side, side).data;
}
