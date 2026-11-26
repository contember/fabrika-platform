import type { UxTask } from '../checks/types'
import { environmentRow, openApp, seen } from './assert'

export const deploy: UxTask = {
	id: 't02-deploy',
	persona: 'developer',
	kind: 'main',
	goal: 'Deploy notes test and follow the run.',
	success: 'The new run of test is open and shows its progress.',
	start: '/apps',
	budget: { clicks: 2, fills: 0, keyPresses: 0, states: 3 },
	mutates: true,
	run: async (page, actor) => {
		await openApp(page, actor)
		await actor.click(environmentRow(page, 'test').getByRole('button', { name: /^Deploy/ }))
		await page.waitForURL(/\/runs\/[^/]+$/)
		const head = page.locator('.page-head .subtitle')
		await seen(head.getByText('notes', { exact: true }), 'the run of notes')
		await seen(head.getByText('test', { exact: true }), 'the run of test')
	},
}
