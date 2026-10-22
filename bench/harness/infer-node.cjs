// Inference server for the benchmark. Runs under plain Node (not Electron),
// where reusing an ONNX Runtime session across runs is safe.
const ort = require(process.env.ORT_MODULE);
const sessions = new Map();

async function session(path) {
  if (!sessions.has(path)) {
    sessions.set(path, await ort.InferenceSession.create(path, { executionProviders: ['cpu'], graphOptimizationLevel: 'all' }));
  }
  return sessions.get(path);
}

process.on('message', async (msg) => {
  const { id, model, rgba, side, mean, std, post } = msg;
  try {
    const s = await session(model);
    const n = side * side;
    const data = new Float32Array(3 * n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      for (let c = 0; c < 3; c++) data[i + c * n] = (rgba[p + c] / 255 - mean[c]) / std[c];
    }
    const t0 = Date.now();
    const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, side, side]) });
    const ms = Date.now() - t0;
    const o = out[s.outputNames[0]];
    const [oh, ow] = o.dims.slice(-2);
    const v = o.data.subarray(0, oh * ow);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < v.length; i++) { if (v[i] < lo) lo = v[i]; if (v[i] > hi) hi = v[i]; }
    const mask = new Uint8Array(v.length);
    for (let i = 0; i < v.length; i++) {
      let x = v[i];
      if (post === 'sigmoid') x = 1 / (1 + Math.exp(-x));
      else if (post === 'minmax') x = (x - lo) / (hi - lo || 1);
      mask[i] = Math.max(0, Math.min(255, Math.round(x * 255)));
    }
    process.send({ id, ok: true, mask, w: ow, h: oh, ms, range: [lo, hi] });
  } catch (err) {
    process.send({ id, ok: false, error: String(err && err.message || err) });
  }
});
