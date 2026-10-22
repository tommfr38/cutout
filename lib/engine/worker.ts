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
import { scaleMask } from '@/lib/mask/ops';
import { needsSecondOpinion, pickMask, toSquare } from '@/lib/mask/quality';
import { refineWithBackdrop } from '@/lib/mask/separate';
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
 * Automatic removal. isnet-general-use (the DIS authors' general-purpose
 * IS-Net, Apache-2.0) leads; it handles objects, animals and illustrations far
 * better than the people-focused ormbg. ormbg stays as a backup for the rare
 * image where isnet finds almost nothing, such as a logo that fills the frame.
 * The site serves its own 8-bit copy of isnet; see docs/MODELS.md.
 */
const AUTO_MODELS = {
  primary: { id: 'isnet-general-use', normalize: true },
  backup: { id: 'onnx-community/ormbg-ONNX', normalize: false },
} as const;
export const SMART_MODEL_ID = 'Xenova/slimsam-77-uniform';

/**
 * The site's base URL. Built, the worker is served from `<base>/_next/static/`;
 * the dev server serves it from its source path instead, at the site root.
 */
function siteBase(): string {
  const here = self.location.href;
  const marker = here.lastIndexOf('/_next/');
  return marker === -1 ? `${self.location.origin}/` : here.slice(0, marker + 1);
}

/**
 * Models the app ships itself (the automatic remover on the web; everything
 * in the desktop app) are served from `<base>/models/`. Anything else comes
 * from the Hugging Face Hub, except in the desktop app, which never goes
 * online. Downloads are cached by the browser for later visits.
 */
const isDesktop = self.location.protocol === 'cutout:';
env.allowLocalModels = true;
env.localModelPath = new URL('models/', siteBase()).href;
env.allowRemoteModels = !isDesktop;
env.useBrowserCache = true;
// Serve the ONNX Runtime WASM binaries ourselves (copied from onnxruntime-web
// into public/ort by `npm run prepare-ort`) so versions always match and no CDN is needed.
/**
 * ONNX Runtime binaries, served from the site itself. Deriving the path from
 * the worker's own URL keeps it working at a domain root and under a subpath,
 * such as a GitHub Pages project site.
 */
const ORT_PATH = new URL('ort/', siteBase()).href;
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
};
type AutoKind = keyof typeof AUTO_MODELS;
const autoBundles = new Map<AutoKind, Promise<AutoBundle>>();

function loadAuto(id: number, kind: AutoKind): Promise<AutoBundle> {
  const cached = autoBundles.get(kind);
  if (cached) return cached;
  const bundle = (async () => {
    await configureThreads();
    const modelId = AUTO_MODELS[kind].id;
    const [model, processor] = await Promise.all([
      AutoModel.from_pretrained(modelId, {
        device: 'wasm',
        dtype: 'q8',
        progress_callback: progressReporter(id, 'auto'),
      }),
      AutoProcessor.from_pretrained(modelId, {}),
    ]);
    return { model, processor };
  })();
  bundle.catch(() => autoBundles.delete(kind));
  autoBundles.set(kind, bundle);
  return bundle;
}

/** Runs one automatic model and returns its opacity, 0..255, at model size. */
async function predict(id: number, kind: AutoKind, image: RgbImage) {
  const { model, processor } = await loadAuto(id, kind);
  post({ type: 'device', device: 'wasm' });
  post({ type: 'progress', id, info: { stage: 'run', model: 'auto' } });
  const { pixel_values } = await processor(toRawImage(image));
  // Exports differ in what they call their one input (`pixel_values`,
  // `input_image`), so use whatever this model declares.
  const session = (model as unknown as { sessions?: Record<string, { inputNames?: string[] }> }).sessions?.model;
  const inputName = session?.inputNames?.[0] ?? 'pixel_values';
  const outputs = (await model({ [inputName]: pixel_values })) as Record<string, Tensor>;
  const output = outputs[Object.keys(outputs)[0]]; // [1, 1, H, W]
  const [, , h, w] = output.dims;
  const data = output.data as Float32Array;
  // Some exports end in a sigmoid, others return logits.
  let logits = false;
  for (let i = 0; i < data.length; i++) {
    if (data[i] < -1e-5 || data[i] > 1 + 1e-5) {
      logits = true;
      break;
    }
  }
  const values = logits ? Float32Array.from(data, (v) => 1 / (1 + Math.exp(-v))) : Float32Array.from(data);
  // isnet's output is meant to be stretched to the full 0..1 range.
  if (AUTO_MODELS[kind].normalize) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of values) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const span = hi - lo || 1;
    for (let i = 0; i < values.length; i++) values[i] = (values[i] - lo) / span;
  }
  const mask = Uint8ClampedArray.from(values, (v) => v * 255);
  pixel_values.dispose();
  output.dispose();
  return { mask, width: w, height: h };
}

async function runAuto(id: number, image: RgbImage): Promise<void> {
  const t0 = performance.now();
  let result = await predict(id, 'primary', image);
  // A second opinion when the answer looks off: almost nothing found, or an
  // outline that cuts through flat colour instead of following edges.
  const square = toSquare(image, result.width);
  let used = 'primary';
  if (needsSecondOpinion(square, result.width, result.height, result.mask)) {
    const backup = await predict(id, 'backup', image);
    if (pickMask(square, result.width, result.height, result.mask, backup.mask) === 'backup') {
      result = backup;
      used = 'backup';
    }
  }
  const ms = performance.now() - t0;
  console.info(`[cutout] background removed in ${Math.round(ms)} ms (${used} model)`);
  post(
    { type: 'auto-result', id, data: result.mask, width: result.width, height: result.height, ms },
    [result.mask.buffer],
  );
}

// ---------------------------------------------------------------------------
// Refinement against a plain backdrop
// ---------------------------------------------------------------------------

function runRefine(
  id: number,
  image: RgbImage,
  mask: { data: Uint8ClampedArray; width: number; height: number },
) {
  const t0 = performance.now();
  const { width, height, data } = image;
  const scaled = scaleMask(mask, width, height);
  const ml = Float32Array.from(scaled, (v) => v / 255);
  const refined = refineWithBackdrop(data, width, height, ml);
  const ms = performance.now() - t0;
  console.info(`[cutout] edges refined in ${Math.round(ms)} ms: ${refined.note}`);
  const transfer: Transferable[] = [refined.alpha.buffer];
  if (refined.fg) transfer.push(refined.fg.buffer);
  post(
    {
      type: 'refine-result',
      id,
      alpha: refined.alpha,
      fg: refined.fg,
      plainBackdrop: refined.plainBackdrop,
      ms,
    },
    transfer,
  );
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
      else if (req.type === 'refine') runRefine(req.id, req.image, req.mask);
    } catch (err) {
      console.error('[cutout worker]', err);
      post({ type: 'error', id: req.id, message: describe(err), recoverable: true });
    }
  });
};
