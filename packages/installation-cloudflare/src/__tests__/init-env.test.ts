import { describe, expect, spyOn, test } from 'bun:test'
import { ensureVaultKey, readInstallerAuthMethods, readInstallerEmailProvider, readResumeValue } from '../init'
import { action } from '../log'

const RESUMED_NAMES: readonly string[] = [
	'FABRIKA_CONTROL_VAULT_KEY',
	'FABRIKA_IAM_PROVISIONING_KEY',
	'FABRIKA_IAM_SIGNING_KEYS',
	'FABRIKA_IAM_OIDC_CLIENT_SECRET',
]

describe('Cloudflare installer resume reads', () => {
	for (const name of RESUMED_NAMES) {
		test(`${name} treats an empty value as absent`, () => {
			expect(readResumeValue({ [name]: '' }, name)).toBeUndefined()
			expect(readResumeValue({}, name)).toBeUndefined()
			expect(readResumeValue({ [name]: 'stored-value' }, name)).toBe('stored-value')
		})
	}

	test('a generated vault key is persisted but never passed to user-facing output', async () => {
		const persisted: Array<{ name: string; value: string }> = []
		const output: string[] = []
		const key = 'generated-secret-vault-key'
		const stdout = spyOn(console, 'log').mockImplementation((...values) => {
			output.push(values.map((value) => String(value)).join(' '))
		})

		try {
			expect(
				await ensureVaultKey({
					source: {},
					persist: (name, value) => {
						persisted.push({ name, value })
						return Promise.resolve()
					},
					generate: () => key,
					created: action,
				}),
			).toBe(key)
		} finally {
			stdout.mockRestore()
		}
		expect(persisted).toEqual([{ name: 'FABRIKA_CONTROL_VAULT_KEY', value: key }])
		expect(output.join('\n')).not.toContain(key)
	})
})

describe('Cloudflare installer IAM method resume', () => {
	test('requires both authentication switches and at least one method', () => {
		expect(readInstallerAuthMethods({})).toBeUndefined()
		expect(() => readInstallerAuthMethods({ FABRIKA_IAM_OIDC_ENABLED: 'true' })).toThrow('must be configured together')
		expect(() =>
			readInstallerAuthMethods({
				FABRIKA_IAM_OIDC_ENABLED: 'false',
				FABRIKA_IAM_PASSWORD_ENABLED: 'false',
			})
		).toThrow('At least one IAM authentication method must be enabled')
	})

	test('restores OIDC-only, password-only, and hybrid selections', () => {
		expect(readInstallerAuthMethods({ FABRIKA_IAM_OIDC_ENABLED: 'true', FABRIKA_IAM_PASSWORD_ENABLED: 'false' })).toEqual({
			oidcEnabled: true,
			passwordEnabled: false,
		})
		expect(readInstallerAuthMethods({ FABRIKA_IAM_OIDC_ENABLED: 'false', FABRIKA_IAM_PASSWORD_ENABLED: 'true' })).toEqual({
			oidcEnabled: false,
			passwordEnabled: true,
		})
		expect(readInstallerAuthMethods({ FABRIKA_IAM_OIDC_ENABLED: 'true', FABRIKA_IAM_PASSWORD_ENABLED: 'true' })).toEqual({
			oidcEnabled: true,
			passwordEnabled: true,
		})
	})

	test('validates the optional email provider', () => {
		expect(readInstallerEmailProvider({})).toBeUndefined()
		expect(readInstallerEmailProvider({ FABRIKA_EMAIL_PROVIDER: 'none' })).toBe('none')
		expect(readInstallerEmailProvider({ FABRIKA_EMAIL_PROVIDER: 'resend' })).toBe('resend')
		expect(() => readInstallerEmailProvider({ FABRIKA_EMAIL_PROVIDER: 'smtp' })).toThrow('must be none or resend')
	})
})
