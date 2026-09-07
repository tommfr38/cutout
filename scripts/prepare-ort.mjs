// Copies the ONNX Runtime WASM binaries that match the installed
// onnxruntime-web into public/ort so the app can serve them itself.
import { copyFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = join(process.cwd(), 'node_modules', 'onnxruntime-web', 'dist');
const out = join(process.cwd(), 'public', 'ort');
mkdirSync(out, { recursive: true });
const files = [
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
];
for (const f of files) {
  const src = join(dist, f);
  if (!existsSync(src)) {
    console.warn(`prepare-ort: ${f} not found in ${dist}`);
    continue;
  }
  copyFileSync(src, join(out, f));
}
// Tiny module worker used to detect whether this browser can create a module
// worker from inside a worker (Chrome cannot). See lib/engine/worker.ts.
writeFileSync(join(out, 'nested-worker-probe.mjs'), 'self.postMessage(1);\n');
console.log(`prepare-ort: copied ${files.length} files to public/ort`);
