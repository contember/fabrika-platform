import type { UxTask } from '../checks/types'
import { environmentRow, openApp, seen } from './assert'

export const errors: UxTask = {
	id: 't11-errors',
	persona: 'developer',
	kind: 'main',
	goal: "See notes prod's open errors.",
	success: 'The list of open errors of notes prod is shown.',
	start: '/apps',
	budget: { clicks: 2, fills: 0, keyPresses: 0, states: 3 },
	mutates: false,
	run: async (page, actor) => {
		await openApp(page, actor)
		await actor.click(environmentRow(page, 'prod').getByRole('link', { name: /open$/ }))
		await page.waitForURL(/\/operations\/errors\?.*source=/)
		await seen(page.locator('.workspace a[href*="/operations/errors/"]'), 'an error of notes prod')
	},
}
