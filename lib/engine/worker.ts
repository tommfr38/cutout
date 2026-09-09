/**
 * Model worker: runs automatic background removal and prompt-based
 * segmentation off the main thread. All model weights are fetched from the
 * Hugging Face Hub on first use and cached by the browser (Cache API).
 */
import './worker-shim';
import {
  AutoModel,
  AutoProcessor,
  RawImage,
  SamModel,
  Tensor,
  env,
} from '@huggingface/transformers';
import type {
  Device,
  ProgressInfo,
  RgbImage,
  SmartPrompt,
  WorkerRequest,
  WorkerResponse,
} from './types';

// Undo the dev-only shim now that dependencies have evaluated (see worker-shim.ts).
if ((globalThis as unknown as { __cutoutWindowShim?: boolean }).__cutoutWindowShim) {
  delete (globalThis as unknown as { window?: unknown }).window;
}

/**
 * Automatic removal uses ormbg (IS-Net, Apache-2.0). BiRefNet_lite's ONNX
 * export was evaluated first but crashes ONNX Runtime WASM with std::bad_alloc
 * (its deform_conv2d emulation allocates hundreds of MB per node) and the
 * WebGPU re-export produced NaN output on the test GPU. See docs/MODELS.md.
 */
export const AUTO_MODEL_ID = 'onnx-community/ormbg-ONNX';
/** 'fp32' (176 MB) or 'q8' (44 MB); both run at the same speed on WASM. */
export const AUTO_DTYPE: 'fp32' | 'q8' | 'fp16' = 'q8';
export const SMART_MODEL_ID = 'Xenova/slimsam-77-uniform';

/**
 * The desktop app serves its own copies of the model files, so it never
 * reaches the network. On the web they come from the Hugging Face Hub and the
 * browser caches them for later visits.
 */
const isDesktop = self.location.protocol === 'cutout:';
if (isDesktop) {
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = `${self.location.origin}/models/`;
} else {
  env.allowLocalModels = false;
}
env.useBrowserCache = true;
// Serve the ONNX Runtime WASM binaries ourselves (copied from onnxruntime-web
// into public/ort by `npm run prepare-ort`) so versions always match and no CDN is needed.
/**
 * Where the ONNX Runtime binaries live. The worker script is served from
 * `<base>/_next/static/`, so trimming that suffix gives the site's base URL.
 * Deriving it this way keeps the app working both at a domain root and under
 * a subpath, such as a GitHub Pages project site.
 */
function ortPath(): string {
  const here = self.location.href;
  const marker = here.lastIndexOf('/_next/');
  const base = marker === -1 ? new URL('.', here).href : here.slice(0, marker + 1);
  return new URL('ort/', base).href;
}

const ORT_PATH = ortPath();
env.backends.onnx.wasm!.wasmPaths = ORT_PATH;

/**
 * ONNX Runtime's multi-threaded build starts its thread pool by creating
 * module workers. Chrome cannot create a module worker from inside a worker,
 * so there the pool never comes up and inference would hang forever. Detect
 * that once and fall back to a single thread, which is slower but always
 * finishes. Browsers that do support nested module workers keep the threads.
 */
let threadsReady: Promise<number> | null = null;
function configureThreads(): Promise<number> {
  threadsReady ??= new Promise<number>((resolve) => {
    if (!self.crossOriginIsolated) return resolve(1);
    let probe: Worker;
    try {
      probe = new Worker(new URL('nested-worker-probe.mjs', ORT_PATH), { type: 'module' });
    } catch {
      return resolve(1);
    }
    const finish = (threads: number) => {
      clearTimeout(timer);
      probe.terminate();
      resolve(threads);
    };
    const timer = setTimeout(() => finish(1), 2000);
    probe.onmessage = () =>
      finish(Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1)));
    probe.onerror = () => finish(1);
  }).then((threads) => {
    env.backends.onnx.wasm!.numThreads = threads;
    console.info(`[cutout] inference threads: ${threads}`);
    return threads;
  });
  return threadsReady;
}

const post = (msg: WorkerResponse, transfer: Transferable[] = []) =>
  (globalThis as unknown as Worker).postMessage(msg, transfer);

type ProgressEvent = {
  status: string;
  file?: string;
  loaded?: number;
  total?: number;
  progress?: number;
};

