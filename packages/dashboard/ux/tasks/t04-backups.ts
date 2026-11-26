import type { UxTask } from '../checks/types'
import { openApp, openTab, seen } from './assert'

export const backups: UxTask = {
	id: 't04-backups',
	persona: 'operator',
	kind: 'secondary',
	goal: 'When was notes prod last backed up, and are daily backups on?',
	success: "prod's backups and the daily backup setting are shown.",
	start: '/apps',
	budget: { clicks: 2, fills: 0, keyPresses: 0, states: 3 },
	mutates: false,
	run: async (page, actor) => {
		await openApp(page, actor)
		await openTab(page, actor, 'Data')
		await page.waitForURL(/\/apps\/notes\/data\/prod$/)
		await seen(page.getByRole('heading', { name: 'Backups' }), 'backups')
		await seen(page.getByText('Daily backups'), 'daily backup setting')
	},
}
