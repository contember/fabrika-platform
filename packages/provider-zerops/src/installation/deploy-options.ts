// The CLI surface of `fabrika platform deploy --provider=zerops`, parsed once.
//
// ── Two rules the shape enforces ──────────────────────────────────────────────────────────────────
//
//   1. **Every CREDENTIAL comes from the environment and only from the environment.** There is no
//      `--token` and no `--admin-key`, and an unknown flag is an error, so a credential cannot be put
//      on the command line by mistake — where it would land in a CI log, a process listing and the
//      shell history of whoever reproduced the run.
//   2. **Everything else may come from a flag OR the environment, flag first.** A generated workflow
//      writes the environment; a human debugging one overrides a single value without editing it.
//
// The command is unattended by construction: nothing here prompts, and a missing required value is an
// error naming both the flag and the variable that would supply it.

import { readEnv, required, setting } from './cli-options'
import { parsePlatformHosts, parsePlatformScheme } from './placement-options'
import { readInstallationSourceDir } from './source-options'

/** How the project this installation lives in is named. */
export type ZeropsProjectSelector =
	| { readonly kind: 'id'; readonly projectId: string }
	| { readonly kind: 'name'; readonly clientId: string; readonly name: string }

/** Every input `deployPlatform` takes from the operator. */
export interface PlatformDeployInput {
	readonly project: ZeropsProjectSelector
	/** Zerops personal or integration access token. Environment only. */
	readonly accessToken: string
	/** Region API base, when the installation is not on the default one. */
	readonly apiBaseUrl?: string
	/** The name this installation calls itself — written to every platform service as `ENVIRONMENT`. */
	readonly environment: string
	/** All three or none: none derives them from the proxy's Zerops subdomains. */
	readonly hosts?: { readonly iam: string; readonly control: string; readonly operations: string }
	/** The scheme a browser speaks to this installation. `https` unless a local composition says otherwise. */
	readonly scheme: 'http' | 'https'
	readonly sourceDir: string
	/** IAM-issued `px_` admin key, used only to reconcile the console's schema. Environment only. */
	readonly iamAdminKey: string
	/** Read everything, write nothing, trigger nothing. */
	readonly dryRun: boolean
}

const FLAGS = [
	'--project-id',
	'--project-name',
	'--client-id',
	'--env',
	'--iam-host',
	'--console-host',
	'--operations-host',
	'--scheme',
	'--source-dir',
] as const

const assertKnownArguments = (argv: readonly string[]): void => {
	for (const arg of argv) {
		if (arg === '--dry-run') {
			continue
		}
		const name = arg.split('=')[0] ?? arg
		if (!FLAGS.some((flag) => flag === name) || !arg.includes('=')) {
			throw new Error(
				`unexpected argument \`${arg}\`. Credentials are read from the environment and have no flag; run `
					+ '`fabrika platform deploy --provider=zerops --help` for the surface',
			)
		}
	}
}

const readHosts = (
	argv: readonly string[],
	env: Record<string, string | undefined>,
): PlatformDeployInput['hosts'] => {
	const iam = setting(argv, env, '--iam-host', 'FABRIKA_PLATFORM_IAM_HOST')
	const control = setting(argv, env, '--console-host', 'FABRIKA_PLATFORM_CONSOLE_HOST')
	const operations = setting(argv, env, '--operations-host', 'FABRIKA_PLATFORM_OPERATIONS_HOST')
	return parsePlatformHosts({ iam, control, operations })
}

const readScheme = (argv: readonly string[], env: Record<string, string | undefined>): 'http' | 'https' => {
	const raw = setting(argv, env, '--scheme', 'FABRIKA_PLATFORM_SCHEME')
	return parsePlatformScheme(raw)
}

const readProject = (argv: readonly string[], env: Record<string, string | undefined>): ZeropsProjectSelector => {
	const projectId = setting(argv, env, '--project-id', 'FABRIKA_ZEROPS_PROJECT_ID')
	const name = setting(argv, env, '--project-name', 'FABRIKA_ZEROPS_PROJECT_NAME')
	if (projectId !== undefined && name !== undefined) {
		throw new Error('name the project by id or by name, not both')
	}
	if (projectId !== undefined) {
		return { kind: 'id', projectId }
	}
	if (name === undefined) {
		throw new Error('--project-id=<id> or FABRIKA_ZEROPS_PROJECT_ID is required (or --project-name with --client-id)')
	}
	const clientId = required(setting(argv, env, '--client-id', 'FABRIKA_ZEROPS_CLIENT_ID'), '--client-id', 'FABRIKA_ZEROPS_CLIENT_ID')
	return { kind: 'name', clientId, name }
}

/** Parse the command's arguments and environment into the one input `deployPlatform` takes. */
export const parsePlatformDeployArgs = (
	argv: readonly string[],
	env: Record<string, string | undefined>,
): PlatformDeployInput => {
	const sourceDir = readInstallationSourceDir(argv, env)
	assertKnownArguments(argv)
	const dryRun = argv.includes('--dry-run')
	const hosts = readHosts(argv, env)
	const apiBaseUrl = readEnv(env, 'FABRIKA_ZEROPS_API_URL')
	return {
		project: readProject(argv, env),
		// A dry run reads, and reading still needs a token; it is the one credential it cannot do without.
		accessToken: required(readEnv(env, 'FABRIKA_ZEROPS_ACCESS_TOKEN'), '(no flag)', 'FABRIKA_ZEROPS_ACCESS_TOKEN'),
		environment: required(setting(argv, env, '--env', 'FABRIKA_PLATFORM_ENVIRONMENT'), '--env', 'FABRIKA_PLATFORM_ENVIRONMENT'),
		// Not required for a dry run: it authenticates a write this mode never makes.
		iamAdminKey: dryRun
			? readEnv(env, 'FABRIKA_IAM_PROVISIONING_KEY') ?? ''
			: required(readEnv(env, 'FABRIKA_IAM_PROVISIONING_KEY'), '(no flag)', 'FABRIKA_IAM_PROVISIONING_KEY'),
		scheme: readScheme(argv, env),
		dryRun,
		...(hosts === undefined ? {} : { hosts }),
		sourceDir,
		...(apiBaseUrl === undefined ? {} : { apiBaseUrl }),
	}
}
