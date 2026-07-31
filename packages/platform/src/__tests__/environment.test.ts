import { describe, expect, test } from 'bun:test'
import { createEnvironmentAliasReader } from '../environment'

describe('environment aliases', () => {
	test('uses the canonical name when only it is set', () => {
		const warnings: string[] = []
		const reader = createEnvironmentAliasReader((message) => warnings.push(message))

		expect(reader.read({ FABRIKA_APP_ID: 'canonical' }, { canonical: 'FABRIKA_APP_ID', legacy: 'PROPUSTKA_APP_ID' })).toBe('canonical')
		expect(warnings).toEqual([])
	})

	test('uses the legacy name and warns without its value when only it is set', () => {
		const warnings: string[] = []
		const reader = createEnvironmentAliasReader((message) => warnings.push(message))

		expect(reader.read({ PROPUSTKA_APP_ID: 'legacy-secret' }, { canonical: 'FABRIKA_APP_ID', legacy: 'PROPUSTKA_APP_ID' })).toBe(
			'legacy-secret',
		)
		expect(warnings).toEqual(['PROPUSTKA_APP_ID is deprecated; use FABRIKA_APP_ID instead.'])
		expect(warnings[0]).not.toContain('legacy-secret')
	})

	test('uses the canonical name and warns that the legacy name was ignored when both are set', () => {
		const warnings: string[] = []
		const reader = createEnvironmentAliasReader((message) => warnings.push(message))

		expect(
			reader.read(
				{ FABRIKA_APP_ID: 'canonical-secret', PROPUSTKA_APP_ID: 'legacy-secret' },
				{ canonical: 'FABRIKA_APP_ID', legacy: 'PROPUSTKA_APP_ID' },
			),
		).toBe('canonical-secret')
		expect(warnings).toEqual(['PROPUSTKA_APP_ID is deprecated and was ignored because FABRIKA_APP_ID is set.'])
		expect(warnings[0]).not.toContain('canonical-secret')
		expect(warnings[0]).not.toContain('legacy-secret')
	})

	test('returns undefined without warning when neither name is set', () => {
		const warnings: string[] = []
		const reader = createEnvironmentAliasReader((message) => warnings.push(message))

		expect(reader.read({}, { canonical: 'FABRIKA_APP_ID', legacy: 'PROPUSTKA_APP_ID' })).toBeUndefined()
		expect(warnings).toEqual([])
	})

	test('warns at most once for each legacy name', () => {
		const warnings: string[] = []
		const reader = createEnvironmentAliasReader((message) => warnings.push(message))
		const appAlias = { canonical: 'FABRIKA_APP_ID', legacy: 'PROPUSTKA_APP_ID' }

		reader.read({ PROPUSTKA_APP_ID: 'first' }, appAlias)
		reader.read({ FABRIKA_APP_ID: 'canonical', PROPUSTKA_APP_ID: 'second' }, appAlias)
		reader.read({ PROPUSTKA_URL: 'third' }, { canonical: 'FABRIKA_IAM_URL', legacy: 'PROPUSTKA_URL' })

		expect(warnings).toHaveLength(2)
		expect(warnings[0]).toContain('PROPUSTKA_APP_ID')
		expect(warnings[1]).toContain('PROPUSTKA_URL')
	})
})
