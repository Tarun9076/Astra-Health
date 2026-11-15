import { expect, test } from '@playwright/test'
import { signIn } from './helpers'

// T-UI-10 (Step 14): the simplified astronaut screens. One answer first, quests, the body in words,
// no statistics jargon, a theme switch that is remembered, and short assistant answers.
test('home answers in words, with quests and the body at a glance', async ({ page }) => {
  await signIn(page, 'ast1')
  await page.goto('/astronaut/home')
  await expect(page.getByText(/^(You are doing well|Take it easy today|Get help now)$/)).toBeVisible()
  await expect(page.getByRole('heading', { name: "Today's quests" })).toBeVisible()
  await expect(page.getByRole('progressbar', { name: "Today's quests done" })).toBeVisible()
  const body = page.getByRole('region', { name: 'Your body today' })
  await expect(body.getByRole('link')).toHaveCount(6)
  await expect(body.getByRole('link', { name: /Heart/ })).toContainText(/Normal|A bit (high|low)|Very (high|low)|Measure again|Check again|No reading yet/)
  const text = await page.locator('main').innerText()
  expect(text).not.toMatch(/σ|sigma|z-score|anomaly model/i)
  // details are one tap away
  await page.getByText('See the numbers').click()
  await expect(page.getByRole('link', { name: 'Charts of every measurement' })).toBeVisible()
})

test('the dark theme switch is remembered', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await signIn(page, 'ast1')
  const html = page.locator('html')
  await expect(html).toHaveAttribute('data-theme', 'light')
  const toggle = page.getByRole('button', { name: 'Dark theme' })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await expect(html).toHaveAttribute('data-theme', 'dark')
  await page.reload()
  await expect(html).toHaveAttribute('data-theme', 'dark')
  await expect(page.getByRole('button', { name: 'Dark theme' })).toHaveAttribute('aria-pressed', 'true')
})

test('the assistant answers short first, with steps and details folded', async ({ page }) => {
  await signIn(page, 'ast1')
  await page.goto('/astronaut/assistant')
  await page.getByRole('button', { name: 'Why am I so tired?' }).click()
  const answer = page.locator('div.rounded-bl-sm').last()
  await expect(answer.getByText('What helps', { exact: true })).toBeVisible()
  const short = (await answer.locator('p').first().innerText()).trim()
  expect(short.split(/\s+/).length).toBeLessThanOrEqual(40)
  expect(short).not.toMatch(/σ/)
  await expect(answer.getByText('More detail')).toBeVisible()
})
