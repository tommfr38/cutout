/**
 * Prepares `dist/client` for a GitHub Pages project site.
 *
 * `assetPrefix` makes the HTML point at `/<repo>/_next/...` and vinext also
 * writes those files into a `<repo>/` folder. On Pages the published folder is
 * already served at `/<repo>/`, so that prefix has to be flattened away or
 * every asset URL ends up doubled.
 *
 * It also drops a `.nojekyll` marker, without which Pages hides every path
 * beginning with an underscore, `_next` included.
 */
import { cpSync, existsSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = 'dist/client';
const prefix = (process.env.STATIC_ASSET_PREFIX ?? '').replace(/^\/+|\/+$/g, '');
const nested = join(outDir, prefix);

if (prefix && existsSync(nested)) {
  for (const name of readdirSync(nested)) {
    const from = join(nested, name);
    const to = join(outDir, name);
    if (existsSync(to)) {
      cpSync(from, to, { recursive: true });
      rmSync(from, { recursive: true });
    } else {
      renameSync(from, to);
    }
  }
  rmSync(nested, { recursive: true });
  console.log(`pages-postbuild: flattened ${prefix}/ into ${outDir}/`);
}

writeFileSync(join(outDir, '.nojekyll'), '');
// Cloudflare-only, and Pages cannot set headers anyway.
rmSync(join(outDir, '_headers'), { force: true });
console.log('pages-postbuild: wrote .nojekyll');
