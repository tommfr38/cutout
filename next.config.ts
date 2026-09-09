import type { NextConfig } from 'next';

/**
 * Three ways this app is built.
 *
 * By default it is server-rendered (Cloudflare Workers) and sets the
 * cross-origin isolation headers, which let the model runtime use threads
 * where the browser allows it.
 *
 * With STATIC_EXPORT=1 it becomes a folder of static files instead, used both
 * for GitHub Pages and for the interface bundled into the desktop app. Pages
 * cannot set response headers, so that build is not cross-origin isolated and
 * inference runs on one thread, which is what Chrome does anyway; see
 * docs/MODELS.md. STATIC_ASSET_PREFIX is the subpath the site is served from,
 * which for a GitHub Pages project site is the repository name, and which the
 * desktop app leaves empty because it serves from a root.
 */
const staticExport = process.env.STATIC_EXPORT === '1';
const assetPrefix = process.env.STATIC_ASSET_PREFIX ?? '';

const nextConfig: NextConfig = staticExport
  ? {
      output: 'export',
      images: { unoptimized: true },
      ...(assetPrefix ? { assetPrefix } : {}),
    }
  : {
      async headers() {
        return [
          {
            source: '/(.*)',
            headers: [
              { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
              { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
            ],
          },
        ];
      },
    };

export default nextConfig;
