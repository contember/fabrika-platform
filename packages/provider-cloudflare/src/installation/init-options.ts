// The CLI surface of `fabrika platform init --provider=cloudflare`, parsed once.
//
// Every CREDENTIAL comes from the environment and only from the environment; everything else may come
// from a flag OR the environment variable beside it, flag first. The variables are the names the
// account's GitHub Environment carries, and the installer env file resumes into them. Nothing here
// prompts — a missing required value is an error naming both the flag and the variable — so a
// pipeline or an agent drives init end to end. Its confirmations stay, answered by `--yes`.

import {
	CHECKOUT_FLAG,
	type CommandEnv,
	readEnv,
	readFlag,
	requiredSetting,
	setting,
	shellWord,
	sidecarCheckoutDir,
	UNATTENDED_FLAG,
} from '@fabrika/installation-init'
import { z } from 'zod'

/**
 * Placeholder OIDC — the client id an operator gets by naming none, to bring the base up BEFORE wiring
 * a real SSO provider. IAM boots, machine auth and the bootstrap-admin hatch work; only human SSO login
 * is inert until a real `FABRIKA_IAM_OIDC_CLIENT_ID`/`_SECRET` replace these. The issuer stays a real
 * discoverable host so IAM's OIDC discovery doesn't fail at boot.
 */
export const PLACEHOLDER_OIDC_CLIENT_ID = 'placeholder.apps.googleusercontent.com'
export const PLACEHOLDER_OIDC_CLIENT_SECRET = 'placeholder-oidc-client-secret-rotate-when-sso-wired'
const DEFAULT_OIDC_ISSUER = 'https://accounts.google.com'

export interface OidcInput {
	readonly issuer: string
	/** `PLACEHOLDER_OIDC_CLIENT_ID` when the operator deferred real SSO. */
	readonly clientId: string
	/** Environment only. The placeholder secret pairs with the placeholder client id. */
	readonly clientSecret: string
	/** Email domains admitted as a human at IAM login (self-provisioning allowlist). */
	readonly humanEmailDomains: readonly string[]
}

export type EmailInput =
	| { readonly provider: 'none' }
	| { readonly provider: 'resend'; readonly from: string; /** Environment only. */ readonly apiKey: string }

/** Every input `runInit` takes from the operator. */
export interface InitInput {
	/** Names the GitHub Environment, the installer env file, the default repository and checkout. */
	readonly account: string
	/** Absent: the one account the token can act on. */
	readonly accountId?: string
	/** The Cloudflare account API token. Environment only. */
	readonly apiToken: string
	readonly repo: string
	/** The absolute local checkout directory of `repo`. */
	readonly checkout: string
	readonly hosts: { readonly control: string; readonly operations: string; readonly iam: string }
	/** Absent when OIDC login is not enabled. */
	readonly oidc?: OidcInput
	readonly passwordEnabled: boolean
	readonly email: EmailInput
	/** First-admin emails for the escape hatch, admitted to both control and IAM. */
	readonly bootstrapAdmins: readonly string[]
	/** `--yes`: answer every confirmation yes. */
	readonly unattended: boolean
}

const FLAGS = [
	'--account-id',
	'--repo',
	'--console-host',
	'--operations-host',
	'--iam-host',
	'--admins',
	'--auth-methods',
	'--oidc-issuer',
	'--oidc-client-id',
	'--human-email-domains',
	'--email-provider',
	'--email-from',
	CHECKOUT_FLAG,
] as const

const REPO_PATTERN = /^[^/\s]+\/[^/\s]+$/

const AUTH_METHODS = ['oidc', 'password'] as const

const assertKnownArguments = (argv: readonly string[]): void => {
	for (const arg of argv) {
		if (arg === UNATTENDED_FLAG || !arg.startsWith('-')) {
			continue
		}
		const name = arg.split('=')[0] ?? arg
		if (!FLAGS.some((flag) => flag === name) || !arg.includes('=')) {
			throw new Error(
				`unexpected argument \`${name}\`${
					arg.includes('=') ? ' (its value is not shown)' : ''
				}. Credentials are read from the environment and have no flag; run `
					+ '`fabrika platform init --provider=cloudflare --help` for the surface',
			)
		}
	}
}

