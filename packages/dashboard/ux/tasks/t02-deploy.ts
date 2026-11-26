import type { UxTask } from '../checks/types'
import { environmentRow, openApp, seen } from './assert'

export const deploy: UxTask = {
	id: 't02-deploy',
	persona: 'developer',
	kind: 'main',
	goal: 'Deploy notes test and follow the run.',
	success: 'The new run of test is open and shows its progress.',
	start: '/apps',
	budget: null,
	mutates: true,
	run: async (page, actor) => {
		await openApp(page, actor)
		await actor.click(environmentRow(page, 'test').getByRole('button', { name: /^Deploy/ }))
		await page.waitForURL(/\/runs\/[^/]+$/)
		await seen(page.getByText('test', { exact: true }), 'the run of test')
	},
}
