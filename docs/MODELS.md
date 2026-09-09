# Models and attribution

Cutout runs entirely in the browser. On first use it downloads the model
weights below from the Hugging Face Hub and caches them with the browser's
Cache API, so later visits work without re-downloading. No image ever leaves
the device.

| Purpose | Model | Files fetched | License |
| --- | --- | --- | --- |
| Automatic background removal | [`onnx-community/ormbg-ONNX`](https://huggingface.co/onnx-community/ormbg-ONNX), an ONNX export of [Open Remove Background Model](https://huggingface.co/schirrmacher/ormbg) by Maximilian Schirrmacher, an IS-Net ([DIS](https://github.com/xuebinqin/DIS), Qin et al., 2022) model | `model_quantized.onnx` (≈44 MB, 8-bit) | Apache-2.0 (see model card) |
| Smart Brush | [`Xenova/slimsam-77-uniform`](https://huggingface.co/Xenova/slimsam-77-uniform), an ONNX export of [SlimSAM](https://github.com/czg1225/SlimSAM) (Chen et al., 2023), itself derived from Meta's [Segment Anything](https://github.com/facebookresearch/segment-anything) | `vision_encoder.onnx` (≈23 MB), `prompt_encoder_mask_decoder.onnx` (≈17 MB) | Apache-2.0 (see model card) |

Inference uses [Transformers.js](https://github.com/huggingface/transformers.js)
(`@huggingface/transformers`, Apache-2.0) on top of
[ONNX Runtime Web](https://onnxruntime.ai/) (MIT), running in WebAssembly
inside a Web Worker, so the interface stays responsive and a run can be
cancelled. The ONNX Runtime `.wasm` binaries are served from the app itself
(`public/ort`, copied from the installed `onnxruntime-web` by
`scripts/prepare-ort.mjs`) so their version always matches the library. See
[Threads](#threads) for why inference is single-threaded in Chrome.

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

ormbg is a fully convolutional model, needs far less activation memory, and
produced clean hair edges on the test images. Its author notes it is tuned for
images of people; other subjects still work but were not the training focus.

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

The desktop app runs the same ormbg model through the native ONNX Runtime
build (`onnxruntime-node`) instead of WebAssembly, in an Electron utility
process. That avoids the thread limit above entirely and takes about 0.8
seconds per image rather than 6.4.

Both models ship inside the installer, so nothing is downloaded at runtime.
`scripts/fetch-model.mjs` collects them at build time, keeping the Smart Brush
files in their repository layout, and the app serves them to the interface
under `cutout://app/models/`, which is where Transformers.js is pointed when
it detects that scheme.

Two details are worth knowing if you touch that code. The native session is
created fresh for every image, because reusing one across runs crashes
Electron's Node build, and creation costs about 40 ms against 750 ms of
inference. And the renderer hands the process an exact 1024 x 1024 square,
since preprocessing happens in the browser's canvas rather than in Node.

## Measurements

Apple Silicon laptop, Chromium 148, one 1024 × 683 photo, WebAssembly backend,
a visible tab:

| Step | Time |
| --- | --- |
| First visit, model download (44 MB, 8-bit) | a few seconds, shown as progress |
| Automatic removal | ≈6.4 s per image, single-threaded |
| Automatic removal, multi-threaded (main thread only) | ≈1.7 s |
| Smart Brush, preparing an image | ≈2 s, once per image |
| Smart Brush, each stroke | well under a second |

The 8-bit file is the default: against the fp32 file its mask differs by a mean
of 0.0002 to 0.0006 (on a 0 to 1 scale) on the two test photos, and by 0.01 to
0.04 on edge pixels, which is well below what is visible. It also downloads four
times faster and runs at the same speed.

A hidden or backgrounded tab is throttled by the browser and can take three
times longer. Numbers vary a lot between machines and browsers; treat them as
rough guides.

Please cite the original papers if you build on this work:

- Qin, X. et al. *Highly Accurate Dichotomous Image Segmentation.* ECCV, 2022.
- Chen, Z. et al. *SlimSAM: 0.1% Data Makes Segment Anything Slim.* 2023.
- Kirillov, A. et al. *Segment Anything.* ICCV, 2023.

Model choice is provisional. Neither model is guaranteed to match commercial
services on every image; hair, fur, glass and other soft or transparent edges
are the hardest cases.
