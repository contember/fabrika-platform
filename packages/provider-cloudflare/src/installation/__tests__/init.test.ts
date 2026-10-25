import type { EnvironmentConfig } from '@fabrika/installation-init'
import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { envPath, openEnvFile, parseEnvFile } from '../envfile'
import { type InitCollaborators, runInit } from '../init'
import {
	type InitInput,
	parseInitAccount,
	parseInitArgs,
	PLACEHOLDER_OIDC_CLIENT_ID,
	PLACEHOLDER_OIDC_CLIENT_SECRET,
	rerunCommand,
} from '../init-options'
import type { ScaffoldInput } from '../scaffold'

const API_TOKEN = 'cf-api-token-value-that-must-never-be-printed'
const CREDENTIALS = { CLOUDFLARE_API_TOKEN: API_TOKEN }
const REQUIRED = [
	'acme',
	'--console-host=fabrika.example.com',
	'--operations-host=errors.example.com',
	'--iam-host=iam.example.com',
	'--auth-methods=password',
	'--email-provider=none',
]
/** Outside any repository, so the default checkout is accepted. */
const CWD = mkdtempSync(join(tmpdir(), 'cloudflare-init-'))
afterAll(() => rm(CWD, { recursive: true, force: true }))

/** `REQUIRED` with one flag's value replaced. */
const required = (...replacements: string[]): string[] => [
	...REQUIRED.filter((arg) => !replacements.some((replacement) => arg.split('=')[0] === replacement.split('=')[0])),
	...replacements,
]

/** The message a refused call throws. */
const refusal = (run: () => unknown): string => {
	try {
		run()
	} catch (error) {
		return error instanceof Error ? error.message : String(error)
	}
	throw new Error('expected a refusal')
}

const parse = (argv: readonly string[], env: Record<string, string | undefined> = CREDENTIALS): InitInput => parseInitArgs(argv, env, CWD)

