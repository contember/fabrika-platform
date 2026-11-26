import type { UxTask } from '../checks/types'
import { environmentRow, openApp, openTab, seen } from './assert'

export const environmentForm: UxTask = {
	id: 't09-environment-form',
	persona: 'installation-admin',
	kind: 'secondary',
	goal: "Open the form to change notes test's address and placement. Do not save.",
	success: "The form for test's address and placement is open.",
	start: '/apps',
	budget: null,
	mutates: false,
	run: async (page, actor) => {
		await openApp(page, actor)
		await openTab(page, actor, 'Settings')
		await actor.click(environmentRow(page, 'test').getByRole('button', { name: 'Edit' }))
		await seen(page.getByLabel(/Domain|Address|Public origin/).first(), 'the address field')
	},
}
