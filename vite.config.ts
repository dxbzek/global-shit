import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

/**
 * Cesium ships its workers, WebAssembly and asset files as separate static
 * files that it loads at runtime from a base URL, so they are copied into the
 * bundle and CESIUM_BASE_URL is pointed at them. Without this the globe loads
 * but terrain decoding and the atmosphere shaders fail at runtime.
 */

/**
 * Where the bundle will be served from.
 *
 * The worker serves the app at the origin root, so '/' is correct there and
 * stays the default. The static preview is served from a sub-path, and an
 * absolute '/assets/...' resolves against the host root rather than the
 * sub-path, so every stylesheet, script and data file 404s and the page
 * renders as unstyled HTML. Building it with BUILD_BASE=./ makes every
 * reference relative, which works in both places.
 */
const BASE = process.env.BUILD_BASE ?? '/';
const CESIUM_BASE = `${BASE.endsWith('/') ? BASE : `${BASE}/`}cesium`;
const OUT_DIR = process.env.BUILD_OUTDIR ?? '../dist';

export default defineConfig({
  root: 'web',
  publicDir: 'public',
  base: BASE,
  define: {
    CESIUM_BASE_URL: JSON.stringify(CESIUM_BASE),
  },
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    // Cesium is large; the warning is expected and not worth suppressing work.
    chunkSizeWarningLimit: 4096,
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks: {
          // Keeps app code in a small chunk that can change without forcing a
          // re-download of the engine.
          cesium: ['cesium'],
        },
      },
    },
  },
  plugins: [
    viteStaticCopy({
      targets: ['Workers', 'Assets', 'ThirdParty', 'Widgets'].map((dir) => ({
        src: `../node_modules/cesium/Build/Cesium/${dir}`,
        dest: 'cesium',
      })),
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      // Local dev: the Vite server proxies API calls to `wrangler dev`.
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
});