describe('Cloudflare init arguments', () => {
	test('the required surface parses with defaults for the repository and the checkout', () => {
		const input = parse([...REQUIRED, '--yes'])

		expect(input).toEqual({
			account: 'acme',
			apiToken: API_TOKEN,
			repo: 'acme/fabrika-platform',
			checkout: join(CWD, 'fabrika-platform-acme'),
			hosts: { control: 'fabrika.example.com', operations: 'errors.example.com', iam: 'iam.example.com' },
			passwordEnabled: true,
			email: { kind: 'none' },
			bootstrapAdmins: [],
			unattended: true,
		})
	})

	test('every value may come from the variable beside its flag, and a flag beats it', () => {
		const env = {
			...CREDENTIALS,
			CLOUDFLARE_ACCOUNT_ID: 'env-account',
			FABRIKA_CONTROL_DOMAIN: 'fabrika.env.example',
			OPERATIONS_HOSTNAME: 'errors.env.example',
			FABRIKA_IAM_HOSTNAME: 'iam.env.example',
			FABRIKA_IAM_OIDC_ENABLED: 'false',
			FABRIKA_IAM_PASSWORD_ENABLED: 'true',
			FABRIKA_EMAIL_PROVIDER: 'none',
			FABRIKA_CONTROL_BOOTSTRAP_ADMINS: '["ops@example.com"]',
		}
		const fromEnv = parse(['acme'], env)
		expect(fromEnv.accountId).toBe('env-account')
		expect(fromEnv.hosts).toEqual({ control: 'fabrika.env.example', operations: 'errors.env.example', iam: 'iam.env.example' })
		expect(fromEnv.bootstrapAdmins).toEqual(['ops@example.com'])

		const flagged = parse(['acme', '--account-id=flag-account', '--console-host=fabrika.flag.example', '--admins=a@example.com, b@example.com'], env)
		expect(flagged.accountId).toBe('flag-account')
		expect(flagged.hosts.control).toBe('fabrika.flag.example')
		expect(flagged.bootstrapAdmins).toEqual(['a@example.com', 'b@example.com'])
	})

	test('a missing required value names both the flag and the variable', () => {
		const withoutConsole = REQUIRED.filter((arg) => !arg.startsWith('--console-host'))
		expect(() => parse(withoutConsole)).toThrow('--console-host=<value> or FABRIKA_CONTROL_DOMAIN is required')
		const withoutEmail = REQUIRED.filter((arg) => !arg.startsWith('--email-provider'))
		expect(() => parse(withoutEmail)).toThrow('--email-provider=<value> or FABRIKA_EMAIL_PROVIDER is required')
		const withoutAuth = REQUIRED.filter((arg) => !arg.startsWith('--auth-methods'))
		expect(() => parse(withoutAuth)).toThrow('--auth-methods=<oidc|password|oidc,password> or FABRIKA_IAM_OIDC_ENABLED')
	})

	test('credentials come from the environment only', () => {
		expect(() => parse(REQUIRED, {})).toThrow('CLOUDFLARE_API_TOKEN is required')
		const refused = refusal(() => parse([...REQUIRED, `--api-token=${API_TOKEN}`]))
		expect(refused).toContain('unexpected argument `--api-token` (its value is not shown). Credentials are read from the environment and have no flag')
		expect(refused).not.toContain(API_TOKEN)
	})

	test('unknown, valueless and repeated flags and a second account are refused', () => {
		expect(() => parse([...REQUIRED, '--domain=x'])).toThrow('unexpected argument `--domain` (its value is not shown)')
		expect(() => parse([...REQUIRED, '--repo'])).toThrow('unexpected argument `--repo`')
		expect(() => parse([...REQUIRED, '--repo=a/b', '--repo=c/d'])).toThrow('--repo was given more than once')
		const second = refusal(() => parse([...REQUIRED, 'second-account-value']))
		expect(second).toContain('unexpected second positional argument (its value is not shown): name ONE account')
		expect(second).not.toContain('second-account-value')
		expect(() => parseInitAccount(['--yes'])).toThrow('requires an account name')
	})

	test('hosts are bare hostnames and the repository is owner/name', () => {
		expect(() => parse(required('--iam-host=https://iam.example.com'))).toThrow('must be a bare hostname')
		expect(() => parse(required('--iam-host=iam.example.com/path'))).toThrow('must be a bare hostname')
		expect(() => parse(required('--iam-host=iam.example.com:8443'))).toThrow('must be a bare hostname')
		expect(() => parse([...REQUIRED, '--repo=no-owner'])).toThrow('is not a <owner>/<name> repository')
	})

	test('auth methods are an enumerated selection, or the resumed pair of switches', () => {
		expect(parse(required('--auth-methods=oidc,password')).oidc).toBeDefined()
		expect(parse(required('--auth-methods=oidc,password')).passwordEnabled).toBe(true)
		expect(() => parse(required('--auth-methods=sso'))).toThrow('--auth-methods takes oidc, password, or oidc,password')
		const withoutAuth = REQUIRED.filter((arg) => !arg.startsWith('--auth-methods'))
		expect(() => parse(withoutAuth, { ...CREDENTIALS, FABRIKA_IAM_OIDC_ENABLED: 'true' })).toThrow('must be configured together')
		expect(() => parse(withoutAuth, { ...CREDENTIALS, FABRIKA_IAM_OIDC_ENABLED: 'false', FABRIKA_IAM_PASSWORD_ENABLED: 'false' }))
			.toThrow('At least one IAM authentication method must be enabled')
	})

	test('OIDC defaults to the placeholder client, and a real client needs its secret from the environment', () => {
		const oidc = required('--auth-methods=oidc')
		expect(parse([...oidc, '--human-email-domains=example.com']).oidc).toEqual({
			issuer: 'https://accounts.google.com',
			clientId: PLACEHOLDER_OIDC_CLIENT_ID,
			clientSecret: PLACEHOLDER_OIDC_CLIENT_SECRET,
			humanEmailDomains: ['example.com'],
		})
		expect(() => parse([...oidc, '--oidc-client-id=real'])).toThrow('FABRIKA_IAM_OIDC_CLIENT_SECRET is required')
		expect(() => parse([...oidc, '--oidc-client-id=real'], { ...CREDENTIALS, FABRIKA_IAM_OIDC_CLIENT_SECRET: PLACEHOLDER_OIDC_CLIENT_SECRET }))
			.toThrow('still holds the placeholder secret')
		expect(parse([...oidc, '--oidc-client-id=real'], { ...CREDENTIALS, FABRIKA_IAM_OIDC_CLIENT_SECRET: 'real-secret' }).oidc?.clientSecret)
			.toBe('real-secret')
		expect(() => parse([...REQUIRED, '--oidc-client-id=real'])).toThrow('OIDC is not among the IAM authentication methods')
	})

	test('Resend needs a sender and its key; none refuses a sender', () => {
		const resend = required('--email-provider=resend')
		expect(() => parse(resend)).toThrow('FABRIKA_EMAIL_FROM is missing')
		const withSender = [...resend, '--email-from=Fabrika <auth@example.com>']
		expect(() => parse(withSender)).toThrow('FABRIKA_EMAIL_RESEND_API_KEY is missing')
		const email = parse(withSender, { ...CREDENTIALS, FABRIKA_EMAIL_RESEND_API_KEY: 're_key' }).email
		expect(email.kind === 'provider' ? [Object.fromEntries(email.variables), [...email.secretNames]] : email).toEqual([
			{ FABRIKA_EMAIL_PROVIDER: 'resend', FABRIKA_EMAIL_FROM: 'Fabrika <auth@example.com>', FABRIKA_EMAIL_RESEND_API_KEY: 're_key' },
			['FABRIKA_EMAIL_RESEND_API_KEY'],
		])
		expect(() => parse(required('--email-provider=smtp'))).toThrow(
			'FABRIKA_EMAIL_PROVIDER must be none or one of: ahasend, cloudflare, lettermint, postmark, resend, smartemailing',
		)
		expect(() => parse([...REQUIRED, '--email-from=x@example.com'])).toThrow('--email-from was given, but the email provider is none')
		expect(() => parse([...REQUIRED, '--email-from-name=Acme'])).toThrow('--email-from-name was given, but the email provider is none')
	})

	test('SmartEmailing reads its variables from the environment, and a refusal never shows a credential', () => {
		const smartEmailing = [...required('--email-provider=smartemailing'), '--email-from=auth@example.com', '--email-from-name=Acme']
		const missing = refusal(() => parse(smartEmailing, { ...CREDENTIALS, FABRIKA_EMAIL_SMARTEMAILING_API_KEY: 'se_private_key' }))
		expect(missing).toContain('FABRIKA_EMAIL_SMARTEMAILING_USERNAME is missing')
		expect(missing).not.toContain('se_private_key')
		const email = parse(smartEmailing, {
			...CREDENTIALS,
			FABRIKA_EMAIL_SMARTEMAILING_USERNAME: 'user@example.com',
			FABRIKA_EMAIL_SMARTEMAILING_API_KEY: 'se_private_key',
		}).email
		expect(rerunCommand(
			parse(smartEmailing, {
				...CREDENTIALS,
				FABRIKA_EMAIL_SMARTEMAILING_USERNAME: 'user@example.com',
				FABRIKA_EMAIL_SMARTEMAILING_API_KEY: 'se_private_key',
			}),
			'cf-account',
		)).toContain('--email-provider=smartemailing --email-from=auth@example.com --email-from-name=Acme')
		expect(email.kind === 'provider' ? [...email.secretNames].sort() : []).toEqual([
			'FABRIKA_EMAIL_SMARTEMAILING_API_KEY',
			'FABRIKA_EMAIL_SMARTEMAILING_USERNAME',
		])
	})

	test('the checkout is --checkout or the default name, refused inside another repository', () => {
		expect(parse([...REQUIRED, '--checkout=elsewhere']).checkout).toBe(join(CWD, 'elsewhere'))
		const repository = mkdtempSync(join(tmpdir(), 'cloudflare-init-repo-'))
		try {
			mkdirSync(join(repository, '.git'))
			expect(() => parseInitArgs(REQUIRED, CREDENTIALS, repository)).toThrow('would sit inside the git repository')
		} finally {
			rmSync(repository, { recursive: true, force: true })
		}
	})

	test('the rerun command repeats every value but the credentials, quoted for a shell', () => {
		const input = parse(
			[
				...REQUIRED.filter((arg) => arg !== '--email-provider=none'),
				'--email-provider=resend',
				'--email-from=Fabrika <auth@example.com>',
				'--admins=ops@example.com',
			],
			{ ...CREDENTIALS, FABRIKA_EMAIL_RESEND_API_KEY: 're_secret_key' },
		)
		const command = rerunCommand(input, 'cf-account')

		expect(command).toBe(
			'fabrika platform init --provider=cloudflare acme --account-id=cf-account --repo=acme/fabrika-platform '
				+ '--console-host=fabrika.example.com --operations-host=errors.example.com --iam-host=iam.example.com '
				+ "--auth-methods=password --email-provider=resend '--email-from=Fabrika <auth@example.com>' --admins=ops@example.com "
				+ `--checkout=${join(CWD, 'fabrika-platform-acme')}`,
		)
		expect(command).not.toContain(API_TOKEN)
		expect(command).not.toContain('re_secret_key')
	})
})