/**
 * The account name, after refusing any argument init does not know.
 *
 * Read on its own because the installer env file is named after it, and that file has to be loaded
 * before the rest is parsed: a resumed run reads its earlier answers from it.
 */
export const parseInitAccount = (argv: readonly string[]): string => {
	assertKnownArguments(argv)
	const positional = argv.filter((arg) => !arg.startsWith('-')).map((arg) => arg.trim())
	if (positional.length > 1) {
		throw new Error('unexpected second positional argument (its value is not shown): name ONE account')
	}
	const account = positional[0]
	if (account === undefined || account === '') {
		throw new Error('Cloudflare installation init requires an account name, for example `fabrika platform init --provider=cloudflare acme`')
	}
	return account
}

/** A credential, with the one message that says why there is no flag for it. */
const credential = (env: CommandEnv, variable: string, what: string): string => {
	const value = readEnv(env, variable)
	if (value === undefined) {
		throw new Error(`${variable} is required: ${what}. It has no flag — a credential on a command line lands in logs and shell history`)
	}
	return value
}

/** A bare hostname: no scheme, path, port or credentials. */
const checkedHost = (value: string, flag: string, variable: string): string => {
	const host = value.toLowerCase()
	const parsed = URL.canParse(`https://${host}`) ? new URL(`https://${host}`) : undefined
	if (parsed === undefined || parsed.hostname !== host || parsed.pathname !== '/' || !host.includes('.')) {
		throw new Error(`${flag} / ${variable} must be a bare hostname such as iam.example.com, not \`${value}\``)
	}
	return host
}

const requiredHost = (argv: readonly string[], env: CommandEnv, flag: string, variable: string): string =>
	checkedHost(requiredSetting(setting(argv, env, flag, variable), flag, variable), flag, variable)

const listSchema = z.array(z.string())

/** A comma-separated list, or the JSON array the GitHub Environment stores under the same variable. */
const parseList = (raw: string | undefined, flag: string, variable: string): string[] => {
	if (raw === undefined) return []
	if (!raw.startsWith('[')) return raw.split(',').map((item) => item.trim()).filter((item) => item !== '')
	let decoded: unknown
	try {
		decoded = JSON.parse(raw)
	} catch {
		decoded = undefined
	}
	const parsed = listSchema.safeParse(decoded)
	if (!parsed.success) {
		throw new Error(`${flag} / ${variable} must be a comma-separated list or a JSON array of strings`)
	}
	return parsed.data.map((item) => item.trim()).filter((item) => item !== '')
}

const parseBoolean = (value: string, name: string): boolean => {
	if (value === 'true') return true
	if (value === 'false') return false
	throw new Error(`${name} must be true or false`)
}

interface AuthMethods {
	readonly oidcEnabled: boolean
	readonly passwordEnabled: boolean
}

