import { expect, test } from '@playwright/test'
import { next, notMeasured, signIn } from './helpers'

// A real 1×1 PNG: the page decodes and re-encodes it as JPEG before sending.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

// The problem statement's gaps: blood sugar in the check-in, camera images, gamification, environments.
test('check-in with blood sugar and a photo, then progress and the environment on Home', async ({ page }) => {
  await signIn(page, 'ast2')
  await page.goto('/astronaut/checkin')
  await notMeasured(page, 'Resting heart rate')
  await next(page)
  await notMeasured(page, 'Blood pressure')
  await next(page)
  await notMeasured(page, 'Body temperature')
  await notMeasured(page, 'Oxygen saturation')
  await next(page)

  // blood sugar: a dangerous value shows the safety advice at once
  await expect(page.getByRole('heading', { name: 'Blood sugar' })).toBeVisible()
  await expect(page.getByText('How to measure').first()).toBeVisible()
  const sugar = page.getByRole('spinbutton', { name: 'Blood sugar' })
  await sugar.fill('50')
  await expect(page.getByText(/Very low blood sugar/)).toBeVisible()
  await expect(page.getByRole('link', { name: 'Open emergency procedures' })).toBeVisible()
  await sugar.fill('96')
  await notMeasured(page, 'Body mass')
  await next(page)
  await next(page) // sleep
  await next(page) // mood and energy
  await next(page) // stress

  // symptoms + a photo for the flight surgeon
  await page.getByRole('button', { name: 'No symptoms today' }).click()
  await page.getByRole('combobox', { name: /What does it show/ }).selectOption('Skin')
  await page.getByRole('textbox', { name: /Short note/ }).fill('Rash on left forearm')
  await page.locator('input[type=file]').setInputFiles({ name: 'rash.png', mimeType: 'image/png', buffer: Buffer.from(PNG, 'base64') })
  await expect(page.getByRole('img', { name: 'Photo 1: Skin, Rash on left forearm' })).toBeVisible()
  await next(page)
  await expect(page.getByRole('row', { name: /Blood sugar/ })).toContainText('96 mg/dL')
  await expect(page.getByRole('row', { name: /Photos/ })).toContainText('1 photo')
  await page.getByRole('button', { name: 'Submit check-in' }).click()

  await expect(page.getByText(/Check-in saved in \d+ s/)).toBeVisible()
  await expect(page.getByText('1 photo added to your health record for the flight surgeon.')).toBeVisible()
  await expect(page.getByText(/Check-in streak: \d+ days? in a row · \+10 points/)).toBeVisible()

  // the photo is in the health history
  await page.goto('/astronaut/history')
  await expect(page.getByText('Photo added: Skin')).toBeVisible()
  await expect(page.getByRole('img', { name: 'Photo added: Skin: Rash on left forearm' })).toBeVisible()

  // Home: progress and the environment
  await page.goto('/astronaut/home')
  await expect(page.getByRole('heading', { name: "Today's quests" })).toBeVisible()
  await expect(page.getByText(/^Level \d+ · /)).toBeVisible()
  await expect(page.getByText(/\d+-day streak/)).toBeVisible()
  await expect(page.getByText('Mars surface stay', { exact: true })).toBeVisible()
  await page.getByText('What matters for your health here').click()
  await expect(page.getByText('Adapting to Mars gravity')).toBeVisible()

  // badges
  await page.getByRole('link', { name: /^\d+ badges?$/ }).click()
  await expect(page).toHaveURL(/\/astronaut\/wellness#progress$/)
  await expect(page.getByRole('heading', { name: 'Progress and badges' })).toBeVisible()
  await expect(page.getByText('First check-in, earned')).toBeAttached()
  await expect(page.getByText(/Points reward what you do, never your readings/).first()).toBeVisible()
})

test('the demo operator switches the mission environment and the crew sees it', async ({ page, browser }) => {
  await signIn(page, 'admin')
  await page.goto('/staff/sim')
  const iss = page.getByRole('radio', { name: /International Space Station/ })
  await iss.click()
  await expect(iss).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByText(/from the environment/)).toBeVisible()

  const crew = await browser.newContext()
  const astronaut = await crew.newPage()
  await signIn(astronaut, 'ast3')
  await astronaut.goto('/astronaut/home')
  await expect(astronaut.getByText('International Space Station', { exact: true })).toBeVisible()
  await expect(astronaut.getByText(/weightless · you can talk to Earth live/)).toBeVisible()
  await astronaut.getByText('What matters for your health here').click()
  await expect(astronaut.getByText('Bone and muscle loss.')).toBeVisible()
  await crew.close()

  // back to the default for the other tests
  const mars = page.getByRole('radio', { name: /Mars surface stay/ })
  await mars.click()
  await expect(mars).toHaveAttribute('aria-checked', 'true')
})
