import { describe, expect, spyOn, test } from 'bun:test'
import { ensureVaultKey, readInstallerAuthMethods, readInstallerEmailProvider, readResumeEnvironmentAlias } from '../init'
import { action } from '../log'

const aliases: ReadonlyArray<readonly [string, string]> = [
	['FABRIKA_CONTROL_VAULT_KEY', 'VOZKA_VAULT_KEY'],
	['FABRIKA_IAM_PROVISIONING_KEY', 'PROPUSTKA_PROVISIONING_KEY'],
	['FABRIKA_IAM_SIGNING_KEYS', 'PROPUSTKA_SIGNING_KEYS'],
	['FABRIKA_IAM_OIDC_CLIENT_SECRET', 'PROPUSTKA_OIDC_CLIENT_SECRET'],
]

describe('Cloudflare installer resume aliases', () => {
	for (const [canonical, legacy] of aliases) {
		test(`${canonical} treats an empty canonical value as absent without falling back`, () => {
			expect(readResumeEnvironmentAlias({ [canonical]: '', [legacy]: 'legacy-value' }, canonical, legacy)).toBeUndefined()
			expect(readResumeEnvironmentAlias({ [canonical]: '', [legacy]: '' }, canonical, legacy)).toBeUndefined()
		})

		test(`${canonical} falls back only when the canonical value is undefined`, () => {
			expect(readResumeEnvironmentAlias({ [legacy]: 'legacy-value' }, canonical, legacy)).toBe('legacy-value')
		})

		test(`${canonical} keeps non-empty canonical precedence`, () => {
			expect(readResumeEnvironmentAlias({ [canonical]: 'canonical-value', [legacy]: 'legacy-value' }, canonical, legacy)).toBe('canonical-value')
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
