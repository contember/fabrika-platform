import type { Locator, Page } from 'playwright'
import type { Actor } from '../checks/actor'

const TIMEOUT_MS = 10_000

/** Waits until the locator shows: a task's success check. */
export async function seen(target: Locator, what: string): Promise<void> {
	try {
		await target.first().waitFor({ state: 'visible', timeout: TIMEOUT_MS })
	} catch {
		throw new Error(`not visible: ${what}`)
	}
}

/** The element shows in the first viewport without scrolling. */
export async function aboveFold(page: Page, target: Locator, what: string): Promise<void> {
	await seen(target, what)
	const box = await target.first().boundingBox()
	const height = page.viewportSize()?.height ?? 0
	const scrolled = await page.evaluate(() => window.scrollY)
	if (box === null || box.y + scrolled >= height) throw new Error(`below the fold: ${what}`)
}

/** The seeded application every task works on (`bun run local:seed`). */
export const APP = 'notes'

/** From the Applications list into the application's page: the path every task starts with. */
export async function openApp(page: Page, actor: Actor): Promise<void> {
	await actor.click(page.locator('.workspace').getByRole('link', { name: APP, exact: true }).first())
}

export async function openTab(page: Page, actor: Actor, tab: string): Promise<void> {
	await actor.click(page.locator('.page-tabs').getByRole('link', { name: tab }))
}

/** An environment's row in a table of the application page. */
export const environmentRow = (page: Page, env: string): Locator =>
	page.locator('.workspace tr').filter({ has: page.locator('td').first().getByText(env, { exact: true }) })
