// Takes the README screenshots (docs/screenshots/*.png) from a running demo.
// Start a fresh demo first (.\start-demo.ps1 -Fresh), then from apps/web:
//     node scripts/screenshots.ts                      (demo on http://localhost:5173)
//     $env:ASTRA_DEMO_URL = 'http://localhost:5190'; node scripts/screenshots.ts
import { chromium, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const BASE = process.env.ASTRA_DEMO_URL ?? 'http://localhost:5173'
const OUT = fileURLToPath(new URL('../../../docs/screenshots/', import.meta.url))
const PASSWORDS: Record<string, string> = { ast1: 'astra-demo-ast1', surgeon1: 'astra-demo-surgeon', admin: 'astra-demo-admin' }

mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch()

async function as(user: string, shots: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', colorScheme: 'light' })
  const page = await context.newPage()
  await page.goto(`${BASE}/login`)
  await page.getByLabel('Username').fill(user)
  await page.getByLabel('Password').fill(PASSWORDS[user])
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL((u) => !u.pathname.endsWith('/login'))
  await shots(page)
  await context.close()
}

async function shot(page: Page, name: string) {
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(800) // let charts finish drawing
  await page.screenshot({ path: `${OUT}${name}.png` })
  console.log(`  ${name}.png`)
}

await as('ast1', async (page) => {
  await page.goto(`${BASE}/astronaut/home`)
  // just after loading the mission data the link is still sending it to Earth ("N queued"): wait for it
  await page.waitForFunction(() => !/\d+ queued/.test(document.querySelector('header')?.textContent ?? ''), null, { timeout: 300_000 })
  await page.getByRole('heading', { name: "Today's quests" }).waitFor()
  await shot(page, '01-home')

  await page.goto(`${BASE}/astronaut/checkin`)
  await page.getByRole('spinbutton').first().fill('62')
  await shot(page, '02-checkin')

  await page.goto(`${BASE}/astronaut/health?model=3d&region=heart`)
  await page.locator('canvas').waitFor()
  await page.getByRole('heading', { name: 'Body diagram' }).evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await page.getByRole('group', { name: '3D view controls' }).getByRole('button', { name: 'Front' }).click()
  await page.waitForTimeout(3000) // the body is built in a worker, then the camera settles
  await shot(page, '03-body-3d')

  await page.goto(`${BASE}/astronaut/wellness#progress`)
  await page.getByRole('heading', { name: 'Progress and badges' }).waitFor()
  await shot(page, '04-progress')

  await page.goto(`${BASE}/astronaut/assistant`)
  await page.getByRole('button', { name: 'Why am I so tired?' }).click()
  await page.getByText('What helps', { exact: true }).last().waitFor()
  await shot(page, '08-assistant')

  // the Mission dark theme (Step 14)
  await page.evaluate(() => localStorage.setItem('astra-theme', 'dark'))
  await page.goto(`${BASE}/astronaut/home`)
  await page.getByRole('heading', { name: "Today's quests" }).waitFor()
  await shot(page, '07-home-dark')
  await page.evaluate(() => localStorage.removeItem('astra-theme'))
})

await as('surgeon1', async (page) => {
  await page.goto(`${BASE}/staff`)
  await shot(page, '05-flight-surgeon')
})

await as('admin', async (page) => {
  await page.goto(`${BASE}/staff/sim`)
  await shot(page, '06-demo-control')
})

await browser.close()
console.log(`Saved to ${OUT}`)
