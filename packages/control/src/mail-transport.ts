// The installation's default mail transport, which Control hands an application whose job declares `mailer:
// 'installation'`. Control reads it from its own environment and copies it into the deploy: it never writes IAM's copy.

import { type ContractArtifact, JOB_SITE_PREFIX, platformTransportVariables } from '@fabrika/auth-core'
import {
	EMAIL_PROVIDER_VARIABLE,
	EmailDeliveryError,
	type EmailEnvironment,
	type EmailProviderRegistry,
	type EmailTransportConfig,
	NO_EMAIL_PROVIDER,
	readEmailTransportConfig,
} from '@fabrika/email'
import { PLATFORM_EMAIL_PROVIDER } from '@fabrika/email/platform'
import { compareReleases, parseRelease, type Release } from './approval/readers'
import { CONTROL_PRIVATE_ORIGIN } from './platform-transport'

/** The installation's default transport: what Control hands an application whose job declares mailer 'installation'. */
export interface InstallationMailTransport {
	/** `FABRIKA_EMAIL_*` by name. */
	readonly variables: Readonly<Record<string, string>>
	readonly secretNames: ReadonlySet<string>
}

/**
 * What Control's own `FABRIKA_EMAIL_*` say. `none` is a valid state: the application deploys and its jobs see no mail.
 * `invalid` keeps Control running and refuses only the deploys that need the transport.
 */
export type InstallationMail =
	| { readonly kind: 'none' }
	| { readonly kind: 'transport'; readonly transport: InstallationMailTransport }
	/** `reason` names variables, never a value. */
	| { readonly kind: 'invalid'; readonly reason: string }

export const NO_INSTALLATION_MAIL: InstallationMail = Object.freeze({ kind: 'none' })

const SENDER_VARIABLES = [EMAIL_PROVIDER_VARIABLE, 'FABRIKA_EMAIL_FROM', 'FABRIKA_EMAIL_FROM_NAME']

const OPERATOR_STEP =
	"set FABRIKA_EMAIL_* on both iam and control: see `fabrika platform guide --provider=zerops`, 'Set or rotate the mail transport'"

export function readInstallationMail(env: EmailEnvironment, registry: EmailProviderRegistry): InstallationMail {
	let config: EmailTransportConfig
	try {
		config = readEmailTransportConfig(env, registry)
	} catch (error) {
		if (!(error instanceof EmailDeliveryError)) throw error
		return { kind: 'invalid', reason: error.message }
	}
	if (config.kind === 'none') return NO_INSTALLATION_MAIL
	const variables: Record<string, string> = {}
	const secretNames = new Set<string>()
	for (const name of [...SENDER_VARIABLES, ...config.variables.map((variable) => variable.name)]) {
		const value = env[name]
		if (value !== undefined && value !== '') variables[name] = value
	}
	for (const variable of config.variables) {
		if (variable.secret && variables[variable.name] !== undefined) secretNames.add(variable.name)
	}
	return { kind: 'transport', transport: { variables, secretNames } }
}

/** Sorted names of the approved contract's jobs that declare mailer 'installation'. */
export function installationMailJobs(artifact: ContractArtifact | null): string[] {
	return Object.entries(artifact?.declared ?? {})
		.filter(([site, reach]) => site.startsWith(JOB_SITE_PREFIX) && reach.mailer === 'installation')
		.map(([site]) => site.slice(JOB_SITE_PREFIX.length))
		.sort()
}

/**
 * The variables a deploy hands: the transport, or `FABRIKA_EMAIL_PROVIDER=none` for an installation without one, so the
 * application tells "no mail here" from a variable that never reached it. Throws the refusal for an invalid transport.
 */
export function installationMailEnvironment(mail: InstallationMail, artifact: ContractArtifact | null): Readonly<Record<string, string>> {
	const jobs = installationMailJobs(artifact)
	if (jobs.length === 0) return {}
	if (mail.kind === 'none') return { [EMAIL_PROVIDER_VARIABLE]: NO_EMAIL_PROVIDER }
	if (mail.kind === 'transport') return mail.transport.variables
	const names = jobs.map((job) => `\`${job}\``).join(', ')
	const subject = jobs.length === 1 ? `job ${names} sends` : `jobs ${names} send`
	throw new Error(
		`the contract's ${subject} mail through the installation (mailer: 'installation'), and Control's mail transport is invalid: ${mail.reason}; ${OPERATOR_STEP}, then restart control and deploy again`,
	)
}

/** The secret values a deploy handed, for the run log to redact. */
export function installationMailSecrets(mail: InstallationMail, handed: Readonly<Record<string, string>>): string[] {
	if (mail.kind !== 'transport') return []
	return [...mail.transport.secretNames].map((name) => handed[name] ?? '')
}

/** The first framework release whose `ctx.mail` sends through the platform's relay (`FABRIKA_EMAIL_PROVIDER=platform`). */
const PLATFORM_MAIL_SINCE: Release = { text: '0.6.0', major: 0, minor: 6, patch: 0 }

/**
 * Whether a deploy hands the application the relay instead of the installation's credential: a job declares mailer
 * 'installation' and the approved snapshot's framework release reads `FABRIKA_EMAIL_PROVIDER=platform`. A snapshot
 * without a release was read before Control recorded one, so it is an older application.
 */
export function relaysInstallationMail(artifact: ContractArtifact | null, framework: string | undefined): boolean {
	if (installationMailJobs(artifact).length === 0 || framework === undefined) return false
	const release = parseRelease(framework)
	return release !== null && compareReleases(release, PLATFORM_MAIL_SINCE) >= 0
}

/**
 * The variables of the relay: no provider, Control's private origin and the environment's key. The relay holds what it
 * cannot send, so Control hands them whether or not its own transport is valid. A dry run issues no key.
 */
export function platformMailEnvironment(key: string | null): Readonly<Record<string, string>> {
	const variables = platformTransportVariables('mail')
	return {
		[EMAIL_PROVIDER_VARIABLE]: PLATFORM_EMAIL_PROVIDER,
		[variables.url]: CONTROL_PRIVATE_ORIGIN,
		...(key === null ? {} : { [variables.key]: key }),
	}
}
