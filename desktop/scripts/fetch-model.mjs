/**
 * Downloads the models bundled into the installer, so the app works without a
 * connection from the moment it is installed. Existing files are left alone.
 */
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', 'models');

/**
 * `to` is relative to desktop/models. The Smart Brush files keep their
 * repository layout, because that is where Transformers.js looks for them
 * once it is pointed at a local directory.
 */
const FILES = [
  {
    to: 'ormbg-q8.onnx',
    url: 'https://huggingface.co/onnx-community/ormbg-ONNX/resolve/main/onnx/model_quantized.onnx',
    minBytes: 40_000_000,
  },
  ...['config.json', 'preprocessor_config.json'].map((name) => ({
    to: `Xenova/slimsam-77-uniform/${name}`,
    url: `https://huggingface.co/Xenova/slimsam-77-uniform/resolve/main/${name}`,
    minBytes: 50,
  })),
  ...[
    ['onnx/vision_encoder.onnx', 20_000_000],
    ['onnx/prompt_encoder_mask_decoder.onnx', 14_000_000],
  ].map(([name, minBytes]) => ({
    to: `Xenova/slimsam-77-uniform/${name}`,
    url: `https://huggingface.co/Xenova/slimsam-77-uniform/resolve/main/${name}`,
    minBytes,
  })),
];

let downloaded = 0;
for (const { to, url, minBytes } of FILES) {
  const file = join(root, to);
  if (existsSync(file) && statSync(file).size >= minBytes) {
    console.log(`fetch-model: ${to} already present`);
    continue;
  }
  mkdirSync(dirname(file), { recursive: true });
  console.log(`fetch-model: downloading ${to}`);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`fetch-model: ${url} failed with ${res.status}`);
    process.exit(1);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
  const size = statSync(file).size;
  if (size < minBytes) {
    console.error(`fetch-model: ${to} looks truncated (${size} bytes)`);
    process.exit(1);
  }
  downloaded += size;
}
console.log(`fetch-model: done, ${(downloaded / 1e6).toFixed(0)} MB downloaded`);
