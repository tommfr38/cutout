# Models and attribution

Cutout runs entirely in the browser, or in the desktop app. No image ever
leaves the device.

| Purpose | Model | Where it comes from | License |
| --- | --- | --- | --- |
| Automatic background removal | `isnet-general-use`, the general-purpose IS-Net from the [DIS](https://github.com/xuebinqin/DIS) authors (Qin et al., 2022), converted to ONNX by [rembg](https://github.com/danielgatis/rembg) and quantised to 8 bits for this app (≈46 MB) | Served by the site itself; the file is the `models-1` release asset, fetched by `scripts/fetch-models.mjs` and checked against a pinned SHA-256 | Apache-2.0 (code and models). The DIS5K training data has its own [terms of use](https://github.com/xuebinqin/DIS/blob/main/DIS5K-Dataset-Terms-of-Use.pdf) |
| Second opinion for automatic removal | [`onnx-community/ormbg-ONNX`](https://huggingface.co/onnx-community/ormbg-ONNX), [Open Remove Background Model](https://huggingface.co/schirrmacher/ormbg) by Maximilian Schirrmacher, also IS-Net (≈44 MB, 8-bit) | Hugging Face Hub, only when needed | Apache-2.0 |
| Smart Brush | [`Xenova/slimsam-77-uniform`](https://huggingface.co/Xenova/slimsam-77-uniform), [SlimSAM](https://github.com/czg1225/SlimSAM) (Chen et al., 2023), derived from Meta's [Segment Anything](https://github.com/facebookresearch/segment-anything) | Hugging Face Hub, on first use | Apache-2.0 |

The desktop app bundles all of them, so it never goes online. Downloads on
the web are cached by the browser for later visits.

Inference uses [Transformers.js](https://github.com/huggingface/transformers.js)
(`@huggingface/transformers`, Apache-2.0) on top of
[ONNX Runtime Web](https://onnxruntime.ai/) (MIT), in WebAssembly inside a Web
Worker, so the interface stays responsive and a run can be cancelled. The
ONNX Runtime `.wasm` binaries are served from the app itself (`public/ort`,
copied from the installed `onnxruntime-web` by `scripts/prepare-ort.mjs`) so
their version always matches the library. See [Threads](#threads).

## How automatic removal works

The original model, ormbg, was trained mostly on people. On illustrations,
logos and strongly coloured backdrops it went to pieces: drawings came out
ghostly and half transparent, and patches of the backdrop survived between
legs or under tails. Three changes fix most of that.

1. **A general-purpose model.** isnet-general-use was trained on thousands of
   object categories, not just people, and keeps illustrations solid.
2. **A second opinion.** If isnet finds almost nothing, or its outline cuts
   through flat colour instead of following edges in the image, ormbg runs
   too and the mask that better follows the image's edges wins
   (`lib/mask/quality.ts`). This catches, for example, a logo that fills the
   whole frame, which isnet tends to erase.
3. **Measuring the backdrop** (`lib/mask/separate.ts`). When the backdrop is a
   plain colour or a smooth gradient, it can be measured instead of guessed:
   - fit its colour to the image border, robustly, so a subject touching the
     edge does not spoil the fit;
   - if the subject's colours stand clear of it, recover each pixel's opacity
     from the colour maths, `pixel = a·subject + (1−a)·backdrop`, and only
     ask the model about regions that resemble the backdrop. Real backdrop
     matches the fitted colour almost exactly at a region's core, while a
     look-alike part of the subject has texture;
   - if the subject shares colours with the backdrop (a white cat on white),
     the model leads and the colour maths only removes leftover patches of
     exact backdrop and sharpens high-contrast edges;
   - either way, remove the backdrop's tint from soft edges by un-mixing each
     edge pixel, so there are no coloured halos, and finish with a gentle
     levels curve that removes the faint haze the models leave.

   With a busy backdrop none of this applies. The model's answer is used,
   except that an enclosed hole whose colour matches nothing around the
   outside of the subject is filled back in: a real hole shows the backdrop.

The tint-free edge colours are shown only where a pixel is partly
transparent, so undo and the restore brush always bring back the original
colours.

## Benchmark

`bench/` tests the shipped pipeline against the original one. It takes 28
images with real transparency from Wikimedia Commons, 14 photographs (fur,
feathers, glass, petals) and 14 vector illustrations and logos, composites
each onto 17 backdrops, round-trips the result through JPEG like a real
upload, and compares each cutout with the known answer. The main score is the
visible error: the cutout drawn over mid grey against the truth drawn the same
way, in 0 to 255 colour units, which counts both wrong opacity and coloured
fringes. A result counts as visibly broken above 10.

| | Original app | Now |
| --- | --- | --- |
| Photos, visible error | 7.8 | 5.1 |
| Photos, visibly broken | 22% | 5% |
| Vectors, visible error | 17.5 | 10.1 |
| Vectors, visibly broken | 35% | 12% |

Visibly broken excludes three deliberately adversarial backdrops: one matched
to the subject's own colour, black (invisible against black outlines), and a
busy pattern. Gains are largest on saturated colours: orange went from 12.2 to
3.2, purple from 11.0 to 4.8, blue from 9.2 to 2.8.

Known weak spots, from the same data:

- **Illustrations on a busy photographic backdrop got worse** (13.2 to 20.2).
  isnet does worse than ormbg there and no cheap check reliably tells when.
  Photographs on busy backdrops improved (9.5 to 7.0), and that is the far
  more common case.
- A white shape on a white backdrop, separated only by an outline, can read as
  a hole.
- Black line art on a black backdrop, and subjects on a backdrop of their own
  colour, remain hard, as they are for a person.

To run it: `npm install`, then in `desktop/` run `npm install` and
`node scripts/fetch-model.mjs`, then `node bench/fetch-dataset.mjs` and
`node bench/run.mjs`. Add `"sheets=1"` to save visual comparisons to
`bench/out/sheets/`.

## Why not BiRefNet?

`onnx-community/BiRefNet_lite-ONNX` was the first candidate. In this app it
fails on every backend that was tried:

- On WebAssembly, ONNX Runtime dies with `std::bad_alloc` during the forward
  pass. The export emulates `deform_conv2d` with `GatherND` nodes that
  materialise hundreds of megabytes of indices per node on the 32-bit WASM heap.
- On WebGPU (Chromium 148 in the desktop app) the runtime raises validation
  errors in the `Slice` kernel for both the fp16 and fp32 files.
- A community re-export that rewrites those nodes
  (`jiabins0303/birefnet-lite-1024-webgpu`) runs on WebGPU, but its fp16
  weights overflow to ±∞ on the test GPU and the output is noise.

Natively, in the desktop app's ONNX Runtime, BiRefNet does run, and on its own
it is the best of the three, especially on illustrations. With the pipeline
above in place the gap mostly closes (vectors: 7.2 visible error against 9.0
for isnet with its second opinion, and visibly broken in 18% of cases against
17%), while it takes 5 to 7 seconds per image instead of 0.7 and adds 224 MB to
the installer. Quantising does not help: most of its size is the index tables
behind the WebAssembly crash, not weights. So both the site and the desktop app
use isnet.

## Threads

ONNX Runtime's WebAssembly build can use several threads, which is roughly four
times faster. Two things have to line up for that:

1. The page must be cross-origin isolated. `next.config.ts` and `public/_headers`
   set `Cross-Origin-Opener-Policy: same-origin` and
   `Cross-Origin-Embedder-Policy: require-corp` on **every** response, including
   the worker script itself, which a browser refuses to start otherwise.
2. The runtime must be able to start its thread pool, which it does by creating
   module workers. Chrome cannot create a module worker from inside a worker,
   so the pool never comes up and inference would hang forever.

`lib/engine/worker.ts` therefore probes for nested module workers once and falls
back to a single thread when they fail, which is what happens in Chrome today.
Moving inference to the main thread would restore threads but freeze the
interface for the whole run, so the worker keeps it.

## The desktop app

The desktop app runs the same pipeline, with isnet and ormbg running through
the native ONNX Runtime build (`onnxruntime-node`) instead of WebAssembly, in
an Electron utility process. That avoids the thread limit above entirely: isnet
takes about 0.7 seconds per image, plus as much again when a second opinion is
needed. The backdrop refinement runs in the interface's worker, exactly as on
the web.

All the models ship inside the installer, so nothing is downloaded at runtime.
`scripts/fetch-model.mjs` collects them at build time, keeping the Smart Brush
files in their repository layout, and the app serves them to the interface
under `cutout://app/models/`, which is where Transformers.js is pointed when
it detects that scheme.

Two details are worth knowing if you touch that code. The native session is
created fresh for every image, because reusing one across runs crashes
Electron's Node build, and creation costs about 40 ms against 700 ms of
inference. And the renderer hands the process an exact 1024 x 1024 square,
since preprocessing happens in the browser's canvas rather than in Node.

## Measurements

Apple silicon laptop, WebAssembly backend, a visible tab. Automatic removal
was timed in Electron's Chromium, which allows four threads, on 640-pixel
test images; the Smart Brush earlier in Chromium 148:

| Step | Time |
| --- | --- |
| First visit, model download (46 MB, 8-bit) | a few seconds, shown as progress |
| Automatic removal, Chromium with 4 threads | ≈2.3 to 2.9 s per image |
| Automatic removal, Chrome on one thread | not re-measured; the previous model, same architecture and size, took ≈6.4 s |
| Backdrop refinement | ≈0.1 s at 640 px |
| Smart Brush, preparing an image | ≈2 s, once per image |
| Smart Brush, each stroke | well under a second |

The 8-bit isnet costs nothing measurable: on the benchmark, after refinement,
it scored 4.93 and 16.90 against 4.85 and 17.13 for the full-precision file on
photos and vectors, at a quarter of the download.

A hidden or backgrounded tab is throttled by the browser and can take three
times longer. Numbers vary a lot between machines and browsers; treat them as
rough guides.

Please cite the original papers if you build on this work:

- Qin, X. et al. *Highly Accurate Dichotomous Image Segmentation.* ECCV, 2022.
- Chen, Z. et al. *SlimSAM: 0.1% Data Makes Segment Anything Slim.* 2023.
- Kirillov, A. et al. *Segment Anything.* ICCV, 2023.

None of this is guaranteed to match commercial services on every image; hair,
fur, glass and other soft or transparent edges remain the hardest cases.
