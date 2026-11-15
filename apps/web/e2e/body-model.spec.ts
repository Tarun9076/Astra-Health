import { expect, test } from '@playwright/test'
import { signIn } from './helpers'

// The human body figure (flat and 3D), drawn from the same anatomy model.
test('the body figure: click parts in the flat drawing, then turn and focus the 3D body', async ({ page }) => {
  await signIn(page, 'ast1')
  await page.goto('/astronaut/health')
  const map = page.getByRole('group', { name: 'Body map' })
  await expect(map.getByRole('button')).toHaveCount(9) // 8 systems + the whole body (skin)

  // the heart sits in front of the middle of the lungs, so click the right lung (left of the picture)
  const lungs = map.getByRole('button', { name: /^Lungs & breathing/ })
  const box = (await lungs.boundingBox())!
  await lungs.click({ position: { x: box.width * 0.18, y: box.height * 0.5 } })
  await expect(page.getByRole('heading', { level: 2, name: 'Lungs and breathing' })).toBeVisible()
  await map.getByRole('button', { name: /^Whole body \(radiation\)/ }).click()
  await expect(page).toHaveURL(/region=whole_body/)
  // keyboard
  await map.getByRole('button', { name: /^Bones/ }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { level: 2, name: 'Bones' })).toBeVisible()

  // 3D: the body is built in a worker, then the view controls work
  await page.getByRole('group', { name: 'Diagram type' }).getByRole('button', { name: '3D' }).click()
  await expect(page.locator('canvas')).toBeVisible()
  const controls = page.getByRole('group', { name: '3D view controls' })
  const turn = controls.getByRole('button', { name: 'Turn' })
  await expect(turn).toBeVisible()
  await turn.click()
  await expect(turn).toHaveAttribute('aria-pressed', 'false')
  await controls.getByRole('button', { name: 'Side' }).click()
  const skin = controls.getByRole('button', { name: 'Skin' })
  await skin.click()
  await expect(skin).toHaveAttribute('aria-pressed', 'false')
  // choosing a system from the list moves the 3D view to it
  await page.getByRole('list', { name: 'Choose a body system' }).getByRole('button', { name: /Heart and circulation/ }).click()
  await expect(page.getByText(/Showing\s*Heart and circulation/)).toBeVisible()
})
