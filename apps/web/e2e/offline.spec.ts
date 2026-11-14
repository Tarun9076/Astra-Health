import { expect, test } from '@playwright/test'
import { countReadings, setSlider, signIn } from './helpers'

// T-UI-02: the habitat server is unreachable while the astronaut checks in. The answers are kept on
// the tablet, sent once the server is back, and stored exactly once.
test('check-in made offline is sent later, exactly once', async ({ page }) => {
  await signIn(page, 'ast3')
  const before = await countReadings(page, 'AST-003', 'mood')

  await page.goto('/astronaut/checkin')
  await expect(page.getByRole('heading', { name: 'Daily check-in' })).toBeVisible()
  await page.route('**/api/checkins', (route) => route.abort('internetdisconnected'))
  await page.getByRole('button', { name: 'Next' }).click()
  await setSlider(page, 'Mood', 6)
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('button', { name: 'Submit check-in' }).click()
  await expect(page.getByText('Check-in saved on this device')).toBeVisible()
  expect(await countReadings(page, 'AST-003', 'mood')).toBe(before)

  // server back: the outbox flushes on the browser's "online" event
  await page.unroute('**/api/checkins')
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(page.getByText(/Sent 1 saved item\(s\)/)).toBeVisible()
  await expect.poll(() => countReadings(page, 'AST-003', 'mood')).toBe(before + 1)

  // another reconnect must not store it again
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await page.waitForTimeout(1500)
  expect(await countReadings(page, 'AST-003', 'mood')).toBe(before + 1)
})
