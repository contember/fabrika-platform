// The platform-facts table, run against a REAL Zerops account.
//
// Opt-in, the same convention the Postgres- and S3-backed suites use: configure it and it runs, leave it
// unconfigured and it skips with a message saying exactly what to set and what the run will do.
//
//   FABRIKA_LIVE_ZEROPS_TOKEN=<access token> FABRIKA_LIVE_ZEROPS_PROJECT_ID=<throwaway project> \
//     bun test packages/provider-zerops/src/__tests__/platform-facts.live.test.ts
//   FABRIKA_LIVE_ZEROPS_SLOW=1 …    also runs the build-length rows (minutes each)
//
// WHAT IT DOES TO THE PROJECT. It imports four throwaway services named `wu1<run id>*`, writes and removes
// a handful of `FABRIKA_FACT_*` variables on one of them, and deletes every service it created again — including
// when a row failed. The build-length PostgreSQL rows add a `postgresql:single@18` and a small SQL client
// published on its subdomain, which answers the database's `max_connections` and nothing else, and a second
// `postgresql:single@18` whose backup schedule they set to hourly. It never creates or deletes a project, never touches a service it did not create, and never
// adopts one left behind by an earlier run: a leaked name is REPORTED at startup and left alone, because
// adopting it would let an interrupted run silently change a later one's result.
//
// The token is read here and put in one header. It is never logged, never asserted on, and never included
// in a failure message.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { createZeropsApi } from '../api'
import { zeropsPostgresMaxConnections } from '../database-budget'
import { ensureBackupPeriod, PLATFORM_DATABASE_BACKUP_PERIOD } from '../installation/deploy'
import { raiseMinRam } from '../provider'
import {
	assertLiveRowIsSafe,
	awaitProcessTerminal,
	callApi,
	type FactContext,
	type FactScript,
	factsFor,
	type FactTransport,
	type PlatformFact,
	PlatformFactError,
	resolvePath,
	runFact,
} from './platform-facts'
import { ECHO_FILES, probeArchive, probeDescriptor, type ProbeFailure, SQL_PROBE_FILES } from './platform-facts-archive'

const PREFIX = 'FABRIKA_LIVE_ZEROPS_'
const TOKEN_VAR = `${PREFIX}TOKEN`
const PROJECT_VAR = `${PREFIX}PROJECT_ID`
const SLOW_VAR = `${PREFIX}SLOW`
const REQUIRED_NAMES = [TOKEN_VAR, PROJECT_VAR]

/** Base URL of the Zerops public REST API. Copied rather than imported so the suite pins what it dialled. */
const API_BASE = 'https://api.app-prg1.zerops.io/api/rest/public'

/** Hostnames are `^[a-z0-9]{1,25}$`, so a run id has to be lowercase alphanumeric. */
const RUN_PREFIX = 'wu1'

/** A Zerops id is an opaque URL-safe token. Nothing outside this shape may reach a request path. */
const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]+$/

interface LiveAccount {
	token: string
	projectId: string
	slow: boolean
}

/** No configuration skips; a PARTIAL configuration throws rather than producing a false green. */
export function readLiveAccount(environment: Record<string, string | undefined>): LiveAccount | null {
	const configured = REQUIRED_NAMES.filter((name) => present(environment[name]))
	if (configured.length === 0) {
		return null
	}
	const missing = REQUIRED_NAMES.filter((name) => !present(environment[name]))
	if (missing.length > 0) {
		throw new Error(`Incomplete live Zerops test configuration; missing ${missing.join(', ')}`)
	}
	const projectId = environment[PROJECT_VAR] ?? ''
	// It goes into every request path unescaped; anything with a slash or a query term would address
	// something other than the project the operator named.
	if (!PROJECT_ID_PATTERN.test(projectId)) {
		throw new Error(`${PROJECT_VAR} must match ${PROJECT_ID_PATTERN.source}`)
	}
	return {
		token: environment[TOKEN_VAR] ?? '',
		projectId,
		slow: environment[SLOW_VAR] === '1',
	}
}

function present(value: string | undefined): boolean {
	return value !== undefined && value !== ''
}

const account = readLiveAccount(process.env)
const hasLiveAccount = account !== null

export const skipReason = `skipped: set ${TOKEN_VAR} and ${PROJECT_VAR} (plus ${SLOW_VAR}=1 for the build-length rows) to run `
	+ `the platform-facts table against a real Zerops account — it imports four throwaway ${RUN_PREFIX}* services into that `
	+ `project (seven with ${SLOW_VAR}=1, two PostgreSQL among them), writes and deletes their variables, and deletes every service it created again`

