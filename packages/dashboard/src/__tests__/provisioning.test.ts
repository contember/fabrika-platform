import type { ScimSettingsDto } from '@fabrika/iam-contract'
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { type ConsoleCaller, mayOpen } from '../lib/console-access'
import { visibleNav } from '../routes/_layout'
import { ProvisioningEditor } from '../routes/settings/provisioning'

const UNSET: ScimSettingsDto = { endpoint: 'https://iam.example.test/scim/v2', configured: false, createdAt: null }

describe('the Provisioning page', () => {
	const render = (current: ScimSettingsDto) => renderToStaticMarkup(createElement(ProvisioningEditor, { current, onChanged: () => {} }))

	test('shows the tenant URL, and without a token says every request is refused and offers to create one', () => {
		const html = render(UNSET)
		expect(html).toContain('https://iam.example.test/scim/v2')
		expect(html).toContain('No token is set, so every provisioning request is refused.')
		expect(html).toContain('Create token')
		expect(html).not.toContain('Remove token')
	})

	test('with a token offers rotation and removal, and never shows a secret', () => {
		const html = render({ ...UNSET, configured: true, createdAt: 1_800_000_000 })
		expect(html).toContain('Rotate token')
		expect(html).toContain('Remove token')
		expect(html).not.toContain('px_')
	})

	test("is an installation administrator's, after Passwords in the rail", () => {
		const admin: ConsoleCaller = { access: null, iam: { kind: 'installation' }, administersPeople: false }
		const userAdmin: ConsoleCaller = { access: null, iam: { kind: 'users', apps: null }, administersPeople: false }
		expect(mayOpen(admin, 'settings/provisioning')).toBe(true)
		expect(mayOpen(userAdmin, 'settings/provisioning')).toBe(false)
		expect(mayOpen({ ...admin, iam: false }, 'settings/provisioning')).toBe(false)
		const delivery = visibleNav(admin).sections.find((section) => section.label === 'Delivery')?.items.map((item) => item.label) ?? []
		expect(delivery.slice(delivery.indexOf('Passwords'), delivery.indexOf('Passwords') + 2)).toEqual(['Passwords', 'Provisioning'])
	})
})
