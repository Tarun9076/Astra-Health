import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// Dev proxy: the web app calls /api and /ws on its own origin; Vite forwards them to the
// Habitat backend (FastAPI). Step 9 adds a /ground-api prefix for the Ground node on :8001.
const HABITAT_API = process.env.VITE_HABITAT_API ?? 'http://localhost:8000'
const GROUND_API = process.env.VITE_GROUND_API ?? 'http://localhost:8001'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Installable, offline app shell (Step 9): every built file is precached, including the bundled
    // emergency procedures, so the app opens without a connection. API data is not cached here;
    // the last screens are restored from the persisted query cache instead (src/main.tsx).
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'pwa-icon.svg'],
      manifest: {
        name: 'ASTRA HEALTH — Crew health intelligence',
        short_name: 'ASTRA HEALTH',
        description: 'Offline-first astronaut health monitoring and decision support (prototype, simulated data).',
        theme_color: '#070b16',
        background_color: '#0b1020',
        display: 'standalone',
        start_url: '/',
        icons: [{ src: 'pwa-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api/, /^\/ground-api/, /^\/ws/, /^\/ground-ws/, /^\/node/],
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
