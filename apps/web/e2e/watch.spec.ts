import { expect, test } from '@playwright/test'
import { signIn } from './helpers'

// T-UI-11 (Step 15): the astronaut's smartwatch over Bluetooth. A test browser has no Bluetooth, so a
// simulated watch stands in: it offers the standard Heart Rate service and sends the same bytes a real
// watch does (flags 0x00, 8-bit beats per minute) about 5 times a second. Saving runs every 3 s here.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    ;(globalThis as { __ASTRA_WATCH_SAVE_MS?: number }).__ASTRA_WATCH_SAVE_MS = 3000
    const characteristic = new EventTarget() as EventTarget & { value?: DataView; startNotifications: () => Promise<unknown>; stopNotifications: () => Promise<unknown> }
    let timer: number | undefined
    characteristic.startNotifications = async () => {
      timer = window.setInterval(() => {
        characteristic.value = new DataView(new Uint8Array([0x00, 64]).buffer)
        characteristic.dispatchEvent(new Event('characteristicvaluechanged'))
      }, 200)
      return characteristic
    }
    characteristic.stopNotifications = async () => { window.clearInterval(timer); return characteristic }
    const device = new EventTarget() as EventTarget & { id: string; name: string; gatt: unknown }
    const server = {
      connected: false,
      connect: async () => { server.connected = true; return server },
      disconnect: () => { server.connected = false; window.clearInterval(timer); device.dispatchEvent(new Event('gattserverdisconnected')) },
      getPrimaryService: async (uuid: string) => {
        if (uuid !== 'heart_rate') throw new DOMException('No Services matching UUID', 'NotFoundError')
        return { getCharacteristic: async () => characteristic }
      },
    }
    Object.assign(device, { id: 'fake-watch', name: 'FB BGR002', gatt: server })
    Object.defineProperty(navigator, 'bluetooth', { value: { requestDevice: async () => device }, configurable: true })
  })
})

test('connect the watch: live heart rate, saved readings, resting heart rate in the check-in', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, 'ast1')
  await page.goto('/astronaut/home')
  await page.getByRole('button', { name: 'Connect watch' }).click()
  const chip = page.locator('summary[aria-label^="Your watch"]')
  await expect(chip).toHaveAttribute('aria-label', 'Your watch: heart rate 64 beats per minute')
  await chip.click()
  await expect(page.getByText('FB BGR002')).toBeVisible()
  await expect(page.getByText(/\(([1-9]\d*) so far\)/)).toBeVisible({ timeout: 15_000 }) // a reading was saved
  await chip.click()
  // …and it is in the health record as a heart-rate reading from the last minute
  const login = await page.request.post('/api/auth/login', { data: { username: 'ast1', password: 'astra-demo-ast1' } })
  const token = (await login.json()).accessToken as string
  const series = await page.request.get('/api/astronauts/AST-001/measurements?indicator=heart_rate', { headers: { Authorization: `Bearer ${token}` } })
  const points = (await series.json()).points as { t: string; value: number }[]
  const last = points.at(-1)!
  expect(last.value).toBe(64)
  expect(Date.now() - Date.parse(last.t)).toBeLessThan(60_000)

  // the connection stays while moving around the app
  await page.getByRole('link', { name: /Daily Check-in/ }).click()
  await expect(page.getByText('Your watch reads 64 bpm now.')).toBeVisible()
  await page.getByRole('button', { name: 'Measure with my watch (30 s)' }).click()
  await expect(page.getByText(/Sit still and breathe normally/)).toBeVisible()
  await expect(page.getByText(/^Measured by your watch: 64 bpm/)).toBeVisible({ timeout: 40_000 })
  await expect(page.getByRole('spinbutton', { name: /Resting heart rate/ })).toHaveValue('64')

  await chip.click()
  await page.getByRole('button', { name: 'Disconnect' }).click()
  await expect(page.getByRole('button', { name: 'Connect watch' })).toBeVisible()
})
