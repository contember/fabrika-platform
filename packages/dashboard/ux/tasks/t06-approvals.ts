import type { UxTask } from '../checks/types'
import { aboveFold, openApp, openTab, seen } from './assert'

export const approvals: UxTask = {
	id: 't06-approvals',
	persona: 'approver',
	kind: 'main',
	goal: 'Find what waits for your decision on notes, and which kinds of change need approval on prod.',
	success: "The waiting deploy and prod's approval rules are shown.",
	start: '/apps',
	budget: { clicks: 2, fills: 0, keyPresses: 0, states: 3 },
	mutates: false,
	run: async (page, actor) => {
		await openApp(page, actor)
		await openTab(page, actor, 'Approvals')
		await seen(page.getByRole('heading', { name: 'Waiting for a decision' }), 'waiting decision')
		await seen(page.getByRole('link', { name: /Review/ }), 'review link')
		const prod = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'prod', exact: true }) })
		await aboveFold(page, prod.locator('.policy-summary'), "prod's rules")
	},
}
