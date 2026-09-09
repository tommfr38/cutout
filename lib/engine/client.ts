/**
 * Main-thread wrapper around the model worker. One request at a time is
 * in flight per kind; `cancel()` terminates the worker (the only reliable
 * way to abort a download or an in-progress inference) and a fresh worker
 * is spawned on the next call.
 */
// oxlint-disable-next-line import/default -- Vite's `?worker` suffix provides the default export.
import CutoutWorker from './worker.ts?worker';
import { nativeBridge } from './native';
import type {
  Device,
  ProgressInfo,
  RgbImage,
  SmartPrompt,
  WorkerRequest,
  WorkerResponse,
} from './types';

export interface MaskResult {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  ms: number;
  score?: number;
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: (p: ProgressInfo) => void;
};

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}

export class ModelClient {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  /** Whether the current worker holds an embedding for the current image. */
  embeddedKey: string | null = null;
  device: Device | null = null;
  onDevice?: (d: Device) => void;

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w: Worker = new CutoutWorker();
    w.onmessage = (ev: MessageEvent<WorkerResponse>) => this.handle(ev.data);
    w.onerror = (ev) => {
      const err = new Error(ev.message || 'The background worker crashed.');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.worker?.terminate();
      this.worker = null;
      this.embeddedKey = null;
    };
    this.worker = w;
    return w;
  }

  private handle(msg: WorkerResponse) {
    if (msg.type === 'device') {
      this.device = msg.device;
      this.onDevice?.(msg.device);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    switch (msg.type) {
      case 'progress':
        p.onProgress?.(msg.info);
        break;
      case 'auto-result':
      case 'segment-result':
      case 'embed-result':
        this.pending.delete(msg.id);
        p.resolve(msg);
        break;
      case 'error':
        this.pending.delete(msg.id);
        p.reject(new Error(msg.message));
        break;
    }
  }

  private send<T>(
    req: Exclude<WorkerRequest, { type: 'dispose' }>,
    transfer: Transferable[],
    onProgress?: (p: ProgressInfo) => void,
  ): Promise<T> {
    const w = this.ensure();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(req.id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      w.postMessage(req, transfer);
    });
  }

  get busy() {
    return this.pending.size > 0;
  }

  /**
   * In the desktop app this runs natively and the image must already be the
   * square the model expects; see `autoModelInput`.
   */
  async removeBackground(image: RgbImage, onProgress?: (p: ProgressInfo) => void) {
    const native = nativeBridge();
    if (native) {
      const res = await native.removeBackground(image.data);
      return {
        data: new Uint8ClampedArray(res.mask),
        width: res.width,
        height: res.height,
        ms: res.ms,
      } satisfies MaskResult;
    }
    const id = this.nextId++;
    return this.send<MaskResult>({ type: 'auto', id, image }, [image.data.buffer], onProgress);
  }

  /** Prepares the Smart Brush for an image; cheap no-op if already prepared. */
  async prepareSmart(key: string, image: () => RgbImage, onProgress?: (p: ProgressInfo) => void) {
    if (this.embeddedKey === key && this.worker) return;
    const id = this.nextId++;
    const img = image();
    await this.send({ type: 'embed', id, image: img }, [img.data.buffer], onProgress);
    this.embeddedKey = key;
  }

  segment(prompt: SmartPrompt) {
    const id = this.nextId++;
    return this.send<MaskResult>({ type: 'segment', id, prompt }, []);
  }

  /** Aborts everything in flight. The worker is recreated lazily. */
  cancel() {
    const err = new CancelledError();
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
    this.embeddedKey = null;
  }

  dispose() {
    this.cancel();
  }
}
