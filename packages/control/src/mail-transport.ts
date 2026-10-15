// The installation's default mail transport, which Control hands an application whose job declares `mailer:
// 'installation'`. Control reads it from its own environment and copies it into the deploy: it never writes IAM's copy.

import { type ContractArtifact, JOB_SITE_PREFIX } from '@fabrika/auth-core'
import { type EmailEnvironment, type EmailProviderRegistry, readEmailTransportConfig } from '@fabrika/email'

/** The installation's default transport: what Control hands an application whose job declares mailer 'installation'. */
export interface InstallationMailTransport {
	/** `FABRIKA_EMAIL_*` by name. */
	readonly variables: Readonly<Record<string, string>>
	readonly secretNames: ReadonlySet<string>
}

const SENDER_VARIABLES = ['FABRIKA_EMAIL_PROVIDER', 'FABRIKA_EMAIL_FROM', 'FABRIKA_EMAIL_FROM_NAME'] as const

/** null when the installation configured none; throws naming variables, never a value, when the configuration is invalid. */
export function readInstallationMailTransport(env: EmailEnvironment, registry: EmailProviderRegistry): InstallationMailTransport | null {
	const config = readEmailTransportConfig(env, registry)
	if (config.kind === 'none') return null
	const variables: Record<string, string> = {}
	const secretNames = new Set<string>()
	for (const name of [...SENDER_VARIABLES, ...config.variables.map((variable) => variable.name)]) {
		const value = env[name]
		if (value !== undefined && value !== '') variables[name] = value
	}
	for (const variable of config.variables) {
		if (variable.secret && variables[variable.name] !== undefined) secretNames.add(variable.name)
	}
	return { variables, secretNames }
}

/** Sorted names of the approved contract's jobs that declare mailer 'installation'. */
export function installationMailJobs(artifact: ContractArtifact | null): string[] {
	return Object.entries(artifact?.declared ?? {})
		.filter(([site, reach]) => site.startsWith(JOB_SITE_PREFIX) && reach.mailer === 'installation')
		.map(([site]) => site.slice(JOB_SITE_PREFIX.length))
		.sort()
}

/** The variables a deploy hands; throws the refusal when a job needs them and the installation has none. */
export function installationMailEnvironment(
	transport: InstallationMailTransport | undefined,
	artifact: ContractArtifact | null,
): Readonly<Record<string, string>> {
	const jobs = installationMailJobs(artifact)
	if (jobs.length === 0) return {}
	if (transport === undefined) {
		const names = jobs.map((job) => `\`${job}\``).join(', ')
		const subject = jobs.length === 1 ? `job ${names} sends` : `jobs ${names} send`
		const object = jobs.length === 1 ? 'it' : 'them'
		throw new Error(
			`the contract's ${subject} mail through the installation (mailer: 'installation'), and this installation cannot hand ${object} a mail transport (Control needs FABRIKA_EMAIL_PROVIDER, FABRIKA_EMAIL_FROM and the provider's variables)`,
		)
	}
	return transport.variables
}
