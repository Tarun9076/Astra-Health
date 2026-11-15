import { expect, test } from '@playwright/test'
import { signIn } from './helpers'

// T-UI-09 (Step 13): the live camera path with Chrome's fake camera (a test pattern, no person).
// Proves the body-tracking engine and model load from the app itself and run on the video, and that
// the coach asks the person to step into view. Counting reps on real video is checked by hand.
test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  permissions: ['camera'],
})

test('exercise coach: the camera starts, body tracking runs and asks to step into view', async ({ page }) => {
  test.setTimeout(120_000)
  const engine: string[] = []
  page.on('response', (r) => {
    if (/\/(mediapipe\/wasm|models)\//.test(r.url())) engine.push(`${r.status()} ${new URL(r.url()).pathname}`)
  })
  await signIn(page, 'ast1')
  await page.goto('/astronaut/wellness/exercise')
  await page.getByRole('button', { name: 'Start with the camera' }).click()
  await expect(page.getByText('Camera · stays on this device')).toBeVisible()
  await expect(page.getByText('Step back so the camera sees your whole body, head to feet.').first()).toBeVisible({ timeout: 90_000 })
  expect(engine).toContain('200 /models/pose_landmarker_full.task')
  expect(engine.some((e) => e.startsWith('200 /mediapipe/wasm/') && e.endsWith('.wasm'))).toBe(true)
  await page.getByRole('button', { name: 'End workout' }).click()
  await expect(page.getByText('No reps were counted, so there is nothing to save.')).toBeVisible()
})
