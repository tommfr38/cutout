/**
 * Runs the benchmark: node bench/run.mjs [query]
 * e.g. node bench/run.mjs "sets=vectors&bgs=red,white&sheets=1"
 * Needs `npm install` (for the isnet model), and in desktop/: `npm install` and
 * `node scripts/fetch-model.mjs` (for Electron, native ONNX Runtime and ormbg).
 */
import { execFileSync, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bench = dirname(fileURLToPath(import.meta.url));
const repo = join(bench, '..');
execFileSync(join(repo, 'node_modules/.bin/esbuild'), [
  join(bench, 'harness/app-entry.ts'), '--bundle', '--format=esm', `--outfile=${join(bench, 'harness/app.js')}`, '--log-level=warning',
], { stdio: 'inherit' });
// Stream the output as it comes, minus the noise of cache misses and ONNX
// Runtime's placement notes.
const child = spawn(join(repo, 'desktop/node_modules/.bin/electron'), [join(bench, 'harness/main.cjs')], {
  env: { ...process.env, BENCH_QUERY: process.argv[2] ?? '' },
});
const noise = /ERR_FILE_NOT_FOUND|^\s+at |Some nodes were not assigned|Rerunning with verbose|SimpleURLLoaderWrapper/;
for (const stream of [child.stdout, child.stderr]) {
  let buffered = '';
  stream.on('data', (chunk) => {
    buffered += chunk;
    const lines = buffered.split('\n');
    buffered = lines.pop();
    for (const line of lines) if (line && !noise.test(line)) console.log(line);
  });
}
child.on('exit', (code) => process.exit(code ?? 0));