/** `--auth-methods`, or the pair of switches the Environment carries. */
const readAuthMethods = (argv: readonly string[], env: CommandEnv): AuthMethods => {
	const flag = readFlag(argv, '--auth-methods')
	if (flag !== undefined) {
		const methods = flag.split(',').map((item) => item.trim())
		const unknown = methods.find((method) => !AUTH_METHODS.some((known) => known === method))
		if (unknown !== undefined || methods.length > AUTH_METHODS.length) {
			throw new Error(`--auth-methods takes oidc, password, or oidc,password — not \`${flag}\``)
		}
		return { oidcEnabled: methods.includes('oidc'), passwordEnabled: methods.includes('password') }
	}
	const oidc = readEnv(env, 'FABRIKA_IAM_OIDC_ENABLED')
	const password = readEnv(env, 'FABRIKA_IAM_PASSWORD_ENABLED')
	if (oidc === undefined && password === undefined) {
		throw new Error('--auth-methods=<oidc|password|oidc,password> or FABRIKA_IAM_OIDC_ENABLED + FABRIKA_IAM_PASSWORD_ENABLED is required')
	}
	if (oidc === undefined || password === undefined) {
		throw new Error('FABRIKA_IAM_OIDC_ENABLED and FABRIKA_IAM_PASSWORD_ENABLED must be configured together')
	}
	const methods = {
		oidcEnabled: parseBoolean(oidc, 'FABRIKA_IAM_OIDC_ENABLED'),
		passwordEnabled: parseBoolean(password, 'FABRIKA_IAM_PASSWORD_ENABLED'),
	}
	if (!methods.oidcEnabled && !methods.passwordEnabled) {
		throw new Error('At least one IAM authentication method must be enabled')
	}
	return methods
}

/** A flag that only means something under a selection the run did not make is refused, not ignored. */
const refuseFlags = (argv: readonly string[], flags: readonly string[], why: string): void => {
	const given = flags.find((flag) => readFlag(argv, flag) !== undefined)
	if (given !== undefined) {
		throw new Error(`${given} was given, but ${why}`)
	}
}

const readOidc = (argv: readonly string[], env: CommandEnv): OidcInput => {
	const issuer = setting(argv, env, '--oidc-issuer', 'FABRIKA_IAM_OIDC_ISSUER') ?? DEFAULT_OIDC_ISSUER
	if (!URL.canParse(issuer)) {
		throw new Error(`--oidc-issuer / FABRIKA_IAM_OIDC_ISSUER is not a URL: \`${issuer}\``)
	}
	const clientId = setting(argv, env, '--oidc-client-id', 'FABRIKA_IAM_OIDC_CLIENT_ID') ?? PLACEHOLDER_OIDC_CLIENT_ID
	const humanEmailDomains = parseList(
		setting(argv, env, '--human-email-domains', 'FABRIKA_IAM_HUMAN_EMAIL_DOMAINS'),
		'--human-email-domains',
		'FABRIKA_IAM_HUMAN_EMAIL_DOMAINS',
	)
	if (clientId === PLACEHOLDER_OIDC_CLIENT_ID) {
		return {
			issuer,
			clientId,
			clientSecret: readEnv(env, 'FABRIKA_IAM_OIDC_CLIENT_SECRET') ?? PLACEHOLDER_OIDC_CLIENT_SECRET,
			humanEmailDomains,
		}
	}
	const clientSecret = credential(env, 'FABRIKA_IAM_OIDC_CLIENT_SECRET', `the OIDC client secret for client ${clientId}`)
	if (clientSecret === PLACEHOLDER_OIDC_CLIENT_SECRET) {
		throw new Error(
			`FABRIKA_IAM_OIDC_CLIENT_SECRET still holds the placeholder secret, but client ${clientId} is a real one. `
				+ 'Set the real secret in the environment',
		)
	}
	return { issuer, clientId, clientSecret, humanEmailDomains }
}

const readEmail = (argv: readonly string[], env: CommandEnv): EmailInput => {
	const provider = requiredSetting(setting(argv, env, '--email-provider', 'FABRIKA_EMAIL_PROVIDER'), '--email-provider', 'FABRIKA_EMAIL_PROVIDER')
	if (provider === 'none') {
		refuseFlags(argv, ['--email-from'], 'the email provider is none')
		return { provider }
	}
	if (provider !== 'resend') {
		throw new Error(`--email-provider / FABRIKA_EMAIL_PROVIDER must be none or resend, not \`${provider}\``)
	}
	return {
		provider,
		from: requiredSetting(setting(argv, env, '--email-from', 'FABRIKA_EMAIL_FROM'), '--email-from', 'FABRIKA_EMAIL_FROM'),
		apiKey: credential(env, 'FABRIKA_EMAIL_RESEND_API_KEY', 'the Resend API key the email transport sends with'),
	}
}

