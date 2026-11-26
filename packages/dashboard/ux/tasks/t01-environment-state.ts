import type { UxTask } from '../checks/types'
import { aboveFold, environmentRow, openApp } from './assert'

export const environmentState: UxTask = {
	id: 't01-environment-state',
	persona: 'developer',
	kind: 'main',
	goal: 'Is each environment of notes up, what does it run, and does anything need your attention?',
	success: "Each environment's state, the commit it runs and the decision waiting on it show without scrolling.",
	start: '/apps',
	budget: { clicks: 1, fills: 0, keyPresses: 0, states: 2 },
	mutates: false,
	run: async (page, actor) => {
		await openApp(page, actor)
		for (const env of ['prod', 'test']) await aboveFold(page, environmentRow(page, env), `${env} row`)
		await aboveFold(page, page.getByRole('columnheader', { name: 'State' }), 'state column')
		await aboveFold(page, page.getByRole('columnheader', { name: 'Running' }), 'running column')
		await aboveFold(page, page.getByRole('heading', { name: 'Waiting for a decision' }), 'waiting decision')
	},
}