/** Aggregates per-file download progress into one fraction. */
function progressReporter(id: number, model: ProgressInfo['model']) {
  const files = new Map<string, { loaded: number; total: number }>();
  let lastSent = 0;
  return (e: ProgressEvent) => {
    if (e.status === 'progress' && e.file && e.total) {
      files.set(e.file, { loaded: e.loaded ?? 0, total: e.total });
    } else if (e.status === 'done' && e.file) {
      const f = files.get(e.file);
      if (f) f.loaded = f.total;
    } else if (e.status === 'ready') {
      post({ type: 'progress', id, info: { stage: 'load', model } });
      return;
    }
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    const now = performance.now();
    if (now - lastSent < 80 && e.status !== 'done') return;
    lastSent = now;
    post({
      type: 'progress',
      id,
      info: {
        stage: 'download',
        model,
        loaded,
        total,
        fraction: total ? loaded / total : 0,
      },
    });
  };
}

/**
 * WebGPU is disabled for now: on the tested browser the SlimSAM decoder was
 * slower on WebGPU than on multi-threaded WASM, and the auto model's export
 * is rejected by the WebGPU backend. Flip this to re-enable adapter detection.
 */
const PREFER_WEBGPU = false;

let devicePromise: Promise<Device> | null = null;
/** Set after a WebGPU failure so every later load goes straight to WASM. */
let forceWasm = false;
async function detectDevice(): Promise<Device> {
  if (forceWasm || !PREFER_WEBGPU) return 'wasm';
  devicePromise ??= (async () => {
    try {
      const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
      if (gpu && (await gpu.requestAdapter())) return 'webgpu';
    } catch {
      /* fall through */
    }
    return 'wasm';
  })();
  return devicePromise;
}

function toRawImage(img: RgbImage): RawImage {
  return new RawImage(img.data, img.width, img.height, 4);
}

// ---------------------------------------------------------------------------
// Automatic background removal
// ---------------------------------------------------------------------------

type AutoBundle = {
  model: Awaited<ReturnType<typeof AutoModel.from_pretrained>>;
  processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>;
  device: Device;
};
let autoBundle: Promise<AutoBundle> | null = null;

async function loadAuto(id: number): Promise<AutoBundle> {
  if (autoBundle) return autoBundle;
  autoBundle = (async () => {
    await configureThreads();
    // ormbg uses MaxPool with ceil_mode, which ONNX Runtime's WebGPU backend
    // rejects, so this model always runs on (multi-threaded) WASM.
    const preferred = 'wasm' as Device;
    const report = progressReporter(id, 'auto');
    const attempt = async (device: Device): Promise<AutoBundle> => {
      const [model, processor] = await Promise.all([
        AutoModel.from_pretrained(AUTO_MODEL_ID, {
          device,
          dtype: AUTO_DTYPE,
          progress_callback: report,
        }),
        AutoProcessor.from_pretrained(AUTO_MODEL_ID, {}),
      ]);
      return { model, processor, device };
    };
    try {
      return await attempt(preferred);
    } catch (err) {
      if (preferred === 'webgpu') {
        console.warn('[cutout] WebGPU load failed, falling back to WASM', err);
        return attempt('wasm');
      }
      throw err;
    }
  })();
  autoBundle.catch(() => {
    autoBundle = null;
  });
  return autoBundle;
}

/**
 * Runs `fn` and, if it fails on WebGPU, drops the GPU session and retries
 * once on WASM. Some browsers accept the GPU model at load time but fail
 * when a kernel is compiled during the first run.
 */
async function withFallback<T>(device: Device, reset: () => void, fn: () => Promise<T>, retry: () => Promise<T>) {
  try {
    return await fn();
  } catch (err) {
    if (device === 'webgpu' && !forceWasm) {
      console.warn('[cutout] WebGPU inference failed, retrying on WASM', err);
      forceWasm = true;
      reset();
      return retry();
    }
    throw err;
  }
}

async function runAuto(id: number, image: RgbImage): Promise<void> {
  const { model, processor, device } = await loadAuto(id);
  post({ type: 'device', device });
  return withFallback(
    device,
    () => {
      autoBundle = null;
      void model.dispose();
    },
    () => runAutoWith(id, image, model, processor),
    () => runAuto(id, image),
  );
}