const readRepo = (argv: readonly string[], account: string): string => {
	const repo = readFlag(argv, '--repo')
	if (repo === undefined) {
		return `${account}/fabrika-platform`
	}
	if (!REPO_PATTERN.test(repo)) {
		throw new Error(`\`${repo}\` is not a <owner>/<name> repository`)
	}
	return repo
}

/**
 * Parse the command's arguments and environment into the one input `runInit` takes.
 *
 * `env` must already hold the installer env file's values (`openEnvFile`), so a resumed run reuses them.
 */
export const parseInitArgs = (argv: readonly string[], env: CommandEnv, cwd: string = process.cwd()): InitInput => {
	const account = parseInitAccount(argv)
	const methods = readAuthMethods(argv, env)
	const accountId = setting(argv, env, '--account-id', 'CLOUDFLARE_ACCOUNT_ID')
	if (!methods.oidcEnabled) {
		refuseFlags(argv, ['--oidc-issuer', '--oidc-client-id', '--human-email-domains'], 'OIDC is not among the IAM authentication methods')
	}
	return {
		account,
		apiToken: credential(env, 'CLOUDFLARE_API_TOKEN', "the Cloudflare account API token; it also becomes the control plane's runtime token"),
		repo: readRepo(argv, account),
		checkout: sidecarCheckoutDir(readFlag(argv, CHECKOUT_FLAG), `fabrika-platform-${account}`, cwd),
		hosts: {
			control: requiredHost(argv, env, '--console-host', 'FABRIKA_CONTROL_DOMAIN'),
			operations: requiredHost(argv, env, '--operations-host', 'OPERATIONS_HOSTNAME'),
			iam: requiredHost(argv, env, '--iam-host', 'FABRIKA_IAM_HOSTNAME'),
		},
		passwordEnabled: methods.passwordEnabled,
		email: readEmail(argv, env),
		bootstrapAdmins: parseList(
			setting(argv, env, '--admins', 'FABRIKA_CONTROL_BOOTSTRAP_ADMINS'),
			'--admins',
			'FABRIKA_CONTROL_BOOTSTRAP_ADMINS',
		),
		unattended: argv.includes(UNATTENDED_FLAG),
		...(methods.oidcEnabled ? { oidc: readOidc(argv, env) } : {}),
		...(accountId === undefined ? {} : { accountId }),
	}
}

/** The command that repeats this run, with every value but the credentials, which stay in the environment. */
export const rerunCommand = (input: InitInput, accountId: string): string =>
	[
		'fabrika platform init --provider=cloudflare',
		...[
			input.account,
			`--account-id=${accountId}`,
			`--repo=${input.repo}`,
			`--console-host=${input.hosts.control}`,
			`--operations-host=${input.hosts.operations}`,
			`--iam-host=${input.hosts.iam}`,
			`--auth-methods=${[...(input.oidc === undefined ? [] : ['oidc']), ...(input.passwordEnabled ? ['password'] : [])].join(',')}`,
			...(input.oidc === undefined ? [] : [
				`--oidc-issuer=${input.oidc.issuer}`,
				...(input.oidc.clientId === PLACEHOLDER_OIDC_CLIENT_ID ? [] : [`--oidc-client-id=${input.oidc.clientId}`]),
				...(input.oidc.humanEmailDomains.length === 0 ? [] : [`--human-email-domains=${input.oidc.humanEmailDomains.join(',')}`]),
			]),
			`--email-provider=${input.email.provider}`,
			...(input.email.provider === 'resend' ? [`--email-from=${input.email.from}`] : []),
			...(input.bootstrapAdmins.length === 0 ? [] : [`--admins=${input.bootstrapAdmins.join(',')}`]),
			`${CHECKOUT_FLAG}=${input.checkout}`,
		].map(shellWord),
	].join(' ')
