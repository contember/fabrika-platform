import type { UxTask } from '../checks/types'
import { environmentRow, openApp, seen } from './assert'

export const errors: UxTask = {
	id: 't11-errors',
	persona: 'developer',
	kind: 'main',
	goal: "See notes prod's open errors.",
	success: 'The list of open errors of notes prod is shown.',
	start: '/apps',
	budget: null,
	mutates: false,
	run: async (page, actor) => {
		await openApp(page, actor)
		await actor.click(environmentRow(page, 'prod').getByRole('link', { name: /open$/ }))
		await page.waitForURL(/\/operations\/errors/)
		await seen(page.locator('.workspace tr').nth(1), 'an error row')
	},
}