async function runAutoWith(
  id: number,
  image: RgbImage,
  model: AutoBundle['model'],
  processor: AutoBundle['processor'],
) {
  post({ type: 'progress', id, info: { stage: 'run', model: 'auto' } });
  const t0 = performance.now();
  const raw = toRawImage(image);
  const { pixel_values } = await processor(raw);
  const outputs = (await model({ pixel_values })) as Record<string, Tensor>;
  const output = outputs[Object.keys(outputs)[0]]; // [1, 1, H, W]
  const [, , h, w] = output.dims;
  const data = output.data as Float32Array;
  // Some exports apply the sigmoid inside the graph, others return logits.
  let logits = false;
  for (let i = 0; i < data.length; i++) {
    if (data[i] < -1e-5 || data[i] > 1 + 1e-5) {
      logits = true;
      break;
    }
  }
  const mask = new Uint8ClampedArray(h * w);
  for (let i = 0; i < mask.length; i++) {
    const v = logits ? 1 / (1 + Math.exp(-data[i])) : data[i];
    mask[i] = v * 255;
  }
  pixel_values.dispose();
  output.dispose();
  const ms = performance.now() - t0;
  console.info(`[cutout] background removed in ${Math.round(ms)} ms`);
  post({ type: 'auto-result', id, data: mask, width: w, height: h, ms }, [mask.buffer]);
}

// ---------------------------------------------------------------------------
// Smart brush (prompted segmentation)
// ---------------------------------------------------------------------------

type SmartBundle = {
  model: SamModel;
  processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>;
  device: Device;
};
let smartBundle: Promise<SmartBundle> | null = null;

async function loadSmart(id: number): Promise<SmartBundle> {
  if (smartBundle) return smartBundle;
  smartBundle = (async () => {
    await configureThreads();
    const preferred = await detectDevice();
    const report = progressReporter(id, 'smart');
    const attempt = async (device: Device): Promise<SmartBundle> => {
      const [model, processor] = await Promise.all([
        SamModel.from_pretrained(SMART_MODEL_ID, {
          device,
          dtype: 'fp32',
          progress_callback: report,
        }),
        AutoProcessor.from_pretrained(SMART_MODEL_ID, {}),
      ]);
      return { model: model as SamModel, processor, device };
    };
    try {
      return await attempt(preferred);
    } catch (err) {
      if (preferred === 'webgpu') {
        console.warn('[cutout] WebGPU load failed, falling back to WASM', err);
        return attempt('wasm');
      }
      throw err;
    }
  })();
  smartBundle.catch(() => {
    smartBundle = null;
  });
  return smartBundle;
}

interface Embedding {
  image_embeddings: Tensor;
  image_positional_embeddings: Tensor;
  original_sizes: [number, number][];
  reshaped_input_sizes: [number, number][];
  width: number;
  height: number;
}
let embedding: Embedding | null = null;

async function runEmbed(id: number, image: RgbImage): Promise<void> {
  const { model, processor, device } = await loadSmart(id);
  post({ type: 'device', device });
  return withFallback(
    device,
    () => {
      smartBundle = null;
      void model.dispose();
    },
    () => runEmbedWith(id, image, model, processor),
    () => runEmbed(id, image),
  );
}

async function runEmbedWith(
  id: number,
  image: RgbImage,
  model: SmartBundle['model'],
  processor: SmartBundle['processor'],
) {
  post({ type: 'progress', id, info: { stage: 'run', model: 'smart' } });
  const t0 = performance.now();
  if (embedding) {
    embedding.image_embeddings.dispose();
    embedding.image_positional_embeddings.dispose();
    embedding = null;
  }
  const raw = toRawImage(image);
  const inputs = await processor(raw);
  const emb = await model.get_image_embeddings({ pixel_values: inputs.pixel_values });
  inputs.pixel_values.dispose();
  embedding = {
    ...emb,
    original_sizes: inputs.original_sizes,
    reshaped_input_sizes: inputs.reshaped_input_sizes,
    width: image.width,
    height: image.height,
  };
  post({
    type: 'embed-result',
    id,
    width: image.width,
    height: image.height,
    ms: performance.now() - t0,
  });
}