if (!hasLiveAccount) {
	console.warn(`platform-facts.live.test.ts ${skipReason}`)
}

/** Ten lowercase alphanumeric characters, so `wu1<run id>` is 13 of the 25 a hostname may have. */
const newRunId = (): string =>
	Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => byte.toString(36).padStart(2, '0')).join('').slice(0, 10)

/** ~20 minutes at a 5 s interval: a first build takes minutes, and an unpack failure lands in under one. */
const VERSION_POLL_INTERVAL_MS = 5_000
const VERSION_POLL_ATTEMPTS = 240
const VERSION_TERMINAL = new Set([
	'ACTIVE',
	'BACKUP',
	'BUILD_FAILED',
	'BUILD_VALIDATION_FAILED',
	'DEPLOY_FAILED',
	'PREPARING_RUNTIME_FAILED',
	'CANCELLED',
])

const ROW_TIMEOUT_MS = 300_000
const BUILD_ROW_TIMEOUT_MS = 1_500_000
/** Cleanup gets a budget and a signal of ITS OWN, so a run that overran still deletes what it created. */
const CLEANUP_TIMEOUT_MS = 120_000

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

/**
 * Reserve an upload-backed version, upload the archive, ask for the build, and report the status it settles
 * on. The presigned PUT carries NO bearer — the URL is the credential, and it is never logged.
 */
const unpackerProbe =
	(options: { directoryEntries: boolean; expected: string; failure?: ProbeFailure }): FactScript => async ({ transport, context, fact }) => {
		const hostname = required(context, 'hostname')
		const settled = await deployProbe(transport, fact, {
			service: { id: required(context, 'serviceId'), hostname },
			name: `${hostname}-${options.directoryEntries ? 'dirs' : 'flat'}`,
			archive: probeArchive({ directoryEntries: options.directoryEntries }),
			descriptor: probeDescriptor(hostname, options.failure),
		})
		if (settled !== options.expected) {
			throw new PlatformFactError(fact.id, fact.section, `the app version settled on ${settled}, expected ${options.expected}`)
		}
	}

/** Reserve an upload-backed version on a throwaway service, upload `archive`, build it, and answer the status it settles on. */
const deployProbe = async (
	transport: FactTransport,
	fact: PlatformFact,
	probe: { service: { id: string; hostname: string }; name: string; archive: ArrayBuffer; descriptor: string },
): Promise<string> => {
	const serviceId = probe.service.id
	const hostname = probe.service.hostname
	const reserved = await callApi(transport, 'POST', `/service-stack/${serviceId}/app-version`, { name: probe.name })
	if (reserved.status < 200 || reserved.status >= 300) {
		throw new PlatformFactError(fact.id, fact.section, `reserving an app version answered ${reserved.status}`)
	}
	const appVersionId = text(first(reserved.body, 'id'))
	const uploadUrl = text(first(reserved.body, 'uploadUrl'))
	if (appVersionId === undefined || uploadUrl === undefined) {
		throw new PlatformFactError(fact.id, fact.section, 'the app-version reservation carried no id or no upload URL')
	}
	const uploaded = await transport.fetch(uploadUrl, { method: 'PUT', body: probe.archive, signal: transport.signal })
	if (!uploaded.ok) {
		// Never the URL and never the body: both can carry the presigned credential.
		throw new PlatformFactError(fact.id, fact.section, `uploading the probe archive answered ${uploaded.status}`)
	}
	const started = await callApi(transport, 'PUT', `/app-version/${appVersionId}/build-and-deploy`, {
		zeropsYaml: probe.descriptor,
		zeropsYamlSetup: hostname,
	})
	if (started.status < 200 || started.status >= 300) {
		throw new PlatformFactError(fact.id, fact.section, `build-and-deploy answered ${started.status}`)
	}
	return await pollAppVersion(transport, appVersionId)
}

/** ~2 minutes for a fresh subdomain to answer: measured at ~3 s, so this only absorbs a slow balancer. */
const SUBDOMAIN_POLL_ATTEMPTS = 24

/**
 * Deploy an echo server, publish it on its subdomain (only if it is not published yet: a second enable fails its
 * process), and send one request with an `Authorization` header from outside the project. The fact holds when the
 * echo is that header, byte for byte. The value is a random marker, never a credential.
 */
