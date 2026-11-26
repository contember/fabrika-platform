import type { UxTask } from '../checks/types'
import { openApp, openTab, seen } from './assert'

export const builder: UxTask = {
	id: 't10-builder',
	persona: 'developer',
	kind: 'secondary',
	goal: 'Find how to connect the local builder to notes.',
	success: 'The builder instructions for notes are shown.',
	start: '/apps',
	budget: { clicks: 2, fills: 0, keyPresses: 0, states: 3 },
	mutates: false,
	run: async (page, actor) => {
		await openApp(page, actor)
		await openTab(page, actor, 'Settings')
		await seen(page.getByRole('heading', { name: 'Work locally with the builder' }), 'builder instructions')
	},
}