interface Recorded {
	readonly asked: string[]
	readonly effects: string[]
	readonly scaffolds: ScaffoldInput[]
	readonly environments: EnvironmentConfig[]
}

const recorder = (options: { readonly confirms?: Record<string, boolean>; readonly verified?: boolean }) => {
	const recorded: Recorded = { asked: [], effects: [], scaffolds: [], environments: [] }
	const collaborators: InitCollaborators = {
		prompts: {
			confirm: (question, defaultYes) => {
				recorded.asked.push(question)
				return Promise.resolve(options.confirms?.[question] ?? defaultYes ?? false)
			},
		},
		effects: {
			repositoryExists: (repo) => {
				recorded.effects.push(`repositoryExists ${repo}`)
				return Promise.resolve(false)
			},
			listAccounts: () => {
				recorded.effects.push('listAccounts')
				return Promise.resolve([{ id: 'cf-account', name: 'Acme' }])
			},
			verifyToken: () => {
				recorded.effects.push('verifyToken')
				return Promise.resolve(options.verified ?? true)
			},
			findZone: (_token, hostname) => {
				recorded.effects.push(`findZone ${hostname}`)
				return Promise.resolve({ id: 'zone', name: 'example.com' })
			},
			scaffold: (input) => {
				recorded.effects.push('scaffold')
				recorded.scaffolds.push(input)
				return Promise.resolve({ dir: input.dir, created: true })
			},
			configureEnvironment: (config) => {
				recorded.effects.push('configureEnvironment')
				recorded.environments.push(config)
				return Promise.resolve()
			},
			triggerWorkflow: (repo) => {
				recorded.effects.push(`triggerWorkflow ${repo}`)
				return Promise.resolve()
			},
		},
	}
	return { recorded, collaborators }
}

