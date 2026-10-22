const { contextBridge, ipcRenderer } = require('electron');

/**
 * The interface checks for this object to decide whether to use the native
 * background remover instead of the WebAssembly one. See lib/engine/client.ts.
 */
contextBridge.exposeInMainWorld('cutoutDesktop', {
  platform: process.platform,
  /**
   * @param {Uint8ClampedArray} rgba 1024 x 1024 RGBA pixels
   * @param {'primary' | 'backup'} [which] model to use
   * @returns {Promise<{ mask: Uint8Array, width: number, height: number, ms: number }>}
   */
  removeBackground: (rgba, which) => ipcRenderer.invoke('cutout:remove-background', rgba, which),
});
