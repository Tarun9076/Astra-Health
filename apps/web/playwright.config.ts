import { defineConfig, devices } from '@playwright/test'

// End-to-end tests for the astronaut demo path (Step 11): T-UI-01, T-UI-02, emergency, accessibility.
// Starts its own backend (fresh e2e.db with mission history, port 8100) and a Vite dev server
// (port 5174) proxying to it, so the demo database and the dev servers on 8000/5173 are untouched.
// The backend's virtual environment (override with ASTRA_PYTHON, e.g. in CI).
const PYTHON =
  process.env.ASTRA_PYTHON ?? (process.platform === 'win32' ? '.venv\\Scripts\\python.exe' : '.venv/bin/python')

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1, // one shared backend: tests run in order
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5174',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: [
    {
      command: `${PYTHON} -m astra.e2e_server --port 8100`,
      cwd: '../../services/backend',
      url: 'http://localhost:8100/health',
      timeout: 240_000,
      reuseExistingServer: false,
      stdout: 'pipe',
    },
    {
      command: 'npx vite --port 5174 --strictPort',
      url: 'http://localhost:5174',
      timeout: 60_000,
      reuseExistingServer: false,
      stderr: 'ignore', // proxy noise when live-update sockets close at the end of a test
      env: { VITE_HABITAT_API: 'http://localhost:8100', VITE_GROUND_API: 'http://localhost:8199' },
    },
  ],
})
