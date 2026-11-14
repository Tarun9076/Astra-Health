import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Dev proxy: the web app calls /api and /ws on its own origin; Vite forwards them to the
// Habitat backend (FastAPI). Step 9 adds a /ground-api prefix for the Ground node on :8001.
const HABITAT_API = process.env.VITE_HABITAT_API ?? 'http://localhost:8000'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: HABITAT_API, changeOrigin: true },
      '/ws': { target: HABITAT_API, changeOrigin: true, ws: true },
    },
  },
})
