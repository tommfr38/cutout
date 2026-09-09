/**
 * Downloads the background removal model that gets bundled into the installer,
 * so users do not wait for it on first run. Skips the download if it is
 * already present.
 */
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', 'models');
const file = join(dir, 'ormbg-q8.onnx');
const url =
  'https://huggingface.co/onnx-community/ormbg-ONNX/resolve/main/onnx/model_quantized.onnx';
const MIN_BYTES = 40_000_000;

if (existsSync(file) && statSync(file).size > MIN_BYTES) {
  console.log('fetch-model: already present');
  process.exit(0);
}

mkdirSync(dir, { recursive: true });
console.log(`fetch-model: downloading ${url}`);
const res = await fetch(url);
if (!res.ok) {
  console.error(`fetch-model: failed with ${res.status}`);
  process.exit(1);
}
await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
const size = statSync(file).size;
if (size < MIN_BYTES) {
  console.error(`fetch-model: download looks truncated (${size} bytes)`);
  process.exit(1);
}
console.log(`fetch-model: saved ${(size / 1e6).toFixed(0)} MB`);
