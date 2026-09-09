/**
 * Inference process. Runs in an Electron utility process, which is a plain
 * Node environment, so it can use the native ONNX Runtime build. Keeping it
 * out of the main process also means a crash here cannot take the window down.
 *
 * A fresh session is created for every image on purpose. Reusing one across
 * runs crashes Electron's Node build, and creating it costs about 40 ms
 * against roughly 750 ms of inference, so the trade is cheap.
 */
const ort = require('onnxruntime-node');

const SIDE = 1024;
let modelPath = null;

/** RGBA bytes to the NCHW float tensor the model expects, scaled to 0..1. */
function toTensor(rgba) {
  const pixels = SIDE * SIDE;
  const data = new Float32Array(3 * pixels);
  for (let i = 0, p = 0; i < pixels; i++, p += 4) {
    data[i] = rgba[p] / 255;
    data[i + pixels] = rgba[p + 1] / 255;
    data[i + 2 * pixels] = rgba[p + 2] / 255;
  }
  return new ort.Tensor('float32', data, [1, 3, SIDE, SIDE]);
}

async function removeBackground(rgba) {
  const started = Date.now();
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
  });
  try {
    const outputs = await session.run({ [session.inputNames[0]]: toTensor(rgba) });
    const alphas = outputs[session.outputNames[0]].data;
    // The model already applies the sigmoid, so these are 0..1 probabilities.
    const mask = new Uint8Array(alphas.length);
    for (let i = 0; i < alphas.length; i++) mask[i] = Math.round(alphas[i] * 255);
    return { mask, ms: Date.now() - started };
  } finally {
    await session.release?.();
  }
}

process.parentPort.on('message', async ({ data }) => {
  const { id, type, payload } = data;
  try {
    if (type === 'configure') {
      modelPath = payload.modelPath;
      process.parentPort.postMessage({ id, ok: true });
      return;
    }
    if (type === 'remove-background') {
      const { mask, ms } = await removeBackground(new Uint8Array(payload.rgba));
      process.parentPort.postMessage({ id, ok: true, mask, width: SIDE, height: SIDE, ms });
      return;
    }
    process.parentPort.postMessage({ id, ok: false, error: `Unknown request: ${type}` });
  } catch (err) {
    process.parentPort.postMessage({ id, ok: false, error: err?.message ?? String(err) });
  }
});
