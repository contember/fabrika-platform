// The CLI surface of `fabrika platform install --provider=zerops`, parsed once.
//
// The same two rules `deploy-options.ts` states, for the same reasons: every CREDENTIAL comes from the
// environment and only from the environment (there is no `--token`, and an unknown flag is an error, so
// one cannot arrive on a command line), and everything else may come from a flag OR the environment.
//
// Unlike a deploy this command is INTERACTIVE — it confirms before every step that leaves the
// operator's disk — but nothing here prompts: a missing required value is an error naming both the flag
// and the variable that would supply it, so a mistyped install fails before it contacts anything.

/** The only tier a bootstrap can install. See `assertInstallableTier`. */
export type InstallablePlatformTier = 'light'

/** Every input `runInstall` takes from the operator. */
export interface PlatformInstallInput {
	/** The project the operator created, empty, by hand. */
	readonly projectId: string
	/** The client the project belongs to — required, because the control plane's token is minted on it. */
	readonly clientId: string
	/** Zerops personal access token. Environment only. */
	readonly accessToken: string
	/** Region API base, when the installation is not on the default one. */
	readonly apiBaseUrl?: string
	/** The name this installation calls itself — written to every platform service as `ENVIRONMENT`. */
	readonly environment: string
	/** The scheme a browser speaks to this installation. */
	readonly scheme: 'http' | 'https'
	/** Public Git URL every service builds from. Effectively mandatory here — see the usage text. */
	readonly buildFromGit: string
	readonly tier: InstallablePlatformTier
	/** `--yes`: answer every confirmation yes, for a bring-up with nobody at the keyboard. */
	readonly unattended: boolean
}

/** The public repository every installation is built from, and the default for `--from-git`. */
export const FABRIKA_REPOSITORY_URL = 'https://github.com/contember/fabrika-platform'

const FLAGS = ['--project-id', '--client-id', '--env', '--scheme', '--from-git', '--tier'] as const

/**
 * The one way this command runs with nobody watching it.
 *
 * Every confirmation defaults to yes, so a pipe carrying blank lines answers all six of them with
 * nobody reading what they agree to — which is why saying yes unattended is a FLAG and never an
 * inference: it makes the choice explicit, and it puts it in the shell history of whoever ran it.
 */
export const UNATTENDED_FLAG = '--yes'

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
		if (arg === UNATTENDED_FLAG) {
			continue
		}
		const name = arg.split('=')[0] ?? arg
		if (!FLAGS.some((flag) => flag === name) || !arg.includes('=')) {
			throw new Error(
				`unexpected argument \`${arg}\`. Credentials are read from the environment and have no flag; run `
					+ '`fabrika platform install --provider=zerops --help` for the surface',
			)
		}
	}
}

/**
 * The tier this command can bring up.
 *
 * Only `light`, and that is a property of the topology rather than a limitation of the flow: the light
 * tier is the only one that emits a services-only provisioning document, because it is the only one an
 * operator installs into a project they created themselves. The standard tier is TWO projects that
 * fabrika creates, which is a different command with a different failure mode.
 */
const assertInstallableTier = (raw: string | undefined): InstallablePlatformTier => {
	if (raw === undefined || raw === 'light') {
		return 'light'
	}
	throw new Error(
		`--tier=${raw} cannot be installed into a project you created: only the light tier emits a services-only `
			+ 'provisioning document. The standard tier is two projects fabrika creates itself',
	)
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

/** Parse the command's arguments and environment into the one input `runInstall` takes. */
export const parsePlatformInstallArgs = (
	argv: readonly string[],
	env: Record<string, string | undefined>,
): PlatformInstallInput => {
	assertKnownArguments(argv)
	const apiBaseUrl = readEnv(env, 'FABRIKA_ZEROPS_API_URL')
	return {
		projectId: required(setting(argv, env, '--project-id', 'FABRIKA_ZEROPS_PROJECT_ID'), '--project-id', 'FABRIKA_ZEROPS_PROJECT_ID'),
		// Named even when the project id is known: `POST /client/{id}/integration-token` is addressed by
		// CLIENT, and the project read does not hand one back.
		clientId: required(setting(argv, env, '--client-id', 'FABRIKA_ZEROPS_CLIENT_ID'), '--client-id', 'FABRIKA_ZEROPS_CLIENT_ID'),
		accessToken: required(readEnv(env, 'FABRIKA_ZEROPS_ACCESS_TOKEN'), '(no flag)', 'FABRIKA_ZEROPS_ACCESS_TOKEN'),
		environment: required(setting(argv, env, '--env', 'FABRIKA_PLATFORM_ENVIRONMENT'), '--env', 'FABRIKA_PLATFORM_ENVIRONMENT'),
		scheme: readScheme(argv, env),
		buildFromGit: setting(argv, env, '--from-git', 'FABRIKA_ZEROPS_BUILD_FROM_GIT') ?? FABRIKA_REPOSITORY_URL,
		tier: assertInstallableTier(setting(argv, env, '--tier', 'FABRIKA_PLATFORM_TIER')),
		unattended: argv.includes(UNATTENDED_FLAG),
		...(apiBaseUrl === undefined ? {} : { apiBaseUrl }),
	}
}