const authorizationForwarded: FactScript = async ({ transport, context, fact }) => {
	const serviceId = required(context, 'serviceId')
	const hostname = required(context, 'hostname')
	const settled = await deployProbe(transport, fact, {
		service: { id: serviceId, hostname },
		name: `${hostname}-echo`,
		archive: probeArchive({ directoryEntries: true, files: ECHO_FILES }),
		descriptor: probeDescriptor(hostname),
	})
	if (settled !== 'ACTIVE') {
		throw new PlatformFactError(fact.id, fact.section, `the echo server settled on ${settled}, expected ACTIVE`)
	}
	const subdomain = await publishSubdomain(transport, fact, serviceId)
	const sent = `Bearer fabrika-fact-${crypto.randomUUID()}`
	for (let attempt = 0; attempt < SUBDOMAIN_POLL_ATTEMPTS; attempt++) {
		const answered = await transport.fetch(subdomain, { headers: { Authorization: sent }, signal: transport.signal }).catch(() => null)
		if (answered?.status === 200) {
			const echoed = await answered.text()
			if (echoed !== sent) {
				throw new PlatformFactError(fact.id, fact.section, `the balancer changed Authorization: the echo is ${JSON.stringify(echoed)}`)
			}
			return
		}
		await transport.sleep(VERSION_POLL_INTERVAL_MS)
	}
	throw new PlatformFactError(fact.id, fact.section, 'the subdomain never answered 200')
}

/** Publish a deployed service on its subdomain (only if it is not published yet: a second enable fails its process) and answer the URL of its port 3000. */
const publishSubdomain = async (transport: FactTransport, fact: PlatformFact, serviceId: string): Promise<string> => {
	const service = await callApi(transport, 'GET', `/service-stack/${serviceId}`)
	if (first(service.body, 'subdomainAccess') !== true) {
		const enabled = await callApi(transport, 'PUT', `/service-stack/${serviceId}/enable-subdomain-access`)
		if (enabled.status !== 200) {
			throw new PlatformFactError(fact.id, fact.section, `enabling the subdomain answered ${enabled.status}`)
		}
		const processId = text(first(enabled.body, 'id'))
		if (processId !== undefined) {
			await awaitProcessTerminal(transport, processId)
		}
	}
	const env = await callApi(transport, 'GET', `/service-stack/${serviceId}/env`)
	const names = text(first(env.body, 'items[key=zeropsSubdomain].content'))?.split('\n') ?? []
	const subdomain = names.find((name) => name.includes('-3000.')) ?? names[0]
	if (subdomain === undefined) {
		throw new PlatformFactError(fact.id, fact.section, 'the deployed service has no zeropsSubdomain')
	}
	return subdomain
}

const pollAppVersion = async (transport: FactTransport, appVersionId: string): Promise<string> => {
	for (let attempt = 0;; attempt += 1) {
		const outcome = await callApi(transport, 'GET', `/app-version/${appVersionId}`)
		const status = text(first(outcome.body, 'status'))
		if (status !== undefined && VERSION_TERMINAL.has(status)) {
			return status
		}
		if (attempt >= VERSION_POLL_ATTEMPTS) {
			throw new Error(`platform-facts.live: app version ${appVersionId} did not reach a terminal status in time`)
		}
		await transport.sleep(VERSION_POLL_INTERVAL_MS)
	}
}

const first = (value: unknown, path: string): unknown => {
	const found = resolvePath(value, path)
	return found.length === 0 ? undefined : found[0]
}

const required = (context: FactContext, name: string): string => {
	const value = context.get(name)
	if (value === undefined) {
		throw new Error(`platform-facts.live: the table never captured {${name}}`)
	}
	return value
}

/** What the PostgreSQL probe raises its database to: the raise `size-database` makes for the Notes example, 0.25 → 1 GB. */
const POSTGRES_PROBE_MIN_RAM_GB = 1
/**
 * The profile an application's own database is declared with, and its minimum RAM, which `size-database` also assumes
 * when none is reported. Without a profile a `postgresql:single@18` gets `oltp-staging`, whose floor is 1 GB.
 */
