# Cutout

**Background remover. For free!**

**[Open the app](https://tommfr38.com/cutout/)**

Cutout removes the background from a photo directly in your browser. There is
no login, no subscription, no credits and no watermark, and nothing to
install. Your image never leaves your device: the models are downloaded once
and run locally.

## Features

- Automatic background removal on open
- Smart Brush: brush over an object to erase or restore it along its edges
- Manual erase/restore brush and lasso selection
- Undo/redo, zoom and pan, hold-to-compare with the original
- Transparent, solid-colour or photo backgrounds
- Full-resolution PNG (with transparency), WebP or JPG download
- Works on desktop and mobile

## Hosting

The live site is a GitHub Pages project site, built and deployed by
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) on every push to
`main`. `npm run build:pages` produces that static export; `npm run build`
produces the server-rendered Cloudflare Workers build instead, which adds the
cross-origin isolation headers that Pages cannot set.

## Development

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

`npm run build` produces the production bundle and `npm start` serves it;
`npm run lint` runs oxlint. `npm install` also runs `scripts/prepare-ort.mjs`,
which copies the ONNX Runtime WebAssembly binaries into `public/ort`.

## How it works

- [`lib/engine/worker.ts`](lib/engine/worker.ts) runs the models in a Web
  Worker so the interface stays responsive.
- [`lib/mask/`](lib/mask) holds the alpha-mask primitives (brush, lasso,
  model-mask application) and a memory-bounded undo history.
- [`components/editor/Editor.tsx`](components/editor/Editor.tsx) is the editor:
  canvas rendering, pointer/touch handling, tools and export.

The original pixels are never modified. Every tool edits a separate alpha
mask, and the download composites the two at full resolution.

See [docs/MODELS.md](docs/MODELS.md) for the models used and their licenses.

## Limits

- Images larger than 25 MB are rejected. Very large images are reduced to
  24 megapixels (12 on phones) to fit in browser memory; the editor says so.
- The first run downloads the model weights, about 44 MB for automatic removal
  and 40 MB more the first time you use the Smart Brush.
- Automatic removal takes a few seconds per image on a current laptop, and
  longer on phones or in a backgrounded tab. `docs/MODELS.md` explains why it
  runs on one thread in Chrome.
- The app must keep the cross-origin isolation headers in `next.config.ts` and
  `public/_headers`. A browser refuses to start the worker without them.

## License

[MIT](LICENSE). Model weights are covered by their own licenses; see
`docs/MODELS.md`.
