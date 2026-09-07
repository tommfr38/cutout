/**
 * Dev-only workaround: Vite's dev client gets pulled into the worker through
 * a dynamic import inside onnxruntime-web and touches `window` at load time.
 * Expose a stand-in while dependencies evaluate; `worker.ts` removes it again
 * before any model code runs. Production bundles never include the client.
 */
// `typeof window` is statically replaced by the dev toolchain, so test the key instead.
if (import.meta.env.DEV && !('window' in globalThis)) {
  (globalThis as unknown as { window: unknown }).window = globalThis;
  (globalThis as unknown as { __cutoutWindowShim: boolean }).__cutoutWindowShim = true;
}

// Dev-only: the dev server mirrors console output, and a failed inference
// logs whole input tensors. Keep those logs short.
if (import.meta.env.DEV) {
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) =>
    original(...args.map((a) => (a && typeof a === 'object' && !(a instanceof Error) ? '[object]' : a)));
}
