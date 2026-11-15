import { expect, test, type Page } from '@playwright/test'
import { signIn } from './helpers'

// T-UI-13: no internet, but the Habitat server is still reachable (on a spacecraft it is on board;
// in the demo it is this computer). The browser reports "offline", yet everything must keep working:
// screens load, buttons save, the coach and the assistant answer. Only a real loss of the Habitat
// server counts as offline.

async function internetOff(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => false })
    window.dispatchEvent(new Event('offline'))
  })
}

test('with the internet off, everything on board keeps working', async ({ page }) => {
  await signIn(page, 'ast1')
  await page.goto('/astronaut/wellness')
  await expect(page.getByRole('heading', { name: 'Wellness', level: 1 })).toBeVisible()
  await internetOff(page)
  await expect(page.getByText('No internet')).toBeVisible()
  await expect(page.getByText('Everything on board keeps working')).toBeVisible()
  await expect(page.getByText('Habitat server not reachable')).toHaveCount(0)

  // a write still goes straight to the Habitat (it used to wait for the internet)
  const before = Number(await page.locator('#nutrition').getByText(/^\d+$/).first().innerText())
  await page.getByRole('button', { name: '+ 250 mL' }).click()
  await expect(page.locator('#nutrition').getByText(/^\d+$/).first()).toHaveText(String(before + 250))

  // new screens load from the Habitat
  await page.getByRole('link', { name: /My Health/ }).click()
  await expect(page.getByRole('heading', { name: 'Choose a part of your body' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Your readings' })).toBeVisible()

  // the exercise coach plan and the assistant (offline answers)
  await page.getByRole('link', { name: /Wellness/ }).click()
  await page.getByRole('link', { name: 'Start a coached workout' }).click()
  await expect(page.getByText('Today’s plan')).toBeVisible()
  await page.getByRole('link', { name: /AI Assistant/ }).click()
  await page.getByRole('button', { name: 'Why am I so tired?' }).click()
  await expect(page.locator('div.rounded-bl-sm').last().getByText('What helps', { exact: true })).toBeVisible()
  await expect(page.getByText('No internet')).toBeVisible()
})
