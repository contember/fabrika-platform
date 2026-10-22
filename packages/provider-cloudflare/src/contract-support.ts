import {
	type ContractArtifact,
	FABRIKA_TOKEN_KEYS,
	isEmailTransportVariable,
	isPlatformTransportVariable,
	isWorkloadKeyVariable,
} from '@fabrika/auth-core'

// Imported by `./control` (the `./runner` entry), so it stays clear of `oblaka-iac`.

/**
 * Refuse what a contract declares that an application on Cloudflare cannot run yet (ADR-0065): a file kind that scans
 * its uploads, and raw SQL (`ctx.sql`).
 */
export const assertCloudflareContract = (contract: ContractArtifact): void => {
	for (const [name, kind] of Object.entries(contract.fileKinds ?? {})) {
		if (kind.scan === true) {
			throw new Error(`cloudflare: file kind \`${name}\` scans its uploads (\`scan: true\`), and no scanner runs on Cloudflare yet`)
		}
	}
	for (const [name, collection] of Object.entries(contract.files)) {
		if (collection.scan === true) {
			throw new Error(`cloudflare: file collection \`${name}\` scans its uploads (\`scan: true\`), and no scanner runs on Cloudflare yet`)
		}
	}
	for (const [site, reach] of Object.entries(contract.declared ?? {})) {
		if (reach.sql !== null) {
			throw new Error(
				`cloudflare: \`${site}\` declares raw SQL (\`ctx.sql\`), which an application on Cloudflare cannot run: its SQLite has no runtime role to bound it`,
			)
		}
	}
}

/** The object runs due jobs and the file sweep, a framework job, on the Worker's minute tick (ADR-0065 §5). */
export const needsMinuteTick = (contract: ContractArtifact): boolean =>
	Object.keys(contract.jobs).length > 0 || Object.keys(contract.files).length > 0 || Object.keys(contract.fileKinds ?? {}).length > 0

/** The first framework minor whose Cloudflare entry exports the application's Durable Object (ADR-0065). */
const OBJECT_RUNTIME_SINCE = { major: 0, minor: 9 }

/**
 * Whether an application on framework release `release` runs in its Durable Object. An older release's entry is a
 * stateless Worker, which the platform keeps deploying in its old shape (ADR-0062).
 */
export const runsInObject = (release: string): boolean => {
	const match = /^(\d+)\.(\d+)\./.exec(release)
	if (match === null) return false
	const major = Number(match[1])
	return major > OBJECT_RUNTIME_SINCE.major || (major === OBJECT_RUNTIME_SINCE.major && Number(match[2]) >= OBJECT_RUNTIME_SINCE.minor)
}

/**
 * Refuse what a stateless Worker of an older release cannot run: a job, a webhook, a public procedure, installation
 * mail and token purposes all need the object's database or a Worker secret it never reads.
 */
export const assertStatelessEnvironment = (managed: Readonly<Record<string, string | null>>, release: string): void => {
	const names = Object.keys(managed)
	const workloadKey = names.find(isWorkloadKeyVariable)
	if (workloadKey !== undefined) {
		throw new Error(
			`cloudflare: the contract declares a job, a webhook or a public procedure (${workloadKey}), which an application on framework ${release} cannot run on Cloudflare; upgrade its framework`,
		)
	}
	const mailVariable = names.find((name) => isEmailTransportVariable(name) || isPlatformTransportVariable(name))
	if (mailVariable !== undefined) {
		throw new Error(
			`cloudflare: the contract declares a job that sends mail through the installation (${mailVariable}), which an application on framework ${release} cannot run on Cloudflare; upgrade its framework`,
		)
	}
	const tokenKeys = managed[FABRIKA_TOKEN_KEYS]
	if (tokenKeys !== undefined && tokenKeys !== null) {
		throw new Error(
			`cloudflare: the contract declares token purposes, which an application on framework ${release} cannot sign on Cloudflare; upgrade its framework`,
		)
	}
}
