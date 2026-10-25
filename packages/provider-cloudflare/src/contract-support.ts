import { CLOUDFLARE_MAX_JOB_SEGMENT_MS } from '@fabrika/app/contract'
import {
	type ContractArtifact,
	FABRIKA_TOKEN_KEYS,
	isEmailTransportVariable,
	isPlatformTransportVariable,
	isWorkloadKeyVariable,
	managedValue,
} from '@fabrika/auth-core'
import type { ProviderManagedEnvironment } from '@fabrika/provider-contract'

// Imported by `./control` (the `./runner` entry), so it stays clear of `oblaka-iac`.

/**
 * The longest a procedure's or a webhook's handler may run on Cloudflare. It runs inside the object's transaction, and
 * workerd resets an object whose transaction runs about 30 s (docs/reference/cloudflare-platform.md).
 */
export const CLOUDFLARE_MAX_HANDLER_MS = 25_000

/**
 * Refuse what a contract declares that an application on Cloudflare cannot run yet (ADR-0065): a file kind that scans
 * its uploads, raw SQL (`ctx.sql`), a handler allowed to outlive the object's transaction limit, and, from the release
 * that caps job segments on, a job longer than one segment (`capsSegments`, which each caller decides from the release
 * it runs the contract as).
 */
export const assertCloudflareContract = (contract: ContractArtifact, capsSegments: boolean): void => {
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
	if (capsSegments) {
		for (const [name, job] of Object.entries(contract.jobs)) {
			if (job.timeoutMs > CLOUDFLARE_MAX_JOB_SEGMENT_MS) {
				throw new Error(
					`cloudflare: job \`${name}\` runs up to ${job.timeoutMs} ms, and a job segment on Cloudflare runs at most ${CLOUDFLARE_MAX_JOB_SEGMENT_MS} ms: claim a bounded batch per run and let the next run take the rest; a Workflow for one longer run is planned (backlog 230)`,
				)
			}
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
 * The object runs due jobs and the file sweep of file kinds, a framework job, from the Worker's cron trigger: the minute
 * tick, or from `servesAlarms` its alarm with an hourly repair tick (ADR-0065 §5). Legacy `files` collections do not
 * count: the object schedules no sweep of theirs.
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

/** The first framework minor whose Cloudflare deploy pins the generated entry. */
const PINNED_ENTRY_SINCE = { major: 0, minor: 9 }

/** Whether the Cloudflare deploy of release `release` accepts only the generated entry and regenerates it. */
export const pinsGeneratedEntry = (release: string): boolean => releaseAtLeast(release, PINNED_ENTRY_SINCE)

/** The first framework minor whose application object serves Control's ops row (ADR-0069). */
const SERVES_OPS_SINCE = { major: 0, minor: 9 }

/** Whether an environment on release `release` gets the ops row, the ops key digests and the object variables. */
export const servesOps = (release: string): boolean => releaseAtLeast(release, SERVES_OPS_SINCE)

/** A release as semver orders it: the numeric core, then the prerelease identifiers (none sorts above any). */
interface ReleaseVersion {
	readonly core: readonly number[]
	readonly prerelease: readonly string[]
}

const parseReleaseVersion = (release: string): ReleaseVersion | null => {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(release)
	if (match === null) return null
	return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] === undefined ? [] : match[4].split('.') }
}

/** Semver's order of two prerelease identifiers: numerically when both are numeric, a numeric one first, else by ASCII. */
const compareIdentifiers = (a: string, b: string): number => {
	const numericA = /^\d+$/.test(a)
	const numericB = /^\d+$/.test(b)
	if (numericA && numericB) return Number(a) - Number(b)
	if (numericA !== numericB) return numericA ? -1 : 1
	return a < b ? -1 : a > b ? 1 : 0
}

const compareReleases = (a: ReleaseVersion, b: ReleaseVersion): number => {
	for (const [index, part] of a.core.entries()) {
		const other = b.core[index] ?? 0
		if (part !== other) return part - other
	}
	if (a.prerelease.length === 0 || b.prerelease.length === 0) return b.prerelease.length - a.prerelease.length
	for (const [index, identifier] of a.prerelease.entries()) {
		const other = b.prerelease[index]
		if (other === undefined) return 1
		const order = compareIdentifiers(identifier, other)
		if (order !== 0) return order
	}
	return a.prerelease.length - b.prerelease.length
}

/**
 * Whether framework release `release` is at or above the exact version `since` in semver's precedence, prerelease
 * included; a release that is not a semver version never is (ADR-0062).
 */
export const releaseFrom = (release: string, since: string): boolean => {
	const floor = parseReleaseVersion(since)
	if (floor === null) throw new Error(`releaseFrom: \`${since}\` is not a semver version`)
	const version = parseReleaseVersion(release)
	return version !== null && compareReleases(version, floor) >= 0
}

/**
 * The first framework release whose application object holds the maintenance barrier (`state`, `migrate`) and serves
 * the data operations, runs its jobs from its alarm, and whose deploy caps a job at one segment. The 0.9.0 prereleases
 * published before it (`dev.0`–`dev.4`, `cloudflare.1`–`cloudflare.2`) run in the object without any of that and answer
 * `state` and `migrate` 501, so these gates compare the whole version where `releaseAtLeast` counts a prerelease as
 * its minor. A prerelease of another channel sorts by its name: every `cloudflare.<n>` keeps the older behaviour.
 */
const OBJECT_OPERATIONS_SINCE = '0.9.0-dev.5'

/**
 * Whether the object of release `release` holds the maintenance barrier and serves Control's data operations: the
 * backups, the migration phase and the side restore (ADR-0069 §3, ADR-0070).
 */
export const servesDataOperations = (release: string): boolean => releaseFrom(release, OBJECT_OPERATIONS_SINCE)

/**
 * Whether the Worker of release `release` gets the hourly repair tick instead of the minute tick: an older object runs
 * its jobs only from the minute tick and has no alarm.
 */
export const servesAlarms = (release: string): boolean => releaseFrom(release, OBJECT_OPERATIONS_SINCE)

/**
 * Whether the Cloudflare deploy of release `release` refuses a job whose `timeoutMs` exceeds one segment
 * (`CLOUDFLARE_MAX_JOB_SEGMENT_MS`). An older release deploys as it did (ADR-0062).
 */
export const capsJobSegments = (release: string): boolean => releaseFrom(release, OBJECT_OPERATIONS_SINCE)

/**
 * Refuse what a stateless Worker of an older release cannot run: a job, a webhook, a public procedure, installation
 * mail and token purposes all need the object's database or a Worker secret it never reads.
 */
export const assertStatelessEnvironment = (managed: ProviderManagedEnvironment, release: string): void => {
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
	if (managedValue(managed, FABRIKA_TOKEN_KEYS) !== null) {
		throw new Error(
			`cloudflare: the contract declares token purposes, which an application on framework ${release} cannot sign on Cloudflare; upgrade its framework`,
		)
	}
}