async function runSegment(id: number, prompt: SmartPrompt) {
  if (!embedding) throw new Error('No image is prepared for the Smart Brush yet.');
  const { model, processor } = await loadSmart(id);
  const t0 = performance.now();
  const ip = (processor as unknown as { image_processor: SamImageProcessorLike }).image_processor;
  const { original_sizes, reshaped_input_sizes } = embedding;

  const pts = [...prompt.positive, ...prompt.negative].map((p) => [p.x, p.y]);
  const labels = [
    ...prompt.positive.map(() => 1),
    ...prompt.negative.map(() => 0),
  ];
  const inputs: Record<string, Tensor> = {
    image_embeddings: embedding.image_embeddings,
    image_positional_embeddings: embedding.image_positional_embeddings,
  };
  if (pts.length) {
    const input_points = ip.reshape_input_points([[...pts]], original_sizes, reshaped_input_sizes);
    inputs.input_points = input_points;
    inputs.input_labels = ip.add_input_labels([labels], input_points);
  }
  if (prompt.box) {
    inputs.input_boxes = ip.reshape_input_points(
      [[prompt.box]],
      original_sizes,
      reshaped_input_sizes,
      true,
    );
  }
  const outputs = (await model(inputs)) as { pred_masks: Tensor; iou_scores: Tensor };
  const masks = await ip.post_process_masks(
    outputs.pred_masks,
    original_sizes,
    reshaped_input_sizes,
  );
  const m = masks[0]; // [1, 3, H, W] bool
  const [, n, h, w] = m.dims;
  const scores = Array.from(outputs.iou_scores.data as Float32Array);
  const data = m.data as Uint8Array;
  const plane = h * w;

  // Pick the candidate that scores best while covering the positive points
  // and not swallowing the whole image.
  let best = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < n; i++) {
    const off = i * plane;
    let hits = 0;
    for (const p of prompt.positive) {
      const x = Math.min(w - 1, Math.max(0, Math.round(p.x)));
      const y = Math.min(h - 1, Math.max(0, Math.round(p.y)));
      if (data[off + y * w + x]) hits++;
    }
    let area = 0;
    for (let j = 0; j < plane; j++) area += data[off + j];
    const coverage = prompt.positive.length ? hits / prompt.positive.length : 1;
    const areaFrac = area / plane;
    const score = scores[i] + coverage - (areaFrac > 0.9 ? 1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  const mask = new Uint8ClampedArray(plane);
  const off = best * plane;
  for (let j = 0; j < plane; j++) mask[j] = data[off + j] ? 255 : 0;

  outputs.pred_masks.dispose();
  outputs.iou_scores.dispose();
  inputs.input_points?.dispose();
  inputs.input_labels?.dispose();
  inputs.input_boxes?.dispose();

  post(
    {
      type: 'segment-result',
      id,
      data: mask,
      width: w,
      height: h,
      score: scores[best] ?? 0,
      ms: performance.now() - t0,
    },
    [mask.buffer],
  );
}

interface SamImageProcessorLike {
  reshape_input_points(
    points: number[][][],
    original_sizes: [number, number][],
    reshaped_input_sizes: [number, number][],
    is_bounding_box?: boolean,
  ): Tensor;
  add_input_labels(labels: number[][], points: Tensor): Tensor;
  post_process_masks(
    masks: Tensor,
    original_sizes: [number, number][],
    reshaped_input_sizes: [number, number][],
  ): Promise<Tensor[]>;
}

// ---------------------------------------------------------------------------
// Message loop (requests are processed one at a time, in order)
// ---------------------------------------------------------------------------

let queue: Promise<void> = Promise.resolve();

function describe(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/fetch|network|Failed to load|404|429|5\d\d/i.test(msg)) {
    return `Could not download the model (${msg}). Check your connection and try again.`;
  }
  if (/memory|allocation|OOM/i.test(msg)) {
    return 'The browser ran out of memory while processing. Try a smaller image or close other tabs.';
  }
  return msg;
}

(globalThis as unknown as Worker).onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  if (req.type === 'dispose') {
    embedding?.image_embeddings.dispose();
    embedding?.image_positional_embeddings.dispose();
    embedding = null;
    return;
  }
  queue = queue.then(async () => {
    try {
      if (req.type === 'auto') await runAuto(req.id, req.image);
      else if (req.type === 'embed') await runEmbed(req.id, req.image);
      else if (req.type === 'segment') await runSegment(req.id, req.prompt);
    } catch (err) {
      console.error('[cutout worker]', err);
      post({ type: 'error', id: req.id, message: describe(err), recoverable: true });
    }
  });
};
