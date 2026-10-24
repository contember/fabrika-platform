// The CLI surface of `fabrika platform init --provider=zerops`, parsed once.
//
// The same two rules `deploy-options.ts` states: every CREDENTIAL comes from the environment and only
// from the environment, and everything else may come from a flag OR the environment, flag first.
// Nothing here prompts — a missing required value is an error naming both the flag and the variable —
// so a pipeline or an agent drives init end to end. Its confirmations stay, answered by `--yes`.

import {
	assertPinnedTag,
	CHECKOUT_FLAG,
	type CommandEnv,
	describeArgument,
	readEnv,
	readFlag,
	requiredSetting,
	setting,
	sidecarCheckoutDir,
	UNATTENDED_FLAG,
} from '@fabrika/installation-init'
import { parsePlatformHosts } from './placement-options'
import { defaultCheckoutName, defaultSidecarRepo } from './sidecar'

/** The name every bypass in this platform is gated on, and therefore the one name an installation cannot take. */
const LOCAL_ENVIRONMENT = 'local'

/** Every input `runInit` takes from the operator. */
export interface InitInput {
	/** Names the GitHub Environment, the default repository and the local checkout directory. */
	readonly installation: string
	readonly repo: string
	/** The sidecar's local checkout: `--checkout`, or `fabrika-zerops-<installation>` in the working directory. */
	readonly checkoutDir: string
	/** The published fabrika-platform tag the sidecar pins in `fabrika.ref`. */
	readonly fabrikaRef: string
	readonly projectId: string
	/** The name this installation calls itself — written to every service as `ENVIRONMENT`. */
	readonly environmentName: string
	/** All three or none: none derives them from the proxy's Zerops subdomains. */
	readonly hosts?: { readonly iam: string; readonly control: string; readonly operations: string }
	/** Region API base, when the installation is not on the default one. */
	readonly apiBaseUrl?: string
	/** The Zerops INTEGRATION token `platform install` minted. Environment only. */
	readonly accessToken: string
	/** The `px_` key this installation's IAM was seeded with. Environment only. */
	readonly provisioningKey: string
	/** `--yes`: answer every confirmation yes. */
	readonly unattended: boolean
}

const FLAGS = ['--repo', CHECKOUT_FLAG, '--tag', '--project-id', '--env', '--iam-host', '--console-host', '--operations-host'] as const

const REPO_PATTERN = /^[^/\s]+\/[^/\s]+$/

/**
 * The installation's environment name, refused when it claims to be local.
 *
 * The same refusal the services enforce at boot: `local` is the value `localDevLogin`, the ephemeral
 * signing key and the credential-less caller path are all gated on, and a deployed installation is
 * never a loopback address.
 */
export const checkedEnvironmentName = (declared: string): string => {
	const trimmed = declared.trim()
	if (trimmed === '') {
		throw new Error('an installation environment name is required — it is written to every service as ENVIRONMENT')
	}
	if (trimmed === LOCAL_ENVIRONMENT) {
		throw new Error(
			`\`${LOCAL_ENVIRONMENT}\` is refused: it is the name every development bypass is gated on, and a deployed `
				+ 'installation is not a loopback address. Name it after the installation instead',
		)
	}
	return trimmed
}

const assertKnownArguments = (argv: readonly string[]): void => {
	for (const arg of argv) {
		if (arg === UNATTENDED_FLAG || !arg.startsWith('-')) {
			continue
		}
		const name = arg.split('=')[0] ?? arg
		if (!FLAGS.some((flag) => flag === name) || !arg.includes('=')) {
			throw new Error(
				`unexpected argument ${describeArgument(arg)}. Credentials are read from the environment and have no flag; run `
					+ '`fabrika platform init --provider=zerops --help` for the surface',
			)
		}
	}
}

const readInstallation = (argv: readonly string[]): string => {
	const positional = argv.filter((arg) => !arg.startsWith('-')).map((arg) => arg.trim())
	if (positional.length > 1) {
		throw new Error('unexpected second positional argument: name ONE installation')
	}
	const installation = positional[0]
	if (installation === undefined || installation === '') {
		throw new Error('Zerops installation init requires an installation name, for example `fabrika platform init --provider=zerops test`')
	}
	return installation
}

const readRepo = (argv: readonly string[], installation: string): string => {
	const repo = readFlag(argv, '--repo')
	if (repo === undefined) {
		return defaultSidecarRepo(installation)
	}
	if (!REPO_PATTERN.test(repo)) {
		throw new Error(`\`${repo}\` is not a <owner>/<name> repository`)
	}
	return repo
}

/** A credential, with the one message that says why there is no flag for it. */
const credential = (env: CommandEnv, variable: string, what: string): string => {
	const value = readEnv(env, variable)
	if (value === undefined) {
		throw new Error(`${variable} is required: ${what}. It has no flag — a credential on a command line lands in logs and shell history`)
	}
	return value
}

/** Parse the command's arguments and environment into the one input `runInit` takes. */
export const parseInitArgs = (argv: readonly string[], env: CommandEnv, cwd: string = process.cwd()): InitInput => {
	assertKnownArguments(argv)
	const installation = readInstallation(argv)
	const hosts = parsePlatformHosts({
		iam: setting(argv, env, '--iam-host', 'FABRIKA_PLATFORM_IAM_HOST'),
		control: setting(argv, env, '--console-host', 'FABRIKA_PLATFORM_CONSOLE_HOST'),
		operations: setting(argv, env, '--operations-host', 'FABRIKA_PLATFORM_OPERATIONS_HOST'),
	})
	const apiBaseUrl = readEnv(env, 'FABRIKA_ZEROPS_API_URL')
	return {
		installation,
		repo: readRepo(argv, installation),
		checkoutDir: sidecarCheckoutDir(readFlag(argv, CHECKOUT_FLAG), defaultCheckoutName(installation), cwd),
		fabrikaRef: assertPinnedTag(requiredSetting(setting(argv, env, '--tag', 'FABRIKA_PLATFORM_TAG'), '--tag', 'FABRIKA_PLATFORM_TAG')),
		projectId: requiredSetting(setting(argv, env, '--project-id', 'FABRIKA_ZEROPS_PROJECT_ID'), '--project-id', 'FABRIKA_ZEROPS_PROJECT_ID'),
		environmentName: checkedEnvironmentName(setting(argv, env, '--env', 'FABRIKA_PLATFORM_ENVIRONMENT') ?? installation),
		accessToken: credential(
			env,
			'FABRIKA_ZEROPS_ACCESS_TOKEN',
			'the Zerops INTEGRATION token `platform install` minted, from its secrets file',
		),
		provisioningKey: credential(env, 'FABRIKA_IAM_PROVISIONING_KEY', 'the px_ key from the secrets file `platform install` wrote'),
		unattended: argv.includes(UNATTENDED_FLAG),
		...(hosts === undefined ? {} : { hosts }),
		...(apiBaseUrl === undefined ? {} : { apiBaseUrl }),
	}
}