/** Run with an env file in a throwaway XDG home, restoring every variable the run persisted. */
const withEnvFile = async (run: () => Promise<void>): Promise<{ output: string; persisted: Record<string, string> }> => {
	const configHome = await mkdtemp(join(tmpdir(), 'cloudflare-init-xdg-'))
	const saved = { ...process.env }
	const lines: string[] = []
	const stdout = spyOn(console, 'log').mockImplementation((...values) => {
		lines.push(values.map((value) => String(value)).join(' '))
	})
	process.env['XDG_CONFIG_HOME'] = configHome
	try {
		await openEnvFile('acme')
		await run()
		const file = Bun.file(envPath())
		return { output: lines.join('\n'), persisted: (await file.exists()) ? parseEnvFile(await file.text()) : {} }
	} finally {
		stdout.mockRestore()
		for (const name of Object.keys(process.env)) {
			if (!(name in saved)) delete process.env[name]
		}
		Object.assign(process.env, saved)
		await rm(configHome, { recursive: true, force: true })
	}
}

const SCAFFOLD_QUESTION = 'Create acme/fabrika-platform (private) on GitHub and push the platform pipeline?'
const ENVIRONMENT_QUESTION = 'Write them to the acme Environment now (secret VALUES go to GitHub over `gh` stdin)?'
const TRIGGER_QUESTION = 'Run the platform workflow on acme/fabrika-platform now?'
const WRITE_QUESTIONS = [SCAFFOLD_QUESTION, ENVIRONMENT_QUESTION, TRIGGER_QUESTION] as const

