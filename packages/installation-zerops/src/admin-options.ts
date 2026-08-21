// The CLI surface of `fabrika platform admin --provider=zerops`, parsed once.
//
// The same two rules `install-options.ts` and `deploy-options.ts` state: the CREDENTIAL comes from the
// environment and only from the environment (there is no `--key`, and an unknown flag is an error, so
// one cannot arrive on a command line), and everything else may come from a flag OR the environment.
//
// The command is unattended by construction — it is additive and idempotent, so it confirms nothing
// and prompts for nothing — and a missing required value is an error naming both the flag and the
// variable that would supply it.

/** Every input `runPlatformAdmin` takes from the operator. */
export interface PlatformAdminInput {
	/** The mailbox that identifies the first administrator. */
	readonly email: string
	/** IAM's public hostname — the address the proxy fronts, as `platform deploy` names it. */
	readonly iamHost: string
	/** The scheme a browser speaks to this installation. With `iamHost` it composes IAM's public origin. */
	readonly scheme: 'http' | 'https'
	/** The `px_` provisioning key `platform install` printed. Environment only. */
	readonly provisioningKey: string
	/** Replace an outstanding enrollment instead of reporting it. */
	readonly reissue: boolean
}

const FLAGS = ['--email', '--iam-host', '--scheme'] as const

/**
 * The one way a second enrollment URL is ever issued.
 *
 * Printing the URL once is the property a re-run has to keep, so an outstanding enrollment is
 * REPORTED rather than replaced. An enrollment that expired unopened would otherwise be a dead end —
 * the only other way to issue one is a console nobody can sign in to yet — so the way out is a flag,
 * which makes replacing the outstanding one an explicit choice.
 */
export const REISSUE_FLAG = '--reissue'

const readFlag = (argv: readonly string[], name: string): string | undefined => {
	const prefix = `${name}=`
	const matches = argv.filter((arg) => arg.startsWith(prefix))
	if (matches.length > 1) {
		throw new Error(`${name} was given more than once`)
	}
	const value = matches[0]?.slice(prefix.length)
	return value === undefined || value.trim() === '' ? undefined : value.trim()
}

const readEnv = (env: Record<string, string | undefined>, name: string): string | undefined => {
	const value = env[name]
	return value === undefined || value.trim() === '' ? undefined : value.trim()
}

const setting = (
	argv: readonly string[],
	env: Record<string, string | undefined>,
	flag: string,
	variable: string,
): string | undefined => readFlag(argv, flag) ?? readEnv(env, variable)

const required = (value: string | undefined, flag: string, variable: string): string => {
	if (value === undefined) {
		throw new Error(`${flag}=<value> or ${variable} is required`)
	}
	return value
}

const assertKnownArguments = (argv: readonly string[]): void => {
	for (const arg of argv) {
		if (arg === REISSUE_FLAG) {
			continue
		}
		const name = arg.split('=')[0] ?? arg
		if (!FLAGS.some((flag) => flag === name) || !arg.includes('=')) {
			throw new Error(
				`unexpected argument \`${arg}\`. Credentials are read from the environment and have no flag; run `
					+ '`fabrika platform admin --provider=zerops --help` for the surface',
			)
		}
	}
}

const readScheme = (argv: readonly string[], env: Record<string, string | undefined>): 'http' | 'https' => {
	const raw = setting(argv, env, '--scheme', 'FABRIKA_PLATFORM_SCHEME')
	if (raw === undefined || raw === 'https') {
		return 'https'
	}
	if (raw === 'http') {
		return 'http'
	}
	throw new Error('--scheme must be http or https')
}

/**
 * IAM's public hostname, checked to be one.
 *
 * A BARE hostname, the same coordinate `platform deploy` takes under the same name: the origin is
 * composed from it and `--scheme`, so a value carrying either would compose a second one.
 */
const readIamHost = (argv: readonly string[], env: Record<string, string | undefined>): string => {
	const host = required(setting(argv, env, '--iam-host', 'FABRIKA_PLATFORM_IAM_HOST'), '--iam-host', 'FABRIKA_PLATFORM_IAM_HOST')
	if (host.includes('/') || host.includes(':')) {
		throw new Error(`\`${host}\` is not a bare hostname — a platform host carries no scheme and no port`)
	}
	return host
}

/**
 * The credential, and the one message that says why there is no flag for it.
 *
 * `required` would name a flag beside the variable, and there is none — a key on a command line lands
 * in a CI log, a process listing and the shell history of whoever reproduced the run.
 */
const provisioningKey = (env: Record<string, string | undefined>): string => {
	const value = readEnv(env, 'FABRIKA_IAM_PROVISIONING_KEY')
	if (value === undefined) {
		throw new Error(
			'FABRIKA_IAM_PROVISIONING_KEY is required. It has no flag: the key platform install printed comes from the environment only.',
		)
	}
	return value
}

/** Parse the command's arguments and environment into the one input `runPlatformAdmin` takes. */
export const parsePlatformAdminArgs = (
	argv: readonly string[],
	env: Record<string, string | undefined>,
): PlatformAdminInput => {
	assertKnownArguments(argv)
	return {
		email: required(setting(argv, env, '--email', 'FABRIKA_PLATFORM_ADMIN_EMAIL'), '--email', 'FABRIKA_PLATFORM_ADMIN_EMAIL'),
		iamHost: readIamHost(argv, env),
		scheme: readScheme(argv, env),
		provisioningKey: provisioningKey(env),
		reissue: argv.includes(REISSUE_FLAG),
	}
}
