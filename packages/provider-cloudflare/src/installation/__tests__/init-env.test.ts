import { action } from '@fabrika/installation-init'
import { describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { envPath, openEnvFile } from '../envfile'
import {
	type Collected,
	ensureRunnerKey,
	ensureVaultKey,
	environmentPayload,
	finalNotes,
	readInstallerAuthMethods,
	readInstallerEmailProvider,
	readResumeValue,
} from '../init'

const RESUMED_NAMES: readonly string[] = [
	'FABRIKA_CONTROL_VAULT_KEY',
	'FABRIKA_IAM_PROVISIONING_KEY',
	'FABRIKA_IAM_SIGNING_KEYS',
	'FABRIKA_IAM_OIDC_CLIENT_SECRET',
	'FABRIKA_RUNNER_KEY',
]

const COLLECTED: Collected = {
	account: 'mangoweb',
	accountId: 'cf-account-id',
	apiToken: 'cf-api-token',
	controlPlaneDomain: 'fabrika.example.com',
	operationsHostname: 'errors.example.com',
	platformRepo: 'acme/fabrika-platform',
	iamUrl: 'https://iam.example.com',
	iamHostname: 'iam.example.com',
	oidcEnabled: false,
	passwordEnabled: true,
	oidcIssuer: '',
	oidcClientId: '',
	humanEmailDomains: [],
	emailProvider: 'none',
	emailFrom: '',
	bootstrapAdmins: ['ops@example.com'],
}

/** Point XDG at a throwaway directory and open a real env file for the length of one test. */
async function withOpenEnvFile(run: () => Promise<void>): Promise<void> {
	const configHome = await mkdtemp(join(tmpdir(), 'fabrika-cloudflare-init-'))
	const previous = process.env['XDG_CONFIG_HOME']
	process.env['XDG_CONFIG_HOME'] = configHome
	try {
		await openEnvFile('mangoweb')
		await run()
	} finally {
		if (previous === undefined) delete process.env['XDG_CONFIG_HOME']
		else process.env['XDG_CONFIG_HOME'] = previous
		await rm(configHome, { recursive: true, force: true })
	}
}

/** Capture every console line one call writes. */
async function captured(run: () => Promise<unknown> | unknown): Promise<string> {
	const output: string[] = []
	const stdout = spyOn(console, 'log').mockImplementation((...values) => {
		output.push(values.map((value) => String(value)).join(' '))
	})
	try {
		await run()
	} finally {
		stdout.mockRestore()
	}
	return output.join('\n')
}

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

describe('Cloudflare installer runner key', () => {
	test('generates one 256-bit key, persists it, and reuses it on a resume', async () => {
		await withOpenEnvFile(async () => {
			delete process.env['FABRIKA_RUNNER_KEY']
			let key = ''
			const printed = await captured(async () => {
				key = await ensureRunnerKey()
			})

			expect(Buffer.from(key, 'base64url')).toHaveLength(32)
			expect(process.env['FABRIKA_RUNNER_KEY']).toBe(key)
			expect(await Bun.file(envPath()).text()).toContain(`FABRIKA_RUNNER_KEY='${key}'`)
			expect(printed).not.toContain(key)

			let resumed = ''
			await captured(async () => {
				resumed = await ensureRunnerKey()
			})
			expect(resumed).toBe(key)
			delete process.env['FABRIKA_RUNNER_KEY']
		})
	})

	test('reaches the GitHub Environment as a SECRET and never as a variable', () => {
		const payload = environmentPayload(COLLECTED, {
			vaultKey: 'vault',
			provisioning: 'px_key',
			operationsSyncKey: 'ops',
			runnerKey: 'runner-key-value',
			signingKeys: '[]',
		})

		expect(payload.secrets['FABRIKA_RUNNER_KEY']).toBe('runner-key-value')
		expect(Object.keys(payload.vars)).not.toContain('FABRIKA_RUNNER_KEY')
		expect(Object.values(payload.vars)).not.toContain('runner-key-value')
	})

	test('carries no GitHub App credential: source connections live in the control vault', () => {
		const payload = environmentPayload(COLLECTED, {
			vaultKey: 'vault',
			provisioning: 'px_key',
			operationsSyncKey: 'ops',
			runnerKey: 'runner-key-value',
			signingKeys: '[]',
		})

		expect([...Object.keys(payload.secrets), ...Object.keys(payload.vars)].filter((name) => /^(GH|GITHUB)_/.test(name))).toEqual([])
	})
})

describe('Cloudflare installer closing summary', () => {
	test('names the absolute env-file path and claims nothing about gitignore', async () => {
		await withOpenEnvFile(async () => {
			const printed = await captured(() =>
				finalNotes({
					repo: 'acme/fabrika-platform',
					account: 'mangoweb',
					controlPlaneDomain: 'fabrika.example.com',
					dir: '/tmp/checkout',
					ref: 'v0.1.0',
					passwordEnabled: false,
					branchProtection: { applied: true, command: 'gh api …' },
					environmentPolicy: { applied: false, reason: 'HTTP 403 — not offered on this plan', command: 'gh api …later…' },
				})
			)

			expect(printed).toContain(envPath())
			expect(envPath()).toContain('fabrika/cloudflare/mangoweb/.env')
			expect(printed).not.toContain('gitignored')
			expect(printed).toContain('Branch protection on main: applied.')
			expect(printed).toContain('Environment deployment-branch policy: NOT applied (HTTP 403')
			expect(printed).toContain('gh api …later…')
			expect(printed).toContain('https://fabrika.example.com/settings/source')
		})
	})
})

describe('Cloudflare installer env-file precedence', () => {
	test('a stray .env in the cwd is called out, because Bun already loaded it and it wins', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'fabrika-cloudflare-cwd-'))
		const previousCwd = process.cwd()
		process.chdir(cwd)
		try {
			await Bun.write(join(cwd, '.env'), "OTHER_ACCOUNT_KEY='leftover'\n")
			const printed = await captured(() => withOpenEnvFile(() => Promise.resolve()))

			expect(printed).toContain(join(cwd, '.env'))
			expect(printed).toContain('OUTRANK')
		} finally {
			process.chdir(previousCwd)
			await rm(cwd, { recursive: true, force: true })
		}
	})
})

describe('Cloudflare installer protection summary', () => {
	const base = {
		repo: 'acme/fabrika-platform',
		account: 'mangoweb',
		controlPlaneDomain: 'fabrika.example.com',
		dir: '/tmp/checkout',
		ref: 'v0.1.0',
		passwordEnabled: false,
	}

	test('an applied policy over an unprotected main is reported as restricting nothing', async () => {
		await withOpenEnvFile(async () => {
			const printed = await captured(() =>
				finalNotes({
					...base,
					branchProtection: { applied: false, reason: 'HTTP 404 — no protection rule on main', command: 'gh api …protect main…' },
					environmentPolicy: { applied: true, command: 'gh api …policy…' },
				})
			)

			expect(printed).toContain('applied, but it restricts nothing until main carries a protection rule')
			expect(printed).toContain('gh api …protect main…')
		})
	})

	test('both applied reports the policy plainly', async () => {
		await withOpenEnvFile(async () => {
			const printed = await captured(() =>
				finalNotes({
					...base,
					branchProtection: { applied: true, command: 'gh api …protect main…' },
					environmentPolicy: { applied: true, command: 'gh api …policy…' },
				})
			)

			expect(printed).toContain('Environment deployment-branch policy: applied.')
			expect(printed).not.toContain('restricts nothing')
		})
	})
})