describe('Cloudflare init flow', () => {
	test('a full run confirms each GitHub write and writes the Environment it always wrote', async () => {
		const input = parse([...REQUIRED, '--admins=ops@example.com', '--yes'])
		const { recorded, collaborators } = recorder({})
		const { output, persisted } = await withEnvFile(() => runInit(input, collaborators))

		expect(recorded.asked).toEqual([...WRITE_QUESTIONS])
		expect(recorded.effects).toEqual([
			'listAccounts',
			'verifyToken',
			'findZone fabrika.example.com',
			'findZone errors.example.com',
			'repositoryExists acme/fabrika-platform',
			'scaffold',
			'configureEnvironment',
			'triggerWorkflow acme/fabrika-platform',
		])
		expect(recorded.scaffolds).toEqual([{ repo: 'acme/fabrika-platform', account: 'acme', dir: join(CWD, 'fabrika-platform-acme') }])
		const environment = recorded.environments[0]
		expect(environment?.environment).toBe('acme')
		expect(environment?.secrets['CLOUDFLARE_ACCOUNT_ID']).toBe('cf-account')
		expect(environment?.secrets['CLOUDFLARE_API_TOKEN']).toBe(API_TOKEN)
		expect(environment?.vars).toEqual({
			FABRIKA_CONTROL_DOMAIN: 'fabrika.example.com',
			OPERATIONS_HOSTNAME: 'errors.example.com',
			FABRIKA_IAM_ISSUER: 'https://iam.example.com',
			FABRIKA_CONTROL_BOOTSTRAP_ADMINS: '["ops@example.com"]',
			FABRIKA_IAM_HOSTNAME: 'iam.example.com',
			FABRIKA_IAM_OIDC_ENABLED: 'false',
			FABRIKA_IAM_PASSWORD_ENABLED: 'true',
			FABRIKA_EMAIL_PROVIDER: 'none',
			FABRIKA_IAM_BOOTSTRAP_ADMINS: '["ops@example.com"]',
		})
		expect(persisted['CLOUDFLARE_ACCOUNT_ID']).toBe('cf-account')
		expect(persisted['FABRIKA_IAM_PASSWORD_ENABLED']).toBe('true')
		expect(output).not.toContain(API_TOKEN)
	})

	test('declining an unverified token writes nothing and prints the command that repeats the run', async () => {
		const input = parse(REQUIRED)
		const { recorded, collaborators } = recorder({ verified: false, confirms: { 'Proceed anyway?': false } })
		const { output, persisted } = await withEnvFile(() => runInit(input, collaborators))

		expect(recorded.asked).toEqual(['Proceed anyway?'])
		expect(recorded.effects).toEqual(['listAccounts', 'verifyToken'])
		expect(persisted).toEqual({})
		expect(output).toContain(rerunCommand(input, 'cf-account'))
		expect(output).not.toContain(API_TOKEN)
	})

	test('declining the scaffold pushes nothing and stops every later write', async () => {
		const input = parse(REQUIRED)
		const { recorded, collaborators } = recorder({ confirms: { [SCAFFOLD_QUESTION]: false } })
		const { output } = await withEnvFile(() => runInit(input, collaborators))

		expect(recorded.asked).toEqual([SCAFFOLD_QUESTION])
		expect(recorded.effects).not.toContain('scaffold')
		expect(recorded.effects).not.toContain('configureEnvironment')
		expect(recorded.effects).not.toContain('triggerWorkflow acme/fabrika-platform')
		expect(output).toContain(rerunCommand(input, 'cf-account'))
	})

	test('declining the Environment write stops before the trigger', async () => {
		const input = parse(REQUIRED)
		const { recorded, collaborators } = recorder({ confirms: { [ENVIRONMENT_QUESTION]: false } })
		const { output } = await withEnvFile(() => runInit(input, collaborators))

		expect(recorded.asked).toEqual([SCAFFOLD_QUESTION, ENVIRONMENT_QUESTION])
		expect(recorded.effects).toContain('scaffold')
		expect(recorded.effects).not.toContain('configureEnvironment')
		expect(recorded.effects).not.toContain('triggerWorkflow acme/fabrika-platform')
		expect(output).toContain(rerunCommand(input, 'cf-account'))
	})

	test('OIDC, password and Resend together write every variable and secret they need', async () => {
		const input = parse(
			required(
				'--auth-methods=oidc,password',
				'--email-provider=resend',
				'--oidc-issuer=https://sso.example.com',
				'--oidc-client-id=client-1',
				'--human-email-domains=example.com,example.org',
				'--email-from=Fabrika <auth@example.com>',
				'--admins=ops@example.com',
			),
			{ ...CREDENTIALS, FABRIKA_IAM_OIDC_CLIENT_SECRET: 'oidc-secret', FABRIKA_EMAIL_RESEND_API_KEY: 're_key' },
		)
		const { recorded, collaborators } = recorder({})
		const { output } = await withEnvFile(() => runInit(input, collaborators))

		const environment = recorded.environments[0]
		expect(environment?.vars).toEqual({
			FABRIKA_CONTROL_DOMAIN: 'fabrika.example.com',
			OPERATIONS_HOSTNAME: 'errors.example.com',
			FABRIKA_IAM_ISSUER: 'https://iam.example.com',
			FABRIKA_CONTROL_BOOTSTRAP_ADMINS: '["ops@example.com"]',
			FABRIKA_IAM_HOSTNAME: 'iam.example.com',
			FABRIKA_IAM_OIDC_ENABLED: 'true',
			FABRIKA_IAM_PASSWORD_ENABLED: 'true',
			FABRIKA_EMAIL_PROVIDER: 'resend',
			FABRIKA_IAM_OIDC_ISSUER: 'https://sso.example.com',
			FABRIKA_IAM_OIDC_CLIENT_ID: 'client-1',
			FABRIKA_IAM_HUMAN_EMAIL_DOMAINS: '["example.com","example.org"]',
			FABRIKA_EMAIL_FROM: 'Fabrika <auth@example.com>',
			FABRIKA_IAM_BOOTSTRAP_ADMINS: '["ops@example.com"]',
		})
		const secrets = environment?.secrets ?? {}
		expect(Object.keys(secrets).sort()).toEqual([
			'CLOUDFLARE_ACCOUNT_ID',
			'CLOUDFLARE_API_TOKEN',
			'FABRIKA_CONTROL_VAULT_KEY',
			'FABRIKA_EMAIL_RESEND_API_KEY',
			'FABRIKA_IAM_OIDC_CLIENT_SECRET',
			'FABRIKA_IAM_PROVISIONING_KEY',
			'FABRIKA_IAM_SIGNING_KEYS',
			'FABRIKA_RUNNER_KEY',
			'OPERATIONS_SYNC_KEY',
		])
		expect(secrets['CLOUDFLARE_ACCOUNT_ID']).toBe('cf-account')
		expect(secrets['CLOUDFLARE_API_TOKEN']).toBe(API_TOKEN)
		expect(secrets['FABRIKA_IAM_OIDC_CLIENT_SECRET']).toBe('oidc-secret')
		expect(secrets['FABRIKA_EMAIL_RESEND_API_KEY']).toBe('re_key')
		expect(secrets['FABRIKA_IAM_PROVISIONING_KEY']).toStartWith('px_')
		// The account id is stored as a secret but is not a credential: init names the account it deploys into.
		for (const [name, value] of Object.entries(secrets)) {
			if (name !== 'CLOUDFLARE_ACCOUNT_ID') expect(output).not.toContain(value)
		}
	})

	test('SmartEmailing splits its credentials into secrets and the rest into variables, and persists every entry', async () => {
		const input = parse(
			[...required('--email-provider=smartemailing'), '--email-from=auth@example.com', '--email-from-name=Acme'],
			{
				...CREDENTIALS,
				FABRIKA_EMAIL_SMARTEMAILING_USERNAME: 'se_private_user',
				FABRIKA_EMAIL_SMARTEMAILING_API_KEY: 'se_private_key',
				FABRIKA_EMAIL_SMARTEMAILING_TAG: 'fabrika',
			},
		)
		const { recorded, collaborators } = recorder({})
		const { output, persisted } = await withEnvFile(() => runInit(input, collaborators))

		const environment = recorded.environments[0]
		expect(environment?.secrets['FABRIKA_EMAIL_SMARTEMAILING_USERNAME']).toBe('se_private_user')
		expect(environment?.secrets['FABRIKA_EMAIL_SMARTEMAILING_API_KEY']).toBe('se_private_key')
		const mailVariables = Object.entries(environment?.vars ?? {}).filter(([name]) => name.startsWith('FABRIKA_EMAIL_'))
		expect(Object.fromEntries(mailVariables)).toEqual({
			FABRIKA_EMAIL_PROVIDER: 'smartemailing',
			FABRIKA_EMAIL_FROM: 'auth@example.com',
			FABRIKA_EMAIL_FROM_NAME: 'Acme',
			FABRIKA_EMAIL_SMARTEMAILING_TAG: 'fabrika',
		})
		expect(Object.keys(environment?.secrets ?? {})).not.toContain('FABRIKA_EMAIL_RESEND_API_KEY')
		for (
			const name of [
				'FABRIKA_EMAIL_PROVIDER',
				'FABRIKA_EMAIL_FROM',
				'FABRIKA_EMAIL_FROM_NAME',
				'FABRIKA_EMAIL_SMARTEMAILING_USERNAME',
				'FABRIKA_EMAIL_SMARTEMAILING_API_KEY',
				'FABRIKA_EMAIL_SMARTEMAILING_TAG',
			]
		) {
			expect(persisted[name]).toBeDefined()
		}
		expect(output).not.toContain('se_private_')
	})

	test('declining the trigger leaves the run to the operator', async () => {
		const input = parse(REQUIRED)
		const { recorded, collaborators } = recorder({ confirms: { [TRIGGER_QUESTION]: false } })
		const { output } = await withEnvFile(() => runInit(input, collaborators))

		expect(recorded.effects).not.toContain('triggerWorkflow acme/fabrika-platform')
		expect(output).toContain('gh workflow run platform.yml --repo acme/fabrika-platform')
	})

	test('a resumed run reuses the generated keys it persisted', async () => {
		const input = parse(REQUIRED)
		const first = recorder({})
		const second = recorder({})
		await withEnvFile(async () => {
			await runInit(input, first.collaborators)
			await runInit(input, second.collaborators)
		})

		expect(second.recorded.environments[0]?.secrets).toEqual(first.recorded.environments[0]?.secrets ?? {})
	})
})
