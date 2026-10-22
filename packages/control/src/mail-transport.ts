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
import { builtinEmailProviderSince } from '@fabrika/email/providers'
import { compareReleases, parseRelease, type Release } from './approval/readers'

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
 * application tells "no mail here" from a variable that never reached it. Throws the refusal for an invalid transport,
 * and for a provider the application's framework release (`framework`, absent for a snapshot read before Control
 * recorded one) does not hold: it would build its sender from its own registry and fail to boot.
 */
export function installationMailEnvironment(
	mail: InstallationMail,
	artifact: ContractArtifact | null,
	framework: string | undefined,
): Readonly<Record<string, string>> {
	const jobs = installationMailJobs(artifact)
	if (jobs.length === 0) return {}
	if (mail.kind === 'none') return { [EMAIL_PROVIDER_VARIABLE]: NO_EMAIL_PROVIDER }
	const names = jobs.map((job) => `\`${job}\``).join(', ')
	const subject = `the contract's ${
		jobs.length === 1 ? `job ${names} sends` : `jobs ${names} send`
	} mail through the installation (mailer: 'installation')`
	if (mail.kind === 'invalid') {
		throw new Error(`${subject}, and Control's mail transport is invalid: ${mail.reason}; ${OPERATOR_STEP}, then restart control and deploy again`)
	}
	const provider = mail.transport.variables[EMAIL_PROVIDER_VARIABLE] ?? ''
	const since = providerSince(provider)
	if (since !== undefined && !holdsRelease(framework, since)) {
		const pinned = framework === undefined ? 'the framework release this version was read with' : `framework ${framework}, which this version pins`
		throw new Error(
			`${subject}, and the installation's provider \`${provider}\` is unknown to ${pinned}: it needs ${since.text} or newer. Raise the application's @fabrika/* pin, or choose another provider for the installation`,
		)
	}
	return mail.transport.variables
}

/**
 * The first release that holds a built-in provider; undefined when every release holds it, and for a provider only a
 * local composition registers.
 */
function providerSince(provider: string): Release | undefined {
	const since = Object.entries(builtinEmailProviderSince).find(([name]) => name === provider)?.[1]
	return since === undefined || since === null ? undefined : (parseRelease(since) ?? undefined)
}

/** A snapshot that records no release predates every provider with a `since`. */
function holdsRelease(framework: string | undefined, since: Release): boolean {
	const release = framework === undefined ? null : parseRelease(framework)
	return release !== null && compareReleases(release, since) >= 0
}

/** The secret values a deploy handed, for the run log to redact. */
export function installationMailSecrets(mail: InstallationMail, handed: Readonly<Record<string, string>>): string[] {
	if (mail.kind !== 'transport') return []
	return [...mail.transport.secretNames].map((name) => handed[name] ?? '')
}

/** The first framework release whose `ctx.mail` sends through the platform's relay (`FABRIKA_EMAIL_PROVIDER=platform`). */
const PLATFORM_MAIL_SINCE: Release = { text: '0.7.0', major: 0, minor: 7, patch: 0 }

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
 * Where an application reaches the relay: Control's public origin. An application namespace is a project of its own,
 * with no private network to Control's (ADR-0014). Throws the refusal when Control names no public origin.
 */
export function platformMailOrigin(controlOrigin: string | undefined): string {
	if (controlOrigin === undefined) {
		throw new Error(
			"the contract's jobs send mail through the installation's relay, and Control names no public origin for the application to reach it on (it needs FABRIKA_CONTROL_DOMAIN)",
		)
	}
	return controlOrigin
}

/**
 * The variables of the relay: no provider, the relay's origin and the environment's key. The relay holds what it cannot
 * send, so Control hands them whether or not its own transport is valid. A dry run issues no key.
 */
export function platformMailEnvironment(origin: string, key: string | null): Readonly<Record<string, string>> {
	const variables = platformTransportVariables('mail')
	return {
		[EMAIL_PROVIDER_VARIABLE]: PLATFORM_EMAIL_PROVIDER,
		[variables.url]: origin,
		...(key === null ? {} : { [variables.key]: key }),
	}
}
