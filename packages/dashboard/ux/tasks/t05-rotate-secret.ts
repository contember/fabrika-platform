import type { UxTask } from '../checks/types'
import { openApp, openTab, seen } from './assert'

export const rotateSecret: UxTask = {
	id: 't05-rotate-secret',
	persona: 'developer',
	kind: 'secondary',
	goal: 'Rotate PAYMENT_API_KEY on notes prod to a new value.',
	success: 'The secret shows saved, with no error.',
	start: '/apps',
	budget: { clicks: 4, fills: 1, keyPresses: 0, states: 3 },
	mutates: true,
	run: async (page, actor) => {
		await openApp(page, actor)
		await openTab(page, actor, 'Secrets and variables')
		const row = page.locator('.workspace tr').filter({ hasText: 'PAYMENT_API_KEY' }).filter({ hasText: 'prod' })
		await actor.click(row.getByRole('button', { name: /^(Rotate|Set value)$/ }))
		const value = page.getByLabel('Secret value')
		await actor.fill(value, `ux-${Date.now().toString(36)}`)
		await actor.click(page.locator('.workspace tr').getByRole('button', { name: /^(Rotate|Set)$/ }))
		await seen(row.getByRole('button', { name: /^(Rotate|Set value)$/ }), 'the saved secret row')
	},
}
