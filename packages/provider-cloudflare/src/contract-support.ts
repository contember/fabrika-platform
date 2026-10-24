import {
	type ContractArtifact,
	FABRIKA_TOKEN_KEYS,
	isEmailTransportVariable,
	isPlatformTransportVariable,
	isWorkloadKeyVariable,
} from '@fabrika/auth-core'

// Imported by `./control` (the `./runner` entry), so it stays clear of `oblaka-iac`.

/**
 * The longest a procedure's or a webhook's handler may run on Cloudflare. It runs inside the object's transaction, and
 * workerd resets an object whose transaction runs about 30 s (docs/reference/cloudflare-platform.md).
 */
export const CLOUDFLARE_MAX_HANDLER_MS = 25_000

/**
 * Refuse what a contract declares that an application on Cloudflare cannot run yet (ADR-0065): a file kind that scans
 * its uploads, raw SQL (`ctx.sql`), and a handler allowed to outlive the object's transaction limit.
 */
export const assertCloudflareContract = (contract: ContractArtifact): void => {
	const handlers: [string, number][] = [
		...Object.entries(contract.procedures ?? {}).map(([id, procedure]): [string, number] => [`procedure \`${id}\``, procedure.timeoutMs]),
		...Object.entries(contract.mounts).flatMap(([name, mount]): [string, number][] =>
			mount.kind === 'webhook' ? [[`webhook \`${name}\``, mount.timeoutMs]] : []
		),
	]
	for (const [subject, timeoutMs] of handlers) {
		if (timeoutMs > CLOUDFLARE_MAX_HANDLER_MS) {
			throw new Error(
				`cloudflare: ${subject} runs up to ${timeoutMs} ms, and a handler on Cloudflare runs at most ${CLOUDFLARE_MAX_HANDLER_MS} ms: it holds its Durable Object's transaction`,
			)
		}
	}
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

/**
 * The object runs due jobs and the file sweep of file kinds, a framework job, on the Worker's minute tick (ADR-0065 §5).
 * Legacy `files` collections do not count: the object schedules no sweep of theirs.
 */
export const needsMinuteTick = (contract: ContractArtifact): boolean =>
	Object.keys(contract.jobs).length > 0 || Object.keys(contract.fileKinds ?? {}).length > 0

/**
 * Whether framework release `release` is at least `since`. A prerelease counts as its `major.minor`; a release that
 * does not start with `<major>.<minor>.` is never at least anything (ADR-0062).
 */
export const releaseAtLeast = (release: string, since: { readonly major: number; readonly minor: number }): boolean => {
	const match = /^(\d+)\.(\d+)\./.exec(release)
	if (match === null) return false
	const major = Number(match[1])
	return major > since.major || (major === since.major && Number(match[2]) >= since.minor)
}

/** The first framework minor whose Cloudflare entry exports the application's Durable Object (ADR-0065). */
const OBJECT_RUNTIME_SINCE = { major: 0, minor: 9 }

/**
 * Whether an application on framework release `release` runs in its Durable Object. An older release's entry is a
 * stateless Worker, which the platform keeps deploying in its old shape (ADR-0062).
 */
export const runsInObject = (release: string): boolean => releaseAtLeast(release, OBJECT_RUNTIME_SINCE)

/** The first framework minor whose Cloudflare deploy pins the generated entry; which release gets it is still open. */
const PINNED_ENTRY_SINCE = { major: 0, minor: 9 }

/** Whether the Cloudflare deploy of release `release` accepts only the generated entry and regenerates it. */
export const pinsGeneratedEntry = (release: string): boolean => releaseAtLeast(release, PINNED_ENTRY_SINCE)

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
