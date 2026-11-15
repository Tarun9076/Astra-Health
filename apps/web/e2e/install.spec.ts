import { expect, test, type Page } from '@playwright/test'
import { signIn } from './helpers'

// T-UI-12 (Step 18): the "Install app" button. A test browser never offers installation by itself,
// so the tests send the same event Chrome sends (beforeinstallprompt) and record what the app does.

async function offerInstall(page: Page, outcome: 'accepted' | 'dismissed') {
  await page.evaluate((choice) => {
    const event = new Event('beforeinstallprompt') as Event & { prompt: () => Promise<void>; userChoice: Promise<unknown> }
    event.prompt = async () => { (window as unknown as { __prompted: number }).__prompted = ((window as unknown as { __prompted?: number }).__prompted ?? 0) + 1 }
    Object.defineProperty(event, 'userChoice', { value: Promise.resolve({ outcome: choice, platform: 'web' }) })
    window.dispatchEvent(event)
  }, outcome)
}

test('install offer: the button shows the browser dialog, then hides once installed', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByRole('button', { name: /Install/ })).toHaveCount(0) // nothing offered yet
  await offerInstall(page, 'accepted')
  const install = page.getByRole('button', { name: 'Install ASTRA HEALTH on this device' })
  await install.click()
  expect(await page.evaluate(() => (window as unknown as { __prompted: number }).__prompted)).toBe(1)
  await expect(install).toHaveCount(0)
  // signed in, the header has no install button either (installed this session)
  await signIn(page, 'ast1')
  await expect(page.getByRole('button', { name: 'Install app' })).toHaveCount(0)
})

test('declined: the button goes until the browser offers again; header button works', async ({ page }) => {
  await signIn(page, 'ast1')
  await offerInstall(page, 'dismissed')
  const install = page.getByRole('button', { name: 'Install app' })
  await install.click()
  await expect(install).toHaveCount(0)
  await offerInstall(page, 'dismissed') // Chrome offers again later
  await expect(install).toBeVisible()
})

test('already running as the installed app: no button', async ({ page }) => {
  await page.addInitScript(() => {
    const real = window.matchMedia.bind(window)
    window.matchMedia = (q: string) => (q === '(display-mode: standalone)' ? { ...real(q), matches: true, media: q } as MediaQueryList : real(q))
  })
  await page.goto('/login')
  await offerInstall(page, 'accepted')
  await expect(page.getByRole('button', { name: /Install/ })).toHaveCount(0)
})

test.describe('iPhone Safari', () => {
  test.use({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  })
  test('shows how to add it to the home screen', async ({ page }) => {
    await page.goto('/login')
    const install = page.getByRole('button', { name: 'Install ASTRA HEALTH on this device' })
    await install.click()
    await expect(install).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByRole('note')).toContainText('Add to Home Screen')
  })
})
