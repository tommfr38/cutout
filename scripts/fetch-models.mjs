/**
 * Downloads the automatic background remover into public/models, where the
 * site serves it from. It is too large for git, so it lives as an asset on the
 * repository's `models-1` release and is checked against a pinned hash.
 * Run automatically after `npm install`; skips the download when the file is
 * already there and intact.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';

export const MODELS = [
  {
    to: 'public/models/isnet-general-use/onnx/model_quantized.onnx',
    url: 'https://github.com/tommfr38/cutout/releases/download/models-1/isnet-general-use-q8.onnx',
    sha256: '1f513a69287e05c689834d7a04d10de21bd9dca43565fd5a0e962383a2d58b21',
  },
];

async function sha256(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

export async function fetchModels(root = process.cwd(), list = MODELS) {
  for (const { to, url, sha256: expected } of list) {
    const file = join(root, to);
    if (existsSync(file) && (await sha256(file)) === expected) {
      console.log(`fetch-models: ${to} ok`);
      continue;
    }
    mkdirSync(dirname(file), { recursive: true });
    console.log(`fetch-models: downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch-models: ${url} failed with ${res.status}`);
    const partial = `${file}.partial`;
    await pipeline(Readable.fromWeb(res.body), createWriteStream(partial));
    const got = await sha256(partial);
    if (got !== expected) throw new Error(`fetch-models: ${to} hash mismatch (${got})`);
    renameSync(partial, file);
    console.log(`fetch-models: ${to} saved`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fetchModels().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
