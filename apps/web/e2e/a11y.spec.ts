import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { signIn } from './helpers'

// Accessibility pass: no serious or critical WCAG 2.1 A/AA violations on every page.
const ASTRONAUT_PAGES = [
  'home', 'checkin', 'health', 'health/trends', 'guidance', 'guidance/alerts', 'wellness', 'wellness/exercise', 'history', 'history/reports',
  'assistant', 'emergency',
]

async function expectNoSeriousViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .exclude('canvas') // the optional 3D body model; the list and flat diagram carry the content
    .analyze()
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  const summary = serious.map((v) => {
    const nodes = v.nodes.slice(0, 6).map((n) => {
      const d = n.any[0]?.data as { fgColor?: string; bgColor?: string; contrastRatio?: number } | undefined
      const colours = d?.fgColor ? ` [${d.fgColor} on ${d.bgColor}, ${d.contrastRatio}:1]` : ''
      return `${n.target.join(' ')}${colours} "${n.html.slice(0, 80)}"`
    })
    return `${v.id} (${v.impact}): ${v.nodes.length}× ${v.help}\n    ${nodes.join('\n    ')}`
  })
  expect(summary, summary.join('\n')).toEqual([])
}

test('login page', async ({ page }) => {
  await page.goto('/login')
  await expectNoSeriousViolations(page)
})

for (const path of ASTRONAUT_PAGES) {
  test(`astronaut ${path}`, async ({ page }) => {
    await signIn(page, 'ast1')
    await page.goto(`/astronaut/${path}`)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await page.waitForLoadState('networkidle')
    await expectNoSeriousViolations(page)
  })
}

for (const path of ['', 'astronaut/AST-001', 'astronaut/AST-001?view=alerts', 'astronaut/AST-001?view=history']) {
  test(`flight surgeon /staff/${path}`, async ({ page }) => {
    await signIn(page, 'surgeon1')
    await page.goto(`/staff/${path}`)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await page.waitForLoadState('networkidle')
    await expectNoSeriousViolations(page)
  })
}
