import type { PasswordPolicyDto } from '@fabrika/iam-contract'
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { type ConsoleCaller, mayOpen } from '../lib/console-access'
import { minLengthRisk, typedMinLength } from '../lib/password-policy'
import { visibleNav } from '../routes/_layout'
import { PasswordPolicyEditor } from '../routes/settings/passwords'

const DEFAULT: PasswordPolicyDto = { minLength: 15, defaultMinLength: 15, minLengthFloor: 4, maxLength: 256, passwordEnabled: true, updatedAt: null }

describe('a typed minimum', () => {
	test('is a whole number from the floor to the maximum, as IAM stores it', () => {
		expect(typedMinLength('5', DEFAULT)).toEqual({ ok: true, value: 5 })
		expect(typedMinLength(' 256 ', DEFAULT)).toEqual({ ok: true, value: 256 })
		for (const raw of ['3', '257', '7.5', '', '-6', 'eight']) {
			expect([raw, typedMinLength(raw, DEFAULT)]).toEqual([raw, { ok: false, message: 'Enter a whole number from 4 to 256.' }])
		}
		expect(typedMinLength('8', { minLengthFloor: 15, maxLength: 256 })).toEqual({ ok: false, message: 'Enter a whole number from 15 to 256.' })
	})

	test('says nothing at the default, notes a shorter one, warns below 8', () => {
		expect(minLengthRisk(15, 15)).toBe('none')
		expect(minLengthRisk(20, 15)).toBe('none')
		expect(minLengthRisk(8, 15)).toBe('below-default')
		expect(minLengthRisk(7, 15)).toBe('below-single-factor')
	})
})

describe('the Passwords page', () => {
	const render = (current: PasswordPolicyDto) => renderToStaticMarkup(createElement(PasswordPolicyEditor, { current, onSaved: () => {} }))

	test('shows the stored minimum with its range, and no warning at the default', () => {
		const html = render(DEFAULT)
		expect(html).toContain('value="15"')
		expect(html).toContain('From 4 to 256. The default is 15.')
		expect(html).not.toContain('notice-bad')
		expect(html).not.toContain('Use the default')
	})

	test('warns below 8 and offers the default back', () => {
		const html = render({ ...DEFAULT, minLength: 5, updatedAt: 1_800_000_000 })
		expect(html).toContain('notice notice-bad')
		expect(html).toContain('Use the default (15)')
	})

	test('says when password sign-in is off, and when the runtime keeps the default as its floor', () => {
		expect(render({ ...DEFAULT, passwordEnabled: false })).toContain('Password sign-in is off on this installation.')
		expect(render({ ...DEFAULT, minLengthFloor: 15 })).toContain('hashes passwords too cheaply for a shorter minimum')
	})

	test("is an installation administrator's, after Branding in the rail", () => {
		const admin: ConsoleCaller = { access: null, iam: { kind: 'installation' }, administersPeople: false }
		const userAdmin: ConsoleCaller = { access: null, iam: { kind: 'users', apps: null }, administersPeople: false }
		expect(mayOpen(admin, 'settings/passwords')).toBe(true)
		expect(mayOpen(userAdmin, 'settings/passwords')).toBe(false)
		expect(mayOpen({ ...admin, iam: false }, 'settings/passwords')).toBe(false)
		const delivery = visibleNav(admin).sections.find((section) => section.label === 'Delivery')?.items.map((item) => item.label) ?? []
		expect(delivery.slice(delivery.indexOf('Branding'), delivery.indexOf('Branding') + 2)).toEqual(['Branding', 'Passwords'])
	})
})
