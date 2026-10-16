import type { AppDto } from '@fabrika/iam-contract'
import { describe, expect, test } from 'bun:test'
import { keyGrantTargets } from '../access/lib/key-grants'

describe("an API key's grant form offers the apps its key mints tokens for", () => {
	const apps: AppDto[] = [
		{ id: 'vozka', displayName: 'Console', installation: true },
		{ id: 'crm@prod', displayName: 'CRM', installation: false },
		{ id: 'notes@prod', displayName: null, installation: false },
	]
	const ids = (targets: { apps: AppDto[] }) => targets.apps.map((app) => app.id)

	test('a key bound to one app gets that app only, and no cross-app option', () => {
		const targets = keyGrantTargets(apps, { app: 'crm@prod', expiresAt: null })
		expect([ids(targets), targets.crossApp]).toEqual([['crm@prod'], false])
	})

	test('a key bound to an app IAM no longer lists gets nothing to grant at', () => {
		const targets = keyGrantTargets(apps, { app: 'gone@prod', expiresAt: 1 })
		expect([ids(targets), targets.crossApp]).toEqual([[], false])
	})

	test('a key bound to no app gets every app and the cross-app option, as provisioning does', () => {
		for (const credential of [{ app: null, expiresAt: null }, null]) {
			const targets = keyGrantTargets(apps, credential)
			expect([ids(targets), targets.crossApp]).toEqual([['vozka', 'crm@prod', 'notes@prod'], true])
		}
	})
})
