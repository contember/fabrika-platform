import type { UxTask } from '../checks/types'
import { gone, openApp, openTab, seen } from './assert'

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
		await actor.click(page.getByRole('button', { name: /^PAYMENT_API_KEY on prod: / }))
		const value = page.getByLabel(/^(New value|Secret value)/)
		await actor.fill(value, `ux-${Date.now().toString(36)}`)
		await actor.click(page.getByRole('button', { name: /^(Rotate|Set)$/ }))
		await gone(value, 'the value field')
		await seen(page.getByRole('status').filter({ hasText: 'PAYMENT_API_KEY on prod: new value saved' }), 'the saved confirmation')
	},
}
