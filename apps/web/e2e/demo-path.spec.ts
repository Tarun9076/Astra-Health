import { expect, test } from '@playwright/test'
import { next, notMeasured, setSlider, signIn } from './helpers'

// T-UI-01: the astronaut demo path. Sign in, finish the guided daily check-in in under 60 s, see the
// findings it raised, and find them again in Health alerts and on Home.
test('astronaut completes the guided check-in and sees the result', async ({ page }) => {
  await signIn(page, 'ast1')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Cmdr. A. Rao')

  await page.getByRole('link', { name: /Daily Check-in/ }).first().click()
  await expect(page.getByRole('heading', { name: 'Daily check-in' })).toBeVisible()
  const started = Date.now()

  // 1 heart rate: far above this astronaut's normal → asked to re-measure or keep
  await page.getByRole('spinbutton', { name: 'Resting heart rate' }).fill('96')
  await expect(page.getByText(/much higher than your normal/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled()
  await page.getByRole('button', { name: 'Keep this value' }).click()
  await next(page)
  // 2 blood pressure: skipped explicitly
  await notMeasured(page, 'Blood pressure')
  await next(page)
  // 3 temperature + oxygen
  await page.getByRole('spinbutton', { name: 'Temperature' }).fill('36.9')
  await notMeasured(page, 'Oxygen saturation')
  await next(page)
  // 4–6 sleep, mood and energy, stress
  await setSlider(page, 'Hours slept last night', 4)
  await setSlider(page, 'Sleep quality', 3)
  await next(page)
  await setSlider(page, 'Mood', 3)
  await setSlider(page, 'Fatigue', 9)
  await next(page)
  await setSlider(page, 'Stress', 8)
  await next(page)
  // 7 symptoms
  await page.getByRole('button', { name: 'No symptoms today' }).click()
  await next(page)
  // 8 review: skipped items are shown as missing, not normal
  await expect(page.getByRole('row', { name: /Blood pressure/ })).toContainText('Not measured today')
  await expect(page.getByRole('row', { name: /Resting heart rate/ })).toContainText('96 bpm')
  await page.getByRole('button', { name: 'Submit check-in' }).click()

  const saved = page.getByText(/Check-in saved in \d+ s/)
  await expect(saved).toBeVisible()
  const seconds = Number((await saved.textContent())?.match(/(\d+) s/)?.[1])
  expect(seconds).toBeLessThan(60)
  expect(Date.now() - started).toBeLessThan(60_000)
  await expect(page.getByText(/Not measured today: Blood pressure, Oxygen saturation/)).toBeVisible()

  // the fatigue story raises findings (rules decide; the page only shows them)
  await expect(page.getByText(/New findings|Updated findings/)).toBeVisible()
  const firstFinding = (await page.locator('li p.font-medium').first().textContent())?.trim() ?? ''
  expect(firstFinding).not.toBe('')

  await page.getByRole('link', { name: 'Open health alerts' }).click()
  await expect(page).toHaveURL(/\/astronaut\/guidance\/alerts/)
  await expect(page.getByText(firstFinding).first()).toBeVisible()

  await page.getByRole('link', { name: 'Home', exact: true }).first().click()
  await expect(page.getByText('Something to pay attention to')).toBeVisible()
  await expect(page.getByText(firstFinding).first()).toBeVisible()
  // the first observation is open and explains itself
  await expect(page.getByText('Why it matters').first()).toBeVisible()
  await expect(page.getByText('When to get medical help').first()).toBeVisible()
})