const POSTGRES_PROBE_PROFILE = 'oltp-hobby'
const POSTGRES_FRESH_MIN_RAM_GB = 0.25
const POSTGRES_SAMPLE_INTERVAL_MS = 1_000
/** Each sample is one fresh connection; the client gives up connecting after 3 s, the request after this. */
const POSTGRES_SAMPLE_TIMEOUT_MS = 10_000
/** How long `max_connections` may take to follow the raise before the row fails; measured 2026-10-16 at ~15 s. */
const POSTGRES_FOLLOW_TIMEOUT_MS = 180_000
/** The longest the database may refuse fresh connections while it restarts; measured 2026-10-16 at under one sample. */
const POSTGRES_OUTAGE_BOUND_MS = 10_000
/** After the new limit first answers, the samples must stay good this long for the row to read the outcome. */
const POSTGRES_SETTLE_MS = 60_000
/** ~5 minutes for the SQL client's first good answer after its deploy: a fresh subdomain and database warm up. */
const POSTGRES_FIRST_ANSWER_ATTEMPTS = 60

const postgresProbeImport = (database: string, client: string): string =>
	[
		'services:',
		`  - hostname: ${database}`,
		'    type: postgresql:single@18',
		`    profile: ${POSTGRES_PROBE_PROFILE}`,
		`  - hostname: ${client}`,
		'    type: alpine/bun@1.3',
		'    envIsolation: service',
		'',
	].join('\n')

/** The SQL client's answer. Parsed here, where it enters the suite. */
const sqlProbeAnswerSchema = z.discriminatedUnion('ok', [
	z.object({ ok: z.literal(true), maxConnections: z.number(), startedAt: z.string() }),
	z.object({ ok: z.literal(false), error: z.string() }),
])

type PostgresSample = { atMs: number; tookMs: number } & ({ ok: true; maxConnections: number; startedAt: string } | { ok: false; error: string })

/** What the raise row leaves the follow row: the database it raised, what it read before, and the samples since. */
interface PostgresRaise {
	profile: string | undefined
	before: { minRamGB: number; maxConnections: number; startedAt: string }
	raiseStartedAtMs: number
	raiseFinishedAtMs: number
	samples: PostgresSample[]
	stopSampling: () => Promise<void>
}

const sampleSqlClient = async (transport: FactTransport, url: string): Promise<PostgresSample> => {
	const atMs = Date.now()
	const signal = AbortSignal.any([transport.signal, AbortSignal.timeout(POSTGRES_SAMPLE_TIMEOUT_MS)])
	const answered = await transport.fetch(url, { signal }).catch(() => null)
	const body = answered?.status === 200 ? await answered.json().catch(() => null) : null
	const tookMs = Date.now() - atMs
	if (answered === null) return { atMs, tookMs, ok: false, error: 'no answer' }
	if (answered.status !== 200) return { atMs, tookMs, ok: false, error: `http ${answered.status}` }
	const parsed = sqlProbeAnswerSchema.safeParse(body)
	return parsed.success ? { atMs, tookMs, ...parsed.data } : { atMs, tookMs, ok: false, error: 'unreadable answer' }
}

/** Sample the SQL client every second until stopped; the samples land in `samples` as they come. */
const startSampling = (transport: FactTransport, url: string, samples: PostgresSample[]): () => Promise<void> => {
	let stopped = false
	const loop = (async () => {
		while (!stopped && !transport.signal.aborted) {
			const sample = await sampleSqlClient(transport, url)
			samples.push(sample)
			await transport.sleep(Math.max(0, sample.atMs + POSTGRES_SAMPLE_INTERVAL_MS - Date.now()))
		}
	})()
	return async () => {
		stopped = true
		await loop
	}
}

/** The longest run of failed samples, from the first failure to the next good sample, in ms. */
const longestOutageMs = (samples: readonly PostgresSample[]): number => {
	let longest = 0
	let failedSinceMs: number | null = null
	for (const sample of samples) {
		if (!sample.ok) {
			failedSinceMs ??= sample.atMs
			continue
		}
		if (failedSinceMs !== null) longest = Math.max(longest, sample.atMs - failedSinceMs)
		failedSinceMs = null
	}
	return longest
}

/**
 * The two PostgreSQL rows. The first imports a `postgresql:single@18` and an SQL client beside it, deploys the client,
 * reads `max_connections` as the superuser, starts sampling it every second, and raises the database's minimum RAM
 * through the deploy step's own `raiseMinRam`. The second waits until the samples show the new limit and reads the
 * outage and the restart off them. `stop` ends the sampling when the first row failed after starting it.
 */
