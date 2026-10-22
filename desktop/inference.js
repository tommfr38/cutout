/**
 * Inference process. Runs in an Electron utility process, which is a plain
 * Node environment, so it can use the native ONNX Runtime build. Keeping it
 * out of the main process also means a crash here cannot take the window down.
 *
 * Same models as the website: isnet-general-use leads and ormbg is the backup
 * the interface asks for when isnet's answer looks off (see
 * lib/mask/quality.ts). A fresh session is created for every image on
 * purpose: reusing one across runs crashes Electron's Node build, and creating
 * it costs about 40 ms against roughly 700 ms of inference.
 */
const ort = require('onnxruntime-node');
const path = require('node:path');

const SIDE = 1024;
let modelsRoot = null;

const MODELS = {
  primary: {
    file: ['isnet-general-use', 'onnx', 'model_quantized.onnx'],
    mean: [0.5, 0.5, 0.5],
    std: [1, 1, 1],
    // isnet's output is meant to be stretched to the full 0..1 range.
    stretch: true,
  },
  backup: { file: ['ormbg-q8.onnx'], mean: [0, 0, 0], std: [1, 1, 1], stretch: false },
};

/** RGBA bytes to the normalised NCHW float tensor a model expects. */
function toTensor(rgba, spec) {
  const pixels = SIDE * SIDE;
  const data = new Float32Array(3 * pixels);
  for (let i = 0, p = 0; i < pixels; i++, p += 4) {
    for (let c = 0; c < 3; c++) data[i + c * pixels] = (rgba[p + c] / 255 - spec.mean[c]) / spec.std[c];
  }
  return new ort.Tensor('float32', data, [1, 3, SIDE, SIDE]);
}

async function removeBackground(rgba, which) {
  const spec = MODELS[which] ?? MODELS.primary;
  const started = Date.now();
  const session = await ort.InferenceSession.create(path.join(modelsRoot, ...spec.file), {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
  });
  try {
    const outputs = await session.run({ [session.inputNames[0]]: toTensor(rgba, spec) });
    const values = outputs[session.outputNames[0]].data;
    let lo = 0;
    let span = 1;
    if (spec.stretch) {
      let hi = -Infinity;
      lo = Infinity;
      for (const v of values) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      span = hi - lo || 1;
    }
    const mask = new Uint8Array(values.length);
    for (let i = 0; i < values.length; i++) {
      const v = (values[i] - lo) / span;
      mask[i] = Math.max(0, Math.min(255, Math.round(v * 255)));
    }
    return { mask, ms: Date.now() - started };
  } finally {
    await session.release?.();
  }
}

process.parentPort.on('message', async ({ data }) => {
  const { id, type, payload } = data;
  try {
    if (type === 'configure') {
      modelsRoot = payload.modelsRoot;
      process.parentPort.postMessage({ id, ok: true });
      return;
    }
    if (type === 'remove-background') {
      const { mask, ms } = await removeBackground(new Uint8Array(payload.rgba), payload.which);
      process.parentPort.postMessage({ id, ok: true, mask, width: SIDE, height: SIDE, ms });
      return;
    }
    process.parentPort.postMessage({ id, ok: false, error: `Unknown request: ${type}` });
  } catch (err) {
    process.parentPort.postMessage({ id, ok: false, error: err?.message ?? String(err) });
  }
});
