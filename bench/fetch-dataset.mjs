/**
 * Downloads the benchmark images listed in dataset.json from Wikimedia
 * Commons into bench/data/. They are not committed because their licences
 * vary; each file's page on Commons has its own.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { files } = JSON.parse(readFileSync(join(here, 'dataset.json'), 'utf8'));
const UA = 'CutoutBenchmark/1.0 (https://github.com/tommfr38/cutout)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const counters = {};

for (const { set, title } of files) {
  counters[set] = (counters[set] ?? 0) + 1;
  const slug = `${String(counters[set]).padStart(2, '0')}-${title.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 30)}.png`;
  const out = join(here, 'data', set, slug);
  if (existsSync(out)) continue;
  mkdirSync(dirname(out), { recursive: true });
  const api = `https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url&iiurlwidth=800&titles=${encodeURIComponent('File:' + title)}`;
  const info = await (await fetch(api, { headers: { 'User-Agent': UA } })).json();
  const page = Object.values(info.query.pages)[0];
  const url = page.imageinfo?.[0]?.thumburl ?? page.imageinfo?.[0]?.url;
  if (!url) { console.warn(`missing: ${title}`); continue; }
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  console.log(`${set}/${slug}`);
  await sleep(1500); // Commons rate-limits quick bursts.
}
