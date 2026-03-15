/**
 * vite.config.js — Vite + Electron Build Configuration
 *
 * Plugins:
 * - vite-plugin-cesium: Handles CesiumJS assets (workers, WASM, etc.)
 * - vite-plugin-electron: Builds main + preload; main process uses esbuild
 * - vite-plugin-electron-renderer: Enables Node polyfills for renderer
 *
 * Main process entry: electron/main.js
 * Preload entry: electron/preload.js
 * Externals: ws, node:*, etc. — not bundled for main process
 */

import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';

export default defineConfig({
  // Required for Electron: when loading from file://, absolute paths like /cesium/...
  // resolve to the filesystem root and fail. Relative base fixes asset loading.
  base: './',
  plugins: [
    cesium(),
    electron([
      {
        // Main process
        entry: 'electron/main.js',
        vite: {
          build: {
            rollupOptions: {
              external: ['ws', 'events', 'stream', 'http', 'https', 'net', 'tls', 'crypto', 'buffer', 'url', 'util', 'os', 'path', 'fs',
                         'node:http', 'node:https', 'node:crypto', 'node:url', 'node:path', 'node:fs', 'node:os', 'node:net', 'node:tls', 'node:stream', 'node:events', 'node:buffer', 'node:util'],
            },
          },
        },
      },
      {
        // Preload script
        entry: 'electron/preload.js',
        onstart(options) {
          options.reload();
        },
      },
    ]),
    renderer(),
  ],
  server: {
    port: 5173,
  },
});
