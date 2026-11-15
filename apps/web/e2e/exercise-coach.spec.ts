import { expect, test } from '@playwright/test'
import { signIn } from './helpers'

// T-UI-08 (Step 13): the exercise coach. The camera cannot be used in an automated browser, so the
// workout is done by the simulated person (demo playback, 20× speed); rests are skipped.
test('exercise coach: plan from condition, demo workout counted and saved', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, 'ast1')
  await page.goto('/astronaut/wellness')
  await page.getByRole('link', { name: 'Start a coached workout' }).click()
  await expect(page.getByRole('heading', { name: 'Exercise coach' })).toBeVisible()
  await expect(page.getByText('The video stays on this device')).toBeVisible()
  await expect(page.getByRole('listitem').filter({ hasText: 'Squat' }).first()).toContainText('reps')

  // no camera in the test browser: a clear message and a way out
  await page.getByRole('button', { name: 'Start with the camera' }).click()
  await expect(page.getByRole('alert')).toContainText(/camera/i)
  await page.getByRole('button', { name: 'Back to the plan' }).click()

  await page.goto('/astronaut/wellness/exercise?speed=20')
  await page.getByRole('button', { name: 'Demo playback (simulated person)' }).click()
  await expect(page.getByText(/Demo playback · simulated person/)).toBeVisible()
  const coach = page.getByRole('complementary', { name: 'Coach' })
  await expect(coach.getByLabel(/^[1-9]\d* of 10 reps$/)).toBeVisible({ timeout: 30_000 })

  // skip each rest as it comes, until the workout is complete
  const done = page.getByRole('heading', { name: 'Workout complete' })
  while (!(await done.isVisible())) {
    const skip = page.getByRole('button', { name: 'Skip rest' })
    if (await skip.isVisible()) await skip.click()
    await page.waitForTimeout(250)
  }
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible()
  const table = page.getByRole('table')
  await expect(table.getByRole('row')).toHaveCount(4) // header + squat, deadlift, heel raise
  await expect(page.getByText('Tips for next time')).toBeVisible()
  await expect(page.getByText(/Squat: Go lower/)).toBeVisible()
  await expect(page.getByText('Demo playback: saved as simulated data.')).toBeVisible()

  await page.getByRole('button', { name: 'Back to the plan' }).click()
  await expect(page.getByText('Done today: 1 session.')).toBeVisible()
  await expect(page.getByText('Demo playback (simulated)').first()).toBeVisible()
})
