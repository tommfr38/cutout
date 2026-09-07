/**
 * Removes the copy of the ONNX Runtime WebAssembly binary that the bundler
 * emits next to the model worker.
 *
 * The worker sets `env.backends.onnx.wasm.wasmPaths` to `/ort/`, so it always
 * loads the binaries that `prepare-ort.mjs` put in `public/ort`. The bundled
 * copy is never fetched, and it is 21 MB: on the client it is dead weight, and
 * in the server output it counts against the Cloudflare Workers script size
 * limit. Nothing in the server entry imports the worker chunk either, so the
 * server copy of that goes too.
 */
import { readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const removed = [];

function pruneDir(dir, matches) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!matches(name)) continue;
    const file = join(dir, name);
    removed.push([file, statSync(file).size]);
    rmSync(file);
  }
}

const isOrtWasm = (n) => /^ort-wasm.*\.wasm$/.test(n);
const isWorkerChunk = (n) => /^worker-.*\.js(\.map)?$/.test(n);

// Client: the served worker chunk stays, its unused wasm sibling goes.
pruneDir('dist/client/_next/static', isOrtWasm);
// Server: neither is reachable from the server entry.
for (const dir of ['dist/server/_next/static', 'dist/server/ssr/_next/static']) {
  pruneDir(dir, (n) => isOrtWasm(n) || isWorkerChunk(n));
}

const total = removed.reduce((sum, [, size]) => sum + size, 0);
console.log(
  removed.length
    ? `prune-bundled-ort: removed ${removed.length} files (${(total / 1e6).toFixed(0)} MB)`
    : 'prune-bundled-ort: nothing to remove',
);
