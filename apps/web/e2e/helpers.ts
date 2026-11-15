import { expect, type Page } from '@playwright/test'

export const PASSWORDS: Record<string, string> = {
  ast1: 'astra-demo-ast1',
  ast2: 'astra-demo-ast2',
  ast3: 'astra-demo-ast3',
  surgeon1: 'astra-demo-surgeon',
  admin: 'astra-demo-admin',
}

/** Sign in through the real login form. */
export async function signIn(page: Page, username: string): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Password').fill(PASSWORDS[username])
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).not.toHaveURL(/\/login$/)
}

/** Range inputs cannot be filled: set the value the way React expects (native setter + input event). */
export async function setSlider(page: Page, label: string, value: number): Promise<void> {
  await page.getByLabel(label, { exact: true }).evaluate((el, v) => {
    const input = el as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, String(v))
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, value)
  await expect(page.getByLabel(label, { exact: true })).toHaveValue(String(value))
}

export async function next(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Next' }).click()
}

/** Mark one measurement group as not measured today (explicit, never silently "normal"). */
export async function notMeasured(page: Page, group: string): Promise<void> {
  await page.getByRole('button', { name: `Not measured today : ${group}` }).click()
}

/** Bearer token of the signed-in user (from the persisted auth store). */
export async function token(page: Page): Promise<string> {
  const raw = await page.evaluate(() => window.localStorage.getItem('astra-auth'))
  const parsed = JSON.parse(raw ?? '{}') as { state?: { token?: string } }
  if (!parsed.state?.token) throw new Error('not signed in')
  return parsed.state.token
}

/** Number of raw readings of one indicator for an astronaut (straight from the API). */
export async function countReadings(page: Page, code: string, indicator: string): Promise<number> {
  const r = await page.request.get(`/api/astronauts/${code}/measurements?indicator=${indicator}&bucket=raw`, {
    headers: { Authorization: `Bearer ${await token(page)}` },
  })
  expect(r.ok()).toBeTruthy()
  const body = (await r.json()) as { points: unknown[] }
  return body.points.length
}
