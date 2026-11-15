import { expect, test } from '@playwright/test'
import { next, notMeasured, signIn } from './helpers'

// A red-flag symptom typed into the assistant shows the emergency protocol at once (checked before
// any AI) and raises an Urgent alert for the flight surgeon.
test('reporting chest pain to the assistant shows the protocol and an Urgent alert', async ({ page }) => {
  await signIn(page, 'ast2')
  await page.goto('/astronaut/assistant')
  await page.getByLabel('Your question').fill('I have chest pain and feel short of breath')
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(page.getByRole('alert').first()).toBeVisible()

  await page.goto('/astronaut/alerts') // old link: redirected to My Guidance → Health alerts
  await expect(page).toHaveURL(/\/astronaut\/guidance\/alerts/)
  await expect(page.getByText('Urgent').first()).toBeVisible()
  await expect(page.getByText(/chest pain/i).first()).toBeVisible()
})

// The same red-flag symptom chosen in the check-in: emergency steps shown before sending, Urgent alert after.
test('a red-flag symptom in the check-in raises an Urgent alert with the procedure', async ({ page }) => {
  await signIn(page, 'ast3')
  await page.goto('/astronaut/checkin')
  await notMeasured(page, 'Resting heart rate')
  await next(page)
  await notMeasured(page, 'Blood pressure')
  await next(page)
  await notMeasured(page, 'Body temperature')
  await notMeasured(page, 'Oxygen saturation')
  await next(page)
  await notMeasured(page, 'Blood sugar')
  await notMeasured(page, 'Body mass')
  await next(page)
  await next(page)
  await next(page)
  await next(page)
  await page.getByLabel('Fainting or nearly fainting').check()
  await expect(page.getByRole('alert').filter({ hasText: /faint/i }).first()).toBeVisible()
  await next(page)
  await expect(page.getByRole('row', { name: /Symptoms/ })).toContainText('Fainting or nearly fainting')
  await page.getByRole('button', { name: 'Submit check-in' }).click()

  await expect(page.getByText(/Check-in saved in \d+ s/)).toBeVisible()
  await expect(page.getByText('Fainting reported').first()).toBeVisible()
  await page.getByRole('link', { name: 'Home', exact: true }).first().click()
  await expect(page.getByText('Urgent: act now')).toBeVisible()
  await expect(page.getByRole('link', { name: /Open emergency procedure/ })).toBeVisible()
})