const postgresProbe = (): { scripts: Record<string, FactScript>; stop: () => Promise<void> } => {
	let raise: PostgresRaise | null = null

	const raiseMinRamRow: FactScript = async ({ transport, context, fact }) => {
		const projectId = required(context, 'projectId')
		const database = required(context, 'postgresHostname')
		const client = required(context, 'sqlClientHostname')
		const imported = await callApi(transport, 'POST', `/project/${projectId}/service-stack/import`, { yaml: postgresProbeImport(database, client) })
		if (imported.status !== 200) {
			throw new PlatformFactError(fact.id, fact.section, `importing the database and its SQL client answered ${imported.status}`)
		}
		for (const processId of resolvePath(imported.body, 'serviceStacks[*].processes[*].id')) {
			if (typeof processId === 'string') await awaitProcessTerminal(transport, processId)
		}
		const databaseId = await findServiceId(transport, projectId, database)
		const clientId = await findServiceId(transport, projectId, client)
		if (databaseId === null || clientId === null) {
			throw new PlatformFactError(fact.id, fact.section, 'the import did not leave the database and its SQL client')
		}
		context.set('postgresServiceId', databaseId)
		const databaseUrl =
			`postgresql://\${${database}_superUser}:\${${database}_superUserPassword}@\${${database}_hostname}:\${${database}_port}/\${${database}_dbName}?sslmode=disable`
		const settled = await deployProbe(transport, fact, {
			service: { id: clientId, hostname: client },
			name: `${client}-sql`,
			archive: probeArchive({ directoryEntries: true, files: SQL_PROBE_FILES }),
			descriptor: probeDescriptor(client, undefined, { PROBE_DATABASE_URL: databaseUrl }),
		})
		if (settled !== 'ACTIVE') {
			throw new PlatformFactError(fact.id, fact.section, `the SQL client settled on ${settled}, expected ACTIVE`)
		}
		const url = await publishSubdomain(transport, fact, clientId)
		let baseline: PostgresSample | null = null
		for (let attempt = 0; attempt < POSTGRES_FIRST_ANSWER_ATTEMPTS && baseline === null; attempt++) {
			const sample = await sampleSqlClient(transport, url)
			if (sample.ok) baseline = sample
			else await transport.sleep(VERSION_POLL_INTERVAL_MS)
		}
		if (baseline === null || !baseline.ok) {
			throw new PlatformFactError(fact.id, fact.section, 'the SQL client never read max_connections')
		}

		const api = createZeropsApi({ token: transport.token })
		const service = await api.getService({ serviceId: databaseId, signal: transport.signal })
		const minRamGB = service.currentAutoscaling?.vertical.minResource.memoryGBytes ?? null
		const profile = service.autoscalingProfileId
		console.info(
			`platform-facts.live: ${database} (profile ${profile ?? 'none'}) at a minimum of ${
				minRamGB ?? 'no'
			} GB: max_connections ${baseline.maxConnections}`,
		)
		if (profile !== POSTGRES_PROBE_PROFILE) {
			throw new PlatformFactError(fact.id, fact.section, `the database reads the profile ${profile ?? 'nothing'}, expected ${POSTGRES_PROBE_PROFILE}`)
		}
		if (minRamGB !== POSTGRES_FRESH_MIN_RAM_GB) {
			throw new PlatformFactError(
				fact.id,
				fact.section,
				`a fresh database reads a minimum RAM of ${minRamGB ?? 'nothing'} GB, expected ${POSTGRES_FRESH_MIN_RAM_GB}`,
			)
		}
		if (baseline.maxConnections !== zeropsPostgresMaxConnections(minRamGB, profile)) {
			throw new PlatformFactError(
				fact.id,
				fact.section,
				`max_connections is ${baseline.maxConnections} at ${minRamGB} GB, expected ${zeropsPostgresMaxConnections(minRamGB, profile)}`,
			)
		}

		const samples: PostgresSample[] = []
		const stopSampling = startSampling(transport, url, samples)
		const raiseStartedAtMs = Date.now()
		raise = {
			profile,
			before: { minRamGB, maxConnections: baseline.maxConnections, startedAt: baseline.startedAt },
			raiseStartedAtMs,
			raiseFinishedAtMs: raiseStartedAtMs,
			samples,
			stopSampling,
		}
		const sleep = (ms: number): Promise<void> => transport.sleep(ms)
		const after = await raiseMinRam(
			{ zerops: { api, sleep }, signal: transport.signal },
			service,
			database,
			POSTGRES_PROBE_MIN_RAM_GB,
			'the probe needs',
		)
		raise.raiseFinishedAtMs = Date.now()
		console.info(
			`platform-facts.live: ${database} reads back a minimum of ${after} GB, ${raise.raiseFinishedAtMs - raiseStartedAtMs} ms after the raise began`,
		)
	}

	const followRow: FactScript = async ({ transport, fact }) => {
		const raised = raise
		if (raised === null) {
			throw new PlatformFactError(fact.id, fact.section, 'the raise row did not reach its raise, so there is nothing to follow')
		}
		const expected = zeropsPostgresMaxConnections(POSTGRES_PROBE_MIN_RAM_GB, raised.profile)
		const deadlineMs = raised.raiseStartedAtMs + POSTGRES_FOLLOW_TIMEOUT_MS
		const followedAt = (): PostgresSample | undefined => raised.samples.find((sample) => sample.ok && sample.maxConnections === expected)
		const settled = (): boolean => {
			const followed = followedAt()
			const last = raised.samples.at(-1)
			return followed !== undefined && last?.ok === true && last.atMs - followed.atMs >= POSTGRES_SETTLE_MS
		}
		while (!settled() && Date.now() < deadlineMs) {
			await transport.sleep(POSTGRES_SAMPLE_INTERVAL_MS)
		}
		await raised.stopSampling()
		const followed = followedAt()
		const failed = raised.samples.filter((sample) => !sample.ok)
		const restartedAt = raised.samples.find((sample) => sample.ok && sample.startedAt !== raised.before.startedAt)
		const lastBeforeRestart = [...raised.samples].reverse().find((sample) => sample.ok && sample.startedAt === raised.before.startedAt)
		const outageMs = longestOutageMs(raised.samples)
		const slowestMs = Math.max(0, ...raised.samples.map((sample) => sample.tookMs))
		const errors = [...new Set(failed.map((sample) => (sample.ok ? '' : sample.error)))]
		console.info(
			[
				`platform-facts.live: ${raised.samples.length} samples over ${
					Math.round(((raised.samples.at(-1)?.atMs ?? raised.raiseStartedAtMs) - raised.raiseStartedAtMs) / 1000)
				} s;`,
				`the raise call took ${raised.raiseFinishedAtMs - raised.raiseStartedAtMs} ms;`,
				followed === undefined
					? `max_connections never read ${expected};`
					: `max_connections read ${expected} ${followed.atMs - raised.raiseStartedAtMs} ms after the raise began;`,
				`${failed.length} failed sample(s), the longest outage ${outageMs} ms, the slowest sample ${slowestMs} ms${
					errors.length === 0 ? '' : ` (${errors.join(', ')})`
				};`,
				restartedAt === undefined
					? 'the postmaster did not restart'
					: `the postmaster restarted, first seen ${restartedAt.atMs - raised.raiseStartedAtMs} ms after the raise began, ${
						restartedAt.atMs - (lastBeforeRestart?.atMs ?? raised.raiseStartedAtMs)
					} ms after the last sample of the old one`,
			].join(' '),
		)
		if (followed === undefined) {
			throw new PlatformFactError(
				fact.id,
				fact.section,
				`max_connections never read ${expected} in ${POSTGRES_FOLLOW_TIMEOUT_MS / 1000} s after the raise`,
			)
		}
		if (restartedAt === undefined) {
			throw new PlatformFactError(fact.id, fact.section, 'max_connections changed without a restart of the single-node database')
		}
		if (outageMs > POSTGRES_OUTAGE_BOUND_MS) {
			throw new PlatformFactError(fact.id, fact.section, `the database refused connections for ${outageMs} ms while it restarted`)
		}
	}

	return {
		scripts: { 'postgres-raise-min-ram': raiseMinRamRow, 'postgres-max-connections-follow': followRow },
		stop: async () => {
			await raise?.stopSampling()
		},
	}
}

