import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { createReadStream, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// The exercise coach's body tracking engine (MediaPipe, WebAssembly) is served by the app itself at
// /mediapipe/wasm/, so it works offline: streamed from node_modules in dev, copied into the build.
// The model file is in public/models/.
function mediapipeWasm(): Plugin {
  const dir = new URL('./node_modules/@mediapipe/tasks-vision/wasm/', import.meta.url)
  const files = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm', 'vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm']
  return {
    name: 'mediapipe-wasm',
    configureServer(server) {
      server.middlewares.use('/mediapipe/wasm', (req, res, next) => {
        const name = (req.url ?? '').split('?')[0].replace(/^\//, '')
        if (!files.includes(name)) return next()
        res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
        createReadStream(fileURLToPath(new URL(name, dir))).pipe(res)
      })
    },
    generateBundle() {
      for (const name of files) {
        this.emitFile({ type: 'asset', fileName: `mediapipe/wasm/${name}`, source: readFileSync(fileURLToPath(new URL(name, dir))) })
      }
    },
  }
}

// Dev proxy: the web app calls /api and /ws on its own origin; Vite forwards them to the
// Habitat backend (FastAPI). Step 9 adds a /ground-api prefix for the Ground node on :8001.
const HABITAT_API = process.env.VITE_HABITAT_API ?? 'http://localhost:8000'
const GROUND_API = process.env.VITE_GROUND_API ?? 'http://localhost:8001'

export default defineConfig({
  // The 3D body model (three.js, ~0.9 MB) is its own lazy chunk, loaded only in the 3D view.
  build: { chunkSizeWarningLimit: 1000 },
  plugins: [
    react(),
    tailwindcss(),
    mediapipeWasm(),
    // Installable, offline app shell (Step 9): every built file is precached, including the bundled
    // emergency procedures, so the app opens without a connection. API data is not cached here;
    // the last screens are restored from the persisted query cache instead (src/main.tsx).
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'pwa-icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'ASTRA HEALTH — Crew health intelligence',
        short_name: 'ASTRA HEALTH',
        description: 'Offline-first astronaut health monitoring and decision support (prototype, simulated data).',
        theme_color: '#070b16',
        background_color: '#0b1020',
        display: 'standalone',
        start_url: '/',
        // PNGs for Chrome / Android install (192 + 512), a maskable one for adaptive icons, the SVG for the rest
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'pwa-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2,png}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api/, /^\/ground-api/, /^\/ws/, /^\/ground-ws/, /^\/node/],
        // Body tracking (≈ 24 MB) is too big to precache: kept after its first use instead.
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/mediapipe/') || url.pathname.startsWith('/models/'),
            handler: 'CacheFirst',
            options: { cacheName: 'body-tracking', expiration: { maxEntries: 10 } },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    // Emergency procedures are bundled from ../../protocols (src/lib/emergency.ts).
    fs: { allow: ['.', '../../protocols'] },
    proxy: {
      '/api': { target: HABITAT_API, changeOrigin: true },
      '/ws': { target: HABITAT_API, changeOrigin: true, ws: true },
      // Earth roles (flight surgeon, mission control) use the Ground node's synced copy (Step 9)
      '/ground-api': { target: GROUND_API, changeOrigin: true, rewrite: (p) => p.replace(/^\/ground-api/, '/api') },
      '/ground-ws': { target: GROUND_API, changeOrigin: true, ws: true, rewrite: (p) => p.replace(/^\/ground-ws/, '/ws') },
    },
  },
})
