import type { UxTask } from '../checks/types'
import { openApp, openTab, seen } from './assert'

export const reach: UxTask = {
	id: 't07-reach',
	persona: 'approver',
	kind: 'secondary',
	goal: 'Which endpoints of notes are public, and which roles reach the application?',
	success: "The application's surface and its access by role are shown.",
	start: '/apps',
	budget: { clicks: 2, fills: 0, keyPresses: 0, states: 3 },
	mutates: false,
	run: async (page, actor) => {
		await openApp(page, actor)
		await openTab(page, actor, 'Access')
		await seen(page.getByRole('heading', { name: 'Surface' }), 'surface')
		await seen(page.getByRole('heading', { name: 'Access by role' }), 'access by role')
	},
}
