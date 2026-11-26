import type { UxTask } from '../checks/types'
import { openApp, openTab, seen } from './assert'

export const grantSelf: UxTask = {
	id: 't08-grant-self',
	persona: 'installation-admin',
	kind: 'secondary',
	goal: 'Grant yourself admin on notes test for 8 hours.',
	success: 'You hold Admin on test until a time 8 hours from now, or the grant waits for approval.',
	start: '/apps',
	budget: { clicks: 4, fills: 0, keyPresses: 0, states: 3 },
	mutates: true,
	run: async (page, actor) => {
		await openApp(page, actor)
		await openTab(page, actor, 'Access')
		const expiry = page.getByLabel('Admin on test expires')
		if ((await expiry.count()) === 0) throw new Error('Admin on test is already held: run on a freshly seeded stack (env.md)')
		await actor.select(page.getByLabel('Admin on test expires'), '8 hours')
		await actor.click(
			page.locator('.workspace tr').filter({ has: page.getByLabel('Admin on test expires') }).getByRole('button', { name: 'Grant me Admin' }),
		)
		const own = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Your admin access' }) }).locator('tr').filter({
			hasText: 'test',
		})
		await seen(own.getByText(/You hold Admin until|waits for another administrator/), 'the grant on test')
	},
}
