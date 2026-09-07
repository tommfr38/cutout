import type { NextConfig } from 'next';

/**
 * Two deployment targets.
 *
 * By default the app is server-rendered (Cloudflare Workers) and sets the
 * cross-origin isolation headers, which let the model runtime use threads
 * where the browser allows it.
 *
 * With GITHUB_PAGES=1 it is exported as static files instead. GitHub Pages
 * cannot set response headers, so the page is not cross-origin isolated and
 * inference runs on one thread. That is what Chrome does anyway; see
 * docs/MODELS.md. GITHUB_PAGES_PATH is the subpath the site is served from,
 * which for a project site is the repository name.
 */
const isGitHubPages = process.env.GITHUB_PAGES === '1';
const pagesPath = process.env.GITHUB_PAGES_PATH ?? '/cutout';

const nextConfig: NextConfig = isGitHubPages
  ? {
      output: 'export',
      assetPrefix: pagesPath,
      images: { unoptimized: true },
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
