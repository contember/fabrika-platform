import type { UxTask } from '../checks/types'
import { openApp, seen } from './assert'

export const incident: UxTask = {
	id: 't03-incident',
	persona: 'operator',
	kind: 'main',
	goal: 'notes prod misbehaves. Find what state it is in and the place where you would recover it or set maintenance.',
	success: "prod's Data page is open with its state and its operations.",
	start: '/apps',
	budget: null,
	mutates: false,
	run: async (page, actor) => {
		await openApp(page, actor)
		await actor.click(page.locator('.app-env-states').getByRole('link', { name: /^prod/ }))
		await page.waitForURL(/\/apps\/notes\/data\/prod$/)
		await seen(page.getByRole('heading', { name: 'Operations' }), 'operations of prod')
	},
}
