import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { signIn } from './helpers'

// Accessibility pass (Step 11): no serious or critical WCAG 2.1 A/AA violations on the main pages.
const PAGES = ['overview', 'checkin', 'body', 'analytics', 'assistant', 'wellness', 'alerts', 'reports']

async function expectNoSeriousViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .exclude('canvas') // the 3D body model is decorative; the 2D map and the list carry the content
    .analyze()
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  const summary = serious.map(
    (v) => `${v.id} (${v.impact}): ${v.nodes.length}× e.g. ${v.nodes[0]?.target.join(' ')} — ${v.help}`,
  )
  expect(summary, summary.join('\n')).toEqual([])
}

test('login page', async ({ page }) => {
  await page.goto('/login')
  await expectNoSeriousViolations(page)
})

for (const path of PAGES) {
  test(`astronaut ${path}`, async ({ page }) => {
    await signIn(page, 'ast1')
    await page.goto(`/astronaut/${path}`)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await page.waitForLoadState('networkidle')
    await expectNoSeriousViolations(page)
  })
}

test('flight surgeon crew view', async ({ page }) => {
  await signIn(page, 'surgeon1')
  await page.goto('/staff')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await page.waitForLoadState('networkidle')
  await expectNoSeriousViolations(page)
})
