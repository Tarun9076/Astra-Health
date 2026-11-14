import { expect, test } from '@playwright/test'
import { setSlider, signIn } from './helpers'

// T-UI-01: the astronaut demo path. Sign in, finish the daily check-in in under 60 s, see the
// findings it raised, and find them again in the Alerts Center and on the overview.
test('astronaut completes a check-in and sees the result', async ({ page }) => {
  await signIn(page, 'ast1')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

  await page.goto('/astronaut/checkin')
  await expect(page.getByRole('heading', { name: 'Daily check-in' })).toBeVisible()
  const started = Date.now()

  await setSlider(page, 'Hours slept last night', 4)
  await setSlider(page, 'Sleep quality', 3)
  await page.getByRole('button', { name: 'Next' }).click()
  await setSlider(page, 'Mood', 3)
  await setSlider(page, 'Stress', 8)
  await setSlider(page, 'Fatigue', 9)
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByLabel(/Resting heart rate/).fill('96')
  await page.getByLabel(/Temperature/).fill('36.9')
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(page.getByText('9/10')).toBeVisible() // review step shows the answers
  await page.getByRole('button', { name: 'Submit check-in' }).click()

  const saved = page.getByText(/Check-in saved in \d+ s/)
  await expect(saved).toBeVisible()
  const seconds = Number((await saved.textContent())?.match(/(\d+) s/)?.[1])
  expect(seconds).toBeLessThan(60)
  expect(Date.now() - started).toBeLessThan(60_000)

  // the fatigue story raises findings (rules decide; the page only shows them)
  await expect(page.getByText(/New findings|Updated findings/)).toBeVisible()
  const firstFinding = (await page.locator('li p.font-medium').first().textContent())?.trim() ?? ''
  expect(firstFinding).not.toBe('')

  await page.getByRole('link', { name: 'Open Alerts Center' }).click()
  await expect(page).toHaveURL(/\/astronaut\/alerts/)
  await expect(page.getByText(firstFinding).first()).toBeVisible()

  await page.goto('/astronaut/overview')
  await expect(page.getByText(firstFinding).first()).toBeVisible()
})
