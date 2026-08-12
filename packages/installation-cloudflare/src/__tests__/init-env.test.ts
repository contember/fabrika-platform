import { action } from '@fabrika/installation-init'
import { describe, expect, spyOn, test } from 'bun:test'
import { ensureGitHubApp, ensureVaultKey, readInstallerAuthMethods, readInstallerEmailProvider, readResumeValue } from '../init'

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

describe('Cloudflare installer GitHub App resume', () => {
	const app = {
		id: 123,
		slug: 'fabrika-test',
		htmlUrl: 'https://github.com/apps/fabrika-test',
		pem: '-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----',
		webhookSecret: 'webhook-secret',
	}
	const context = {
		account: 'test-account',
		controlPlaneDomain: 'control.example.test',
		githubOrg: 'contember',
		installRepos: ['contember/app'],
	}

	test('fresh rejection persists one complete bundle and resume still requires confirmation', async () => {
		const source: Record<string, string | undefined> = {}
		const persisted: Array<Readonly<Record<string, string>>> = []
		const actions: string[] = []
		let creations = 0
		let confirmations = 0
		const dependencies = {
			source,
			create: () => {
				creations++
				return Promise.resolve(app)
			},
			persist: (values: Readonly<Record<string, string>>) => {
				persisted.push(values)
				Object.assign(source, values)
				return Promise.resolve()
			},
			appName: () => Promise.resolve('fabrika-test'),
			confirmInstallation: () => {
				confirmations++
				return Promise.resolve(confirmations > 1)
			},
			installAction: (title: string) => actions.push(title),
		}

		await expect(ensureGitHubApp(context, dependencies)).rejects.toThrow('GitHub App installation is required')
		expect(await ensureGitHubApp(context, dependencies)).toEqual(app)

		expect(creations).toBe(1)
		expect(confirmations).toBe(2)
		expect(actions).toEqual(['OPERATOR ACTION — install the GitHub App', 'OPERATOR ACTION — install the GitHub App'])
		expect(persisted).toEqual([{
			GITHUB_APP_PRIVATE_KEY: app.pem,
			GITHUB_WEBHOOK_SECRET: app.webhookSecret,
			GITHUB_APP_ID: String(app.id),
			GITHUB_APP_SLUG: app.slug,
			GITHUB_APP_URL: app.htmlUrl,
		}])
	})

	test('partial or malformed stored state fails before creating a replacement App', async () => {
		for (
			const source of [
				{ GITHUB_APP_PRIVATE_KEY: app.pem },
				{
					GITHUB_APP_PRIVATE_KEY: app.pem,
					GITHUB_WEBHOOK_SECRET: app.webhookSecret,
					GITHUB_APP_ID: 'not-an-id',
					GITHUB_APP_SLUG: app.slug,
					GITHUB_APP_URL: app.htmlUrl,
				},
			]
		) {
			let creations = 0
			let confirmations = 0
			await expect(ensureGitHubApp(context, {
				source,
				create: () => {
					creations++
					return Promise.resolve(app)
				},
				persist: () => Promise.resolve(),
				appName: () => Promise.resolve('fabrika-test'),
				confirmInstallation: () => {
					confirmations++
					return Promise.resolve(true)
				},
				installAction: () => {},
			})).rejects.toThrow('restore all GitHub App values in .env or remove all five')
			expect(creations).toBe(0)
			expect(confirmations).toBe(0)
		}
	})

	test('an interrupted installation confirmation is required again on resume', async () => {
		const source = {
			GITHUB_APP_PRIVATE_KEY: app.pem,
			GITHUB_WEBHOOK_SECRET: app.webhookSecret,
			GITHUB_APP_ID: String(app.id),
			GITHUB_APP_SLUG: app.slug,
			GITHUB_APP_URL: app.htmlUrl,
		}
		let confirmations = 0
		let creations = 0
		const dependencies = {
			source,
			create: () => {
				creations++
				return Promise.resolve(app)
			},
			persist: () => Promise.resolve(),
			appName: () => Promise.resolve('fabrika-test'),
			confirmInstallation: () => {
				confirmations++
				return confirmations === 1 ? Promise.reject(new Error('operator interrupted')) : Promise.resolve(true)
			},
			installAction: () => {},
		}

		await expect(ensureGitHubApp(context, dependencies)).rejects.toThrow('operator interrupted')
		expect(await ensureGitHubApp(context, dependencies)).toEqual(app)
		expect(confirmations).toBe(2)
		expect(creations).toBe(0)
	})
})