const postgres = postgresProbe()

const backupProbeImport = (database: string): string =>
	['services:', `  - hostname: ${database}`, '    type: postgresql:single@18', `    profile: ${POSTGRES_PROBE_PROFILE}`, ''].join('\n')

/**
 * Imports its own `postgresql:single@18`, prints the backup configuration a fresh one reads, and sets the platform
 * database's period through the deploy step's own `ensureBackupPeriod`. The fact holds when the period reads back,
 * the retention reads back as it was sent, and a second run changes nothing. The printed lines record the formats.
 */
const backupPeriodRow: FactScript = async ({ transport, context, fact }) => {
	const projectId = required(context, 'projectId')
	const database = required(context, 'backupHostname')
	const imported = await callApi(transport, 'POST', `/project/${projectId}/service-stack/import`, { yaml: backupProbeImport(database) })
	if (imported.status !== 200) {
		throw new PlatformFactError(fact.id, fact.section, `importing the database answered ${imported.status}`)
	}
	for (const processId of resolvePath(imported.body, 'serviceStacks[*].processes[*].id')) {
		if (typeof processId === 'string') await awaitProcessTerminal(transport, processId)
	}
	const databaseId = await findServiceId(transport, projectId, database)
	if (databaseId === null) {
		throw new PlatformFactError(fact.id, fact.section, 'the import did not leave the database')
	}
	context.set('backupServiceId', databaseId)
	const printBackupConfig = async (moment: string): Promise<void> => {
		const read = await callApi(transport, 'GET', `/service-stack/${databaseId}/backup`)
		const body = read.status === 200 ? read.body : null
		console.info(
			`platform-facts.live: ${moment} ${database} answers ${read.status}: backupPeriod ${JSON.stringify(first(body, 'backupPeriod'))}, `
				+ `retentionPolicy ${JSON.stringify(first(body, 'retentionPolicy') ?? null)}, defaultRetentionPolicy ${
					JSON.stringify(first(body, 'defaultRetentionPolicy') ?? null)
				}, ${resolvePath(body, 'files[*]').length} file(s)`,
		)
	}
	await printBackupConfig('a fresh')

	const api = createZeropsApi({ token: transport.token })
	const before = await api.getBackupConfig({ serviceId: databaseId, signal: transport.signal })
	const sent = before.retentionPolicy ?? before.defaultRetentionPolicy
	const ensure = () =>
		ensureBackupPeriod({
			api,
			sleep: (ms) => transport.sleep(ms),
			signal: transport.signal,
			serviceId: databaseId,
			hostname: database,
			period: PLATFORM_DATABASE_BACKUP_PERIOD,
			dryRun: false,
		})
	const startedAtMs = Date.now()
	const outcome = await ensure()
	console.info(`platform-facts.live: ensureBackupPeriod answered ${outcome.kind} after ${Date.now() - startedAtMs} ms`)
	await printBackupConfig('the updated')
	if (outcome.kind !== 'changed') {
		throw new PlatformFactError(fact.id, fact.section, `a fresh database already reads ${PLATFORM_DATABASE_BACKUP_PERIOD}, so nothing was set`)
	}
	const after = await api.getBackupConfig({ serviceId: databaseId, signal: transport.signal })
	if (!Bun.deepEquals(after.retentionPolicy, sent)) {
		throw new PlatformFactError(fact.id, fact.section, 'the retention read back differs from the one sent whole')
	}
	const again = await ensure()
	if (again.kind !== 'unchanged') {
		throw new PlatformFactError(fact.id, fact.section, `a second run answered ${again.kind}`)
	}
}

