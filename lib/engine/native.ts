/**
 * The desktop app exposes a native background remover on `window`. When it is
 * there the editor uses it instead of the WebAssembly worker, which is several
 * times faster; everything else works identically.
 */
export interface NativeBridge {
  platform: string;
  removeBackground(rgba: Uint8ClampedArray): Promise<{
    mask: Uint8Array;
    width: number;
    height: number;
    ms: number;
  }>;
}

export function nativeBridge(): NativeBridge | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { cutoutDesktop?: NativeBridge }).cutoutDesktop ?? null;
}

export const isDesktopApp = () => nativeBridge() !== null;
