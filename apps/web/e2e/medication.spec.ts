import { expect, test, type Page } from '@playwright/test'
import { signIn } from './helpers'

// T-UI-14 (Step 20): the Medication Guide end to end, with the three roles:
// the astronaut answers the safety questions and asks; the CMO (ast2) confirms; the astronaut takes it;
// the flight surgeon reviews it. The dose comes from the medicine list, never from the AI.

async function answerAll(page: Page, yesTo?: string) {
  const questions = page.getByRole('group').filter({ has: page.getByRole('button', { name: /^No: / }) })
  await expect(questions.first()).toBeVisible()
  const n = await questions.count()
  for (let i = 0; i < n; i++) {
    const q = questions.nth(i)
    const text = (await q.locator('p').innerText()).trim()
    await q.getByRole('button', { name: `${yesTo && text.startsWith(yesTo) ? 'Yes' : 'No'}: ${text}` }).click()
  }
}

test('ask, confirm, take and review a medicine; an allergy blocks the first choice', async ({ page, browser }) => {
  await signIn(page, 'ast1')
  await page.getByRole('link', { name: /Medicines/ }).click()
  await expect(page.getByRole('heading', { name: 'Medicines', level: 1 })).toBeVisible()
  await expect(page.getByRole('note')).toContainText('Demo medicine list')
  await page.getByRole('button', { name: /^Back pain/ }).click()
  await expect(page.getByRole('button', { name: 'Answer every question first' })).toBeDisabled()
  await answerAll(page)
  await page.getByRole('button', { name: 'Check what I can take' }).click()

  // AST-001 is allergic to NSAIDs: ibuprofen (the first choice for back pain) is blocked
  await expect(page.getByText('Acetaminophen (paracetamol) 500 mg: 2 tablets (1000 mg)')).toBeVisible()
  const ibuprofen = page.getByRole('listitem').filter({ hasText: 'Ibuprofen 200 mg' })
  await expect(ibuprofen).toContainText('Not for you now')
  await expect(ibuprofen).toContainText('Allergy on record')
  await page.getByRole('button', { name: 'Ask the CMO to confirm' }).click()
  await expect(page.getByText('Sent to the crew medical officer')).toBeVisible()
  await expect(page.getByText('Waiting for the CMO: Acetaminophen (paracetamol): 2 tablets (1000 mg)')).toBeVisible()

  // the crew medical officer confirms it on their own device
  const cmo = await (await browser.newContext()).newPage()
  await signIn(cmo, 'ast2')
  await cmo.goto('/astronaut/medicine')
  const row = cmo.getByRole('listitem').filter({ hasText: 'Cmdr. A. Rao (simulated): Acetaminophen' })
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: 'Confirm' }).click()
  await expect(cmo.getByText('No crew member is waiting for a medicine.')).toBeVisible()

  // back to the astronaut: take it (the screen updates live)
  await expect(page.getByText('Take it now: Acetaminophen (paracetamol): 2 tablets (1000 mg)')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Medical kit, drawer A1').first()).toBeVisible()
  await page.getByRole('button', { name: 'I took it' }).click()
  await expect(page.getByText(/^Take it now/)).toHaveCount(0)
  await page.getByText('My medicine history').click()
  await expect(page.getByText(/Taken at/)).toBeVisible()

  // the flight surgeon reviews it. The test runs no Ground node, so Earth calls go to the Habitat here
  // (the two-node sync of doses and reviews is covered by the backend test T-MED-11).
  const surgeon = await (await browser.newContext()).newPage()
  await surgeon.route('**/ground-api/**', async (route) => {
    const response = await route.fetch({ url: route.request().url().replace('/ground-api/', '/api/') })
    await route.fulfill({ response })
  })
  await signIn(surgeon, 'surgeon1')
  await expect(surgeon.getByText(/Medicines to review \(\d+\)/)).toBeVisible()
  await surgeon.goto('/staff/astronaut/AST-001?view=medicines')
  await expect(surgeon.getByRole('button', { name: 'Mark reviewed' })).toBeVisible()
  // (a re-routed POST loses its body in the test browser, so the review is sent straight to the Habitat)
  const status = await surgeon.evaluate(async () => {
    const token = JSON.parse(sessionStorage.getItem('astra-auth') ?? localStorage.getItem('astra-auth') ?? '{}').state?.token
    const doses = await (await fetch('/api/medication/doses', { headers: { Authorization: `Bearer ${token}` } })).json()
    const mine = (doses as { id: string; astronautCode: string; medicineId: string }[])
      .find((d) => d.astronautCode === 'AST-001' && d.medicineId === 'acetaminophen')!
    const r = await fetch(`/api/medication/doses/${mine.id}/review`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ note: 'Seen, fine.' }),
    })
    return r.status
  })
  expect(status).toBe(200)
  await surgeon.reload()
  await expect(surgeon.getByText('Reviewed by Flight Surgeon (demo): “Seen, fine.”')).toBeVisible()
  await expect(surgeon.getByRole('checkbox', { name: 'Ibuprofen, aspirin or other NSAID pain relievers' })).toBeChecked()
})

test('a "yes" to a safety question stops the guide and shows the emergency steps', async ({ page }) => {
  await signIn(page, 'ast3')
  await page.goto('/astronaut/medicine?condition=headache')
  await answerAll(page, 'Do you have weakness')
  await page.getByRole('button', { name: 'Check what I can take' }).click()
  await expect(page.getByText('Stop: this needs help now')).toBeVisible()
  await expect(page.getByText(/Sudden neurological symptoms|neurolog/i).first()).toBeVisible()
  await expect(page.getByRole('button', { name: /Ask the CMO/ })).toHaveCount(0)
})

test('the AI assistant sends medicine questions to the guide, with no dose of its own', async ({ page }) => {
  await signIn(page, 'ast3')
  await page.goto('/astronaut/assistant')
  await page.getByRole('textbox').fill('What can I take for my headache?')
  await page.getByRole('button', { name: /Send/ }).click()
  const answer = page.locator('div.rounded-bl-sm').last()
  await expect(answer).toContainText('I don’t choose medicines myself'.replace('’', "'"))
  await expect(answer).not.toContainText(/\d+\s?(tablets?|capsules?|mg\b(?!\/))/)
  await answer.getByRole('link', { name: 'Open the Medication Guide: Headache' }).click()
  await expect(page).toHaveURL(/\/astronaut\/medicine\?condition=headache/)
  await expect(page.getByRole('heading', { name: 'Headache' })).toBeVisible()
})