const scripts: Record<string, FactScript> = {
	'unpacker-flat-archive': unpackerProbe({ directoryEntries: false, expected: 'BUILD_FAILED' }),
	'unpacker-directory-entries': unpackerProbe({ directoryEntries: true, expected: 'ACTIVE' }),
	'failing-exec-readiness': unpackerProbe({ directoryEntries: true, expected: 'DEPLOY_FAILED', failure: 'exec-readiness' }),
	'failing-init-command': unpackerProbe({ directoryEntries: true, expected: 'DEPLOY_FAILED', failure: 'init-command' }),
	'slow-init-command': unpackerProbe({ directoryEntries: true, expected: 'ACTIVE', failure: 'slow-init-command' }),
	'authorization-forwarded': authorizationForwarded,
	...postgres.scripts,
	'postgres-backup-period': backupPeriodRow,
}

describe.skipIf(!hasLiveAccount)('the platform-facts table, against a real Zerops account', () => {
	const context: FactContext = new Map()
	const created: string[] = []
	/** Everything the run could conceivably have left in the project, including a refusal that did not refuse. */
	const cleanup: string[] = []
	const deleted: string[] = []
	let transport: FactTransport

	beforeAll(async () => {
		if (account === null) return
		const runId = newRunId()
		const hostname = `${RUN_PREFIX}${runId}`
		transport = {
			baseUrl: API_BASE,
			token: account.token,
			fetch: (url, init) => fetch(url, init),
			sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
			signal: AbortSignal.timeout(BUILD_ROW_TIMEOUT_MS * 2),
		}
		context.set('projectId', account.projectId)
		context.set('hostname', hostname)
		context.set('deleteHostname', `${hostname}d`)
		context.set('countHostname', `${hostname}c`)
		// The one imported WITHOUT `startWithoutCode`, which is the precondition every no-op fact needs.
		context.set('noopHostname', `${hostname}n`)
		context.set('absentHostname', `${hostname}x`)
		context.set('setupProbeHostname', `${hostname}s`)
		// A syntactically well-formed id this account has never issued. The fact under test is the STATUS.
		context.set('absentAppVersionId', 'AAAAAAAAAAAAAAAAAAAAAA')
		context.set('postgresHostname', `${hostname}p`)
		context.set('sqlClientHostname', `${hostname}q`)
		context.set('backupHostname', `${hostname}b`)
		created.push(hostname, `${hostname}d`, `${hostname}c`, `${hostname}n`)
		// Only the build-length PostgreSQL rows create these three, so a run without them deletes nothing more.
		cleanup.push(`${hostname}p`, `${hostname}q`, `${hostname}b`)
		// The `zeropsSetup` row expects a refusal; if the platform ever accepts it, the service is still ours.
		cleanup.push(...created, `${hostname}s`)
		console.info(`platform-facts.live: run ${runId} will create ${created.join(', ')} in the configured project`)
		await reportLeaks(transport, account.projectId, cleanup)
	}, ROW_TIMEOUT_MS)

	afterAll(async () => {
		if (account === null) return
		await postgres.stop()
		// Its OWN transport: the run-wide signal may already have fired, and an aborted signal would make
		// every delete below a no-op while the suite reported nothing left behind.
		const cleaner: FactTransport = {
			...transport,
			signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
		}
		const survivors: string[] = []
		for (const name of cleanup) {
			// One name's failure must not cost the others their delete.
			try {
				const serviceId = await findServiceId(cleaner, account.projectId, name)
				if (serviceId === null) continue
				const removing = await callApi(cleaner, 'DELETE', `/service-stack/${serviceId}`)
				// A 200 is the delete PROCESS starting, not the service being gone (~21 s live). Wait it out, then
				// read the name back: the read is the proof, and reporting on the 200 alone would be a guess.
				const processId = text(first(removing.body, 'id'))
				if (processId !== undefined) {
					await awaitProcessTerminal(cleaner, processId)
				}
				if (await findServiceId(cleaner, account.projectId, name) === null) {
					deleted.push(name)
				} else {
					survivors.push(name)
				}
			} catch (error) {
				survivors.push(name)
				console.warn(`platform-facts.live: could not delete ${name} — ${error instanceof Error ? error.name : 'unknown failure'}`)
			}
		}
		console.info(`platform-facts.live: deleted ${deleted.length === 0 ? 'nothing' : deleted.join(', ')}`)
		if (survivors.length > 0) {
			console.warn(`platform-facts.live: STILL PRESENT, delete by hand — ${survivors.join(', ')}`)
		}
	}, CLEANUP_TIMEOUT_MS)

	const rows = factsFor('live', { slow: account?.slow === true })
	test('the table has rows to run', () => {
		expect(rows.length).toBeGreaterThan(0)
	})

	for (const fact of rows) {
		test(`${fact.id} [${fact.live}]`, async () => {
			assertLiveRowIsSafe(fact)
			await runFact({ transport, fact, context, scripts })
		}, fact.live === 'build' ? BUILD_ROW_TIMEOUT_MS : ROW_TIMEOUT_MS)
	}
})

/** Report — never adopt, never delete — anything an interrupted earlier run left behind. */
const reportLeaks = async (transport: FactTransport, projectId: string, ours: readonly string[]): Promise<void> => {
	const listed = await callApi(transport, 'GET', `/project/${projectId}/service-stack?limit=200&offset=0`)
	if (listed.status !== 200) {
		console.warn(`platform-facts.live: could not list the project's services (${listed.status}); leak check skipped`)
		return
	}
	const names = resolvePath(listed.body, 'list[*].name').filter((name): name is string => typeof name === 'string')
	const leaked = names.filter((name) => name.startsWith(RUN_PREFIX) && !ours.includes(name))
	if (leaked.length > 0) {
		console.warn(
			`platform-facts.live: ${leaked.length} service(s) left by an earlier run — ${leaked.join(', ')}. `
				+ 'Nothing here adopts or deletes one; remove them yourself.',
		)
	}
}

const findServiceId = async (transport: FactTransport, projectId: string, hostname: string): Promise<string | null> => {
	const found = await callApi(transport, 'GET', `/service-stack-by-name/${projectId}/${encodeURIComponent(hostname)}`)
	return found.status === 200 ? text(first(found.body, 'id')) ?? null : null
}
