import { expect, test, type Page } from '@playwright/test'
import { signIn } from './helpers'

// T-UI-12 (Step 18): the "Install app" button. It is always visible until the app is installed.
// A test browser never offers installation by itself, so the tests send the same event Chrome sends
// (beforeinstallprompt) and record what the app does.

async function offerInstall(page: Page, outcome: 'accepted' | 'dismissed') {
  await page.evaluate((choice) => {
    const event = new Event('beforeinstallprompt') as Event & { prompt: () => Promise<void>; userChoice: Promise<unknown> }
    event.prompt = async () => { (window as unknown as { __prompted: number }).__prompted = ((window as unknown as { __prompted?: number }).__prompted ?? 0) + 1 }
    Object.defineProperty(event, 'userChoice', { value: Promise.resolve({ outcome: choice, platform: 'web' }) })
    window.dispatchEvent(event)
  }, outcome)
}
const prompted = (page: Page) => page.evaluate(() => (window as unknown as { __prompted?: number }).__prompted ?? 0)

test('before the browser offers: the button explains where install is; with the offer it opens the dialog', async ({ page }) => {
  await page.goto('/login')
  const install = page.getByRole('button', { name: 'Install ASTRA HEALTH on this device' })
  await expect(install).toBeVisible()
  await install.click()
  await expect(install).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('note')).toContainText('Install page as app')

  await offerInstall(page, 'accepted')
  await install.click()
  expect(await prompted(page)).toBe(1)
  await expect(install).toHaveCount(0) // installed
  await signIn(page, 'ast1')
  await expect(page.getByRole('button', { name: 'Install app' })).toHaveCount(0)
})

test('declined: the button stays, and opens the dialog again when the browser offers again', async ({ page }) => {
  await signIn(page, 'ast1')
  const install = page.getByRole('button', { name: 'Install app' })
  await expect(install).toBeVisible() // in the header
  await offerInstall(page, 'dismissed')
  await install.click()
  expect(await prompted(page)).toBe(1)
  await expect(install).toBeVisible()
  await offerInstall(page, 'dismissed')
  await install.click()
  expect(await prompted(page)).toBe(2)
})

test('already running as the installed app: no button', async ({ page }) => {
  await page.addInitScript(() => {
    const real = window.matchMedia.bind(window)
    window.matchMedia = (q: string) => (q === '(display-mode: standalone)' ? { ...real(q), matches: true, media: q } as MediaQueryList : real(q))
  })
  await page.goto('/login')
  await expect(page.getByRole('heading', { level: 1 }).or(page.getByText('ASTRA HEALTH').first())).toBeVisible()
  await expect(page.getByRole('button', { name: /Install/ })).toHaveCount(0)
})

test.describe('iPhone Safari', () => {
  test.use({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  })
  test('shows how to add it to the home screen', async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('button', { name: 'Install ASTRA HEALTH on this device' }).click()
    await expect(page.getByRole('note')).toContainText('Add to Home Screen')
  })
})

test.describe('Firefox on a computer', () => {
  test.use({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0' })
  test('says to use Chrome or Edge', async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('button', { name: 'Install ASTRA HEALTH on this device' }).click()
    await expect(page.getByRole('note')).toContainText('can’t install apps')
  })
})
