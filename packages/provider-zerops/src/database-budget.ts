// The connection budget of a contract application's PostgreSQL on Zerops (ADR-0043): how many connections each of the
// application's processes may open, and the RAM its database needs for that to be at least the minimum. PURE.

/**
 * The RAM steps of a Zerops PostgreSQL service in GB; its `max_connections` follows the step its RAM is in, and a
 * service between two steps has the lower one's (`docs/reference/zerops-platform.md`, "Connection limits"). Above 8 GB
 * the steps are multiples of 8 GB; 16 GB is the first with the highest limit.
 */
export const ZEROPS_POSTGRES_RAM_STEPS_GB: readonly number[] = [0.25, 0.5, 1, 2, 4, 8, 16]

/** The lowest step, and the smallest RAM a PostgreSQL service is given (`oltp-hobby`'s floor). */
export const ZEROPS_POSTGRES_MIN_RAM_GB = 0.25

/** Of a service's `max_connections`, what no application role can take: 3 kept for superusers, up to 4 Zerops' own. */
export const ZEROPS_POSTGRES_UNAVAILABLE_CONNECTIONS = 7

/**
 * The most connections one container's start script holds at once: `fabrika db test-isolation` peaks at 4 since the
 * test kit opens a file's connections together, and at 5 with a `@fabrika/db` before that (measured locally,
 * 2026-10-16, with the Notes and CRM examples). Migrating and reading the schema take fewer, one after the other.
 */
export const ZEROPS_START_CONNECTIONS = 5

/** The fewest connections a process may have: a job's fenced write and its cancellation each need one at once. */
export const MIN_PROCESS_CONNECTIONS = 2
/** The most a process gets, however large the database: the pool every process had before the platform sized it. */
export const MAX_PROCESS_CONNECTIONS = 10

/** Zerops' own maximum, which a runtime whose horizontal autoscaling reads nothing may scale to. */
export const ZEROPS_MAX_CONTAINERS = 10

/** What opens connections to the application's database at once. */
export interface ZeropsDatabaseDemand {
	/** The deploy service's maximum container count. */
	readonly maxContainers: number
	/** The crontab lines that run `fabrika job run`, each its own process on one container. */
	readonly jobs: number
}

/** `max_connections` of a Zerops PostgreSQL service with `ramGB` of RAM and this autoscaling profile. */
export function zeropsPostgresMaxConnections(ramGB: number, profile: string | undefined): number {
	const step = ramGB < 8
		? Math.max(...ZEROPS_POSTGRES_RAM_STEPS_GB.filter((candidate) => candidate <= ramGB), ZEROPS_POSTGRES_MIN_RAM_GB)
		: Math.floor(ramGB / 8) * 8
	const [perGB, lowest, highest] = profile?.startsWith('olap-') === true ? [25, 10, 200] : [50, 20, 500]
	return Math.min(highest, Math.max(lowest, Math.floor(perGB * step)))
}

/**
 * The processes that may each hold a full pool at once: while a deploy replaces the containers, every old one still
 * serves beside its replacement, and each crontab job runs in a process of its own.
 */
const poolHolders = (demand: ZeropsDatabaseDemand): number => 2 * demand.maxContainers + demand.jobs

/**
 * The connections each process may open so that all of them, with one container's start script, stay within what the
 * application's roles can take; `null` when that is below `MIN_PROCESS_CONNECTIONS`.
 */
export function zeropsProcessConnections(maxConnections: number, demand: ZeropsDatabaseDemand): number | null {
	const available = maxConnections - ZEROPS_POSTGRES_UNAVAILABLE_CONNECTIONS - ZEROPS_START_CONNECTIONS
	const share = Math.floor(available / poolHolders(demand))
	return share < MIN_PROCESS_CONNECTIONS ? null : Math.min(share, MAX_PROCESS_CONNECTIONS)
}

/** The smallest RAM step at which each process gets at least `MIN_PROCESS_CONNECTIONS`, or null when none does. */
export function zeropsDatabaseMinRam(demand: ZeropsDatabaseDemand, profile: string | undefined): number | null {
	return ZEROPS_POSTGRES_RAM_STEPS_GB.find((ram) => zeropsProcessConnections(zeropsPostgresMaxConnections(ram, profile), demand) !== null) ?? null
}
