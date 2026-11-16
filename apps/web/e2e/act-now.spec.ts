import { expect, test, type Page } from '@playwright/test'
import { next, notMeasured, signIn, token } from './helpers'

// T-UI-15 (Step 21): treatment at check-in and Act Now, as drills.
// 1. A check-in with very low blood sugar opens Act Now at once; the steps, the exact dose, the repeat
//    protection and the timers work; the whole log reaches the server.
// 2. Help now for a crewmate rings the crew alarm on the other devices; another device continues it.
// 3. With the Habitat server down the plan is made on the device; the log waits and is sent once.

async function episodes(page: Page, code: string) {
  const t = await token(page)
  return page.evaluate(async ([c, tk]) => {
    const r = await fetch(`/api/treatment/episodes?astronaut=${c}`, { headers: { Authorization: `Bearer ${tk}` } })
    return (await r.json()) as { id: string; status: string; source: string; events: { kind: string; data: Record<string, unknown> }[] }[]
  }, [code, t] as const)
}

const step = (page: Page) => page.locator('section[aria-live="polite"]')

test('very low blood sugar at check-in → Act Now, exact dose, no early repeat, full log on the server', async ({ page }) => {
  await signIn(page, 'ast3')
  await page.goto('/astronaut/checkin')
  await notMeasured(page, 'Resting heart rate')
  await next(page)
  await notMeasured(page, 'Blood pressure')
  await next(page)
  await notMeasured(page, 'Body temperature')
  await notMeasured(page, 'Oxygen saturation')
  await next(page)
  await page.locator('#field-glucose').fill('45')
  await notMeasured(page, 'Body mass')
  await next(page)
  await next(page) // sleep
  await next(page) // mood
  await next(page) // stress
  await page.getByRole('button', { name: 'No symptoms today' }).click()
  await next(page)
  const t0 = Date.now()
  await page.getByRole('button', { name: 'Submit check-in' }).click()

  // the first action is on screen within seconds, with nothing to tap in between, and help is already told
  await expect(page.getByRole('heading', { name: 'Low blood sugar', level: 1 })).toBeVisible()
  await expect(step(page)).toContainText('Can you chew and swallow safely right now?')
  expect(Date.now() - t0).toBeLessThan(5_000)
  await expect(page).toHaveURL(/\/astronaut\/act$/)
  await expect(page.getByText('The crew and Earth have been told automatically.')).toBeVisible()

  // three taps to the sugar: yes → (dose card) Done
  await step(page).getByRole('button', { name: 'Yes' }).click()
  await expect(step(page)).toContainText('Chew 4 tablets (16 g)')
  await expect(step(page)).toContainText('Emergency kit, pocket E1')
  await step(page).getByRole('button', { name: 'Done' }).click()

  // recheck: the timer runs; "Check now" if getting worse; still low → back to the swallow question
  await expect(step(page).getByRole('timer')).toBeVisible()
  await step(page).getByRole('button', { name: /Check now/ }).click()
  await expect(step(page)).toContainText('Target: at least 70 mg/dL')
  await step(page).getByLabel(/Blood sugar now/).fill('52')
  await step(page).getByRole('button', { name: 'Save' }).click()
  await step(page).getByRole('button', { name: 'Yes' }).click()
  // the same medicine again only after its minimum interval (15 min): blocked on the screen
  await expect(step(page).getByRole('note')).toContainText('the next dose is safe from')
  await expect(step(page).getByRole('button', { name: 'Done' })).toBeDisabled()
  await step(page).getByRole('button', { name: "I can't take it: next step" }).click()

  // no safe sugar now → glucagon, on your own
  await expect(step(page)).toContainText('Inject glucagon into your outer thigh')
  await expect(step(page)).toContainText('Inject 1 injection (1 mg)')
  await step(page).getByRole('button', { name: 'Done' }).click()
  await step(page).getByRole('button', { name: 'Done' }).click() // lie on your side
  await step(page).getByRole('button', { name: /Check now/ }).click()
  await step(page).getByLabel(/Blood sugar now/).fill('84')
  await step(page).getByRole('button', { name: 'Save' }).click()
  await step(page).getByRole('button', { name: 'Done' }).click() // awake: sugar and a snack
  await expect(page.getByRole('heading', { name: 'All steps done' })).toBeVisible()
  await page.getByLabel(/How do you feel now/).fill('Awake, 84 mg/dL')
  await page.getByRole('button', { name: 'Finish' }).click()
  await expect(page.getByRole('heading', { name: /Treatment finished/ })).toBeVisible()

  await expect.poll(async () => (await episodes(page, 'AST-003'))[0]?.status).toBe('Resolved') // 'resolved' is sent last
  const [e] = await episodes(page, 'AST-003')
  expect(e.source).toBe('checkin')
  expect(e.events.filter((x) => x.kind === 'dose_given').map((x) => x.data.medicineId)).toEqual(['glucosetabs', 'glucagon'])
  expect(e.events.filter((x) => x.kind === 'recheck').map((x) => x.data.result)).toEqual(['failed', 'passed'])
})

test('Help now rings the crew alarm; another crew device continues the treatment', async ({ page, browser }) => {
  await signIn(page, 'ast3') // the crewmate's device, on Home
  const patient = await (await browser.newContext()).newPage()
  await signIn(patient, 'ast1')
  await patient.getByRole('link', { name: 'Help now' }).click()
  await patient.getByRole('button', { name: /^Severe allergic reaction/ }).click()
  await expect(step(patient)).toContainText('Inject 1 auto-injector (0.3 mg)')
  await expect(step(patient)).toContainText('pre-approved for this emergency') // the expired injector is still given

  const alarm = page.getByRole('alert').filter({ hasText: 'needs help' })
  await expect(alarm).toContainText('Cmdr. A. Rao (simulated) needs help: Severe allergic reaction', { timeout: 15_000 })
  await alarm.getByRole('link', { name: 'Open the treatment' }).click()
  await expect(page.getByRole('heading', { name: /Cmdr\. A\. Rao.*Severe allergic reaction/ })).toBeVisible()
  await page.getByRole('button', { name: 'Continue this treatment on this device' }).click()
  await expect(step(page)).toContainText('Inject epinephrine into your outer thigh now')
})

test('server down: the plan is made on the device, the log waits and is sent once', async ({ page }) => {
  await signIn(page, 'ast3')
  await page.goto('/astronaut/act')
  await expect(page.getByRole('button', { name: /^Chest pain/ })).toBeVisible()
  await page.route('**/api/**', (route) => route.abort('connectionrefused'))

  await page.getByRole('button', { name: /^Chest pain/ }).click()
  await expect(page.getByText('planned on this device (server not reachable)')).toBeVisible()
  await step(page).getByRole('button', { name: 'No' }).click() // no stroke signs
  await expect(step(page)).toContainText('Chew 4 tablets (324 mg)')
  await step(page).getByRole('button', { name: 'Done' }).click()

  // a reload (or a crash) resumes at the same step
  await page.reload()
  await expect(step(page)).toContainText('Stop everything. Sit or lie down')

  // the server is back: everything logged on the device is sent, once
  await page.unroute('**/api/**')
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(page.getByText(/Sent \d+ saved item\(s\)/)).toBeVisible({ timeout: 20_000 })
  const [e] = await episodes(page, 'AST-003')
  expect(e.source).toBe('device')
  expect(e.events.map((x) => x.kind)).toEqual(['answer', 'dose_given'])
  expect(e.events[1].data).toMatchObject({ medicineId: 'aspirin81', units: 4 })
})
