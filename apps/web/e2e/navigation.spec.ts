import { expect, test } from '@playwright/test'
import { signIn } from './helpers'

const NAV = [
  { label: 'Home', url: /\/astronaut\/home$/, heading: /Good (morning|afternoon|evening)/ },
  { label: 'My Health', url: /\/astronaut\/health$/, heading: 'My Health' },
  { label: 'Daily Check-in', url: /\/astronaut\/checkin$/, heading: 'Daily check-in' },
  { label: 'My Guidance', url: /\/astronaut\/guidance$/, heading: 'My Guidance' },
  { label: 'Wellness', url: /\/astronaut\/wellness$/, heading: 'Wellness' },
  { label: 'Health History', url: /\/astronaut\/history$/, heading: 'Health History' },
  { label: 'AI Assistant', url: /\/astronaut\/assistant$/, heading: 'AI Assistant' },
  { label: 'Emergency procedures', url: /\/astronaut\/emergency$/, heading: 'Emergency procedures' },
]

test('every item in the side navigation opens its page', async ({ page }) => {
  await signIn(page, 'ast1')
  for (const n of NAV) {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: new RegExp(`^${n.label}`) }).click()
    await expect(page).toHaveURL(n.url)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(n.heading)
  }
})

test('tabs, filters and old links work', async ({ page }) => {
  await signIn(page, 'ast1')
  await page.goto('/astronaut/health')
  await page.getByRole('button', { name: /Lungs and breathing/ }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'Lungs and breathing' })).toBeVisible()
  await expect(page.getByText('Symptoms to watch for')).toBeVisible()

  await page.getByRole('link', { name: 'Trends and charts' }).click()
  await page.getByRole('button', { name: 'Mood and stress' }).click()
  await expect(page.getByText('What changed · Mood')).toBeVisible()
  await expect(page.getByText('What changed · Stress')).toBeVisible()

  await page.goto('/astronaut/history')
  await page.getByRole('button', { name: 'Alerts' }).click()
  await expect(page.getByText(/event(s)? since/)).toBeVisible()

  await page.goto('/astronaut/analytics') // pre-redesign link
  await expect(page).toHaveURL(/\/astronaut\/health\/trends/)
})

test('on a phone the menu opens as a drawer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await signIn(page, 'ast1')
  await page.getByRole('button', { name: 'Open menu' }).click()
  const drawer = page.locator('#mobile-nav')
  await expect(drawer).toBeVisible()
  await drawer.getByRole('link', { name: /^Wellness/ }).click()
  await expect(page).toHaveURL(/\/astronaut\/wellness$/)
  await expect(drawer).toBeHidden()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})
