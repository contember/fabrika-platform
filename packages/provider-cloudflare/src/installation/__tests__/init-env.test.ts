import { action } from '@fabrika/installation-init'
import { describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { envPath, openEnvFile } from '../envfile'
import { type Collected, ensurePlatformNames, ensureRunnerKey, ensureVaultKey, environmentPayload, finalNotes, readResumeValue } from '../init'

const RESUMED_NAMES: readonly string[] = [
	'FABRIKA_CONTROL_VAULT_KEY',
	'FABRIKA_IAM_PROVISIONING_KEY',
	'FABRIKA_IAM_SIGNING_KEYS',
	'FABRIKA_IAM_OIDC_CLIENT_SECRET',
	'FABRIKA_RUNNER_KEY',
]

const COLLECTED: Collected = {
	account: 'acme',
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
	email: { kind: 'none' },
	bootstrapAdmins: ['ops@example.com'],
	platformNames: 'fabrika',
}

/** Point XDG at a throwaway directory and open a real env file for the length of one test. */
async function withOpenEnvFile(run: () => Promise<void>): Promise<void> {
	const configHome = await mkdtemp(join(tmpdir(), 'fabrika-cloudflare-init-'))
	const previous = process.env['XDG_CONFIG_HOME']
	process.env['XDG_CONFIG_HOME'] = configHome
	try {
		await openEnvFile('acme')
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

describe('Cloudflare installer resource names', () => {
	const INPUT = { account: 'acme', repo: 'acme/fabrika-platform-acme' }
	/** The Environment the installation already has, as `gh` answers it; null when there is none. */
	const effects = (existing: Readonly<Record<string, string>> | null) => ({ environmentVariables: () => Promise.resolve(existing) })

	const decided = async (source: Readonly<Record<string, string>>, existing: Readonly<Record<string, string>> | null) => {
		let scheme: unknown
		let saved: string | undefined
		await withOpenEnvFile(async () => {
			await captured(async () => {
				scheme = await ensurePlatformNames(INPUT, source, effects(existing))
			})
			saved = process.env['FABRIKA_CLOUDFLARE_NAMES']
			delete process.env['FABRIKA_CLOUDFLARE_NAMES']
		})
		return { scheme, saved }
	}

	test('a new installation takes the fabrika names and saves them for a resumed run', async () => {
		expect(await decided({}, null)).toEqual({ scheme: 'fabrika', saved: 'fabrika' })
		expect(await decided({}, {})).toEqual({ scheme: 'fabrika', saved: 'fabrika' })
	})

	test('an installation whose Environment predates the switch keeps the legacy names', async () => {
		expect(await decided({}, { FABRIKA_CONTROL_DOMAIN: 'fabrika.example.com' })).toEqual({ scheme: 'legacy', saved: 'legacy' })
	})

	test('an existing installation keeps the names its Environment records, and a resumed run the ones it saved', async () => {
		expect(await decided({}, { FABRIKA_CLOUDFLARE_NAMES: 'fabrika', FABRIKA_CONTROL_DOMAIN: 'x' })).toEqual({ scheme: 'fabrika', saved: 'fabrika' })
		expect(await decided({ FABRIKA_CLOUDFLARE_NAMES: 'legacy' }, null)).toEqual({ scheme: 'legacy', saved: 'legacy' })
		expect(await decided({ FABRIKA_CLOUDFLARE_NAMES: 'fabrika' }, { FABRIKA_CLOUDFLARE_NAMES: 'fabrika' })).toEqual({
			scheme: 'fabrika',
			saved: 'fabrika',
		})
	})

	test('an env file that disagrees with the Environment stops init before anything is written', async () => {
		await expect(decided({ FABRIKA_CLOUDFLARE_NAMES: 'fabrika' }, { FABRIKA_CONTROL_DOMAIN: 'x' })).rejects.toThrow(
			'The installer env file names the resources `fabrika`, but the acme Environment on acme/fabrika-platform-acme `legacy`',
		)
	})

	test('the GitHub Environment carries the scheme as a variable', () => {
		const payload = environmentPayload(COLLECTED, {
			vaultKey: 'vault',
			provisioning: 'px_key',
			operationsSyncKey: 'ops',
			runnerKey: 'runner-key-value',
			signingKeys: '[]',
		})
		expect(payload.vars['FABRIKA_CLOUDFLARE_NAMES']).toBe('fabrika')
		expect(
			environmentPayload({ ...COLLECTED, platformNames: 'legacy' }, {
				vaultKey: 'vault',
				provisioning: 'px_key',
				operationsSyncKey: 'ops',
				runnerKey: 'runner-key-value',
				signingKeys: '[]',
			}).vars['FABRIKA_CLOUDFLARE_NAMES'],
		).toBe('legacy')
	})
})

describe('Cloudflare installer closing summary', () => {
	test('names the absolute env-file path and claims nothing about gitignore', async () => {
		await withOpenEnvFile(async () => {
			const printed = await captured(() =>
				finalNotes({
					repo: 'acme/fabrika-platform',
					account: 'acme',
					controlPlaneDomain: 'fabrika.example.com',
					dir: '/tmp/checkout',
					ref: 'v0.1.0',
					passwordEnabled: false,
					branchProtection: { applied: true, command: 'gh api …' },
					environmentPolicy: { applied: false, reason: 'HTTP 403 — not offered on this plan', command: 'gh api …later…' },
				})
			)

			expect(printed).toContain(envPath())
			expect(envPath()).toContain('fabrika/cloudflare/acme/.env')
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
		account: 'acme',
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
