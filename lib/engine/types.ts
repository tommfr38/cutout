/** Messages exchanged between the UI thread and the model worker. */

export type Device = 'webgpu' | 'wasm';

export interface RgbImage {
  /** RGBA pixels, row-major. */
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface SmartPrompt {
  /** Points inside the region of interest (image pixel coordinates). */
  positive: Point[];
  /** Points that must stay outside the selection. */
  negative: Point[];
  /** Optional bounding box [x1, y1, x2, y2] in image pixels. */
  box?: [number, number, number, number];
}

export type WorkerRequest =
  | { type: 'auto'; id: number; image: RgbImage }
  | { type: 'embed'; id: number; image: RgbImage }
  | { type: 'segment'; id: number; prompt: SmartPrompt }
  | { type: 'dispose' };

export interface ProgressInfo {
  /** Which stage the worker is in. */
  stage: 'download' | 'load' | 'run';
  /** 0..1 for download; undefined while running. */
  fraction?: number;
  /** Bytes loaded / total for download stages. */
  loaded?: number;
  total?: number;
  /** Which model is being prepared. */
  model: 'auto' | 'smart';
}

export type WorkerResponse =
  | { type: 'progress'; id: number; info: ProgressInfo }
  | { type: 'device'; device: Device }
  | {
      type: 'auto-result';
      id: number;
      /** Soft alpha (0..255), size = width*height of the input image. */
      data: Uint8ClampedArray;
      width: number;
      height: number;
      ms: number;
    }
  | { type: 'embed-result'; id: number; width: number; height: number; ms: number }
  | {
      type: 'segment-result';
      id: number;
      /** Binary mask (0 or 255), size of the embedded image. */
      data: Uint8ClampedArray;
      width: number;
      height: number;
      score: number;
      ms: number;
    }
  | { type: 'error'; id: number; message: string; recoverable: boolean };
