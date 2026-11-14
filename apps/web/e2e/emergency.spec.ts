import { expect, test } from '@playwright/test'
import { signIn } from './helpers'

// A red-flag symptom typed into the assistant shows the emergency protocol at once (checked before
// any AI) and raises an Urgent alert for the flight surgeon.
test('reporting chest pain shows the emergency protocol and an Urgent alert', async ({ page }) => {
  await signIn(page, 'ast2')
  await page.goto('/astronaut/assistant')
  await page.getByLabel('Your question').fill('I have chest pain and feel short of breath')
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(page.getByRole('alert').first()).toBeVisible()

  await page.goto('/astronaut/alerts')
  await expect(page.getByText('Urgent').first()).toBeVisible()
  await expect(page.getByText(/chest pain/i).first()).toBeVisible()
})
