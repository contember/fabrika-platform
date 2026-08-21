// The platform-facts table, run against a REAL Zerops account.
//
// Opt-in, the same convention the Postgres- and S3-backed suites use: configure it and it runs, leave it
// unconfigured and it skips with a message saying exactly what to set and what the run will do.
//
//   FABRIKA_LIVE_ZEROPS_TOKEN=<access token> FABRIKA_LIVE_ZEROPS_PROJECT_ID=<throwaway project> \
//     bun test packages/provider-zerops/src/__tests__/platform-facts.live.test.ts
//   FABRIKA_LIVE_ZEROPS_SLOW=1 …    also runs the two build-length unpacker rows (minutes each)
//
// WHAT IT DOES TO THE PROJECT. It imports four throwaway services named `wu1<run id>*`, writes and removes
// a handful of `FABRIKA_FACT_*` variables on one of them, and deletes both services again — including when
// a row failed. It never creates or deletes a project, never touches a service it did not create, and never
// adopts one left behind by an earlier run: a leaked name is REPORTED at startup and left alone, because
// adopting it would let an interrupted run silently change a later one's result.
//
// The token is read here and put in one header. It is never logged, never asserted on, and never included
// in a failure message.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
	assertLiveRowIsSafe,
	awaitProcessTerminal,
	callApi,
	type FactContext,
	type FactScript,
	factsFor,
	type FactTransport,
	PlatformFactError,
	resolvePath,
	runFact,
} from './platform-facts'
import { probeArchive, probeDescriptor } from './platform-facts-archive'

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

export const skipReason = `skipped: set ${TOKEN_VAR} and ${PROJECT_VAR} (plus ${SLOW_VAR}=1 for the two build-length rows) to run `
	+ `the platform-facts table against a real Zerops account — it imports four throwaway ${RUN_PREFIX}* services into that `
	+ `project, writes and deletes their variables, and deletes every service it created again`

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
const unpackerProbe = (options: { directoryEntries: boolean; expected: string }): FactScript => async ({ transport, context, fact }) => {
	const serviceId = required(context, 'serviceId')
	const hostname = required(context, 'hostname')
	const reserved = await callApi(transport, 'POST', `/service-stack/${serviceId}/app-version`, {
		name: `${hostname}-${options.directoryEntries ? 'dirs' : 'flat'}`,
	})
	if (reserved.status < 200 || reserved.status >= 300) {
		throw new PlatformFactError(fact.id, fact.section, `reserving an app version answered ${reserved.status}`)
	}
	const appVersionId = text(first(reserved.body, 'id'))
	const uploadUrl = text(first(reserved.body, 'uploadUrl'))
	if (appVersionId === undefined || uploadUrl === undefined) {
		throw new PlatformFactError(fact.id, fact.section, 'the app-version reservation carried no id or no upload URL')
	}
	const uploaded = await transport.fetch(uploadUrl, {
		method: 'PUT',
		body: probeArchive({ directoryEntries: options.directoryEntries }),
		signal: transport.signal,
	})
	if (!uploaded.ok) {
		// Never the URL and never the body: both can carry the presigned credential.
		throw new PlatformFactError(fact.id, fact.section, `uploading the probe archive answered ${uploaded.status}`)
	}
	const started = await callApi(transport, 'PUT', `/app-version/${appVersionId}/build-and-deploy`, {
		zeropsYaml: probeDescriptor(hostname),
		zeropsYamlSetup: hostname,
	})
	if (started.status < 200 || started.status >= 300) {
		throw new PlatformFactError(fact.id, fact.section, `build-and-deploy answered ${started.status}`)
	}
	const settled = await pollAppVersion(transport, appVersionId)
	if (settled !== options.expected) {
		throw new PlatformFactError(fact.id, fact.section, `the app version settled on ${settled}, expected ${options.expected}`)
	}
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

const scripts: Record<string, FactScript> = {
	'unpacker-flat-archive': unpackerProbe({ directoryEntries: false, expected: 'BUILD_FAILED' }),
	'unpacker-directory-entries': unpackerProbe({ directoryEntries: true, expected: 'ACTIVE' }),
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
		created.push(hostname, `${hostname}d`, `${hostname}c`, `${hostname}n`)
		// The `zeropsSetup` row expects a refusal; if the platform ever accepts it, the service is still ours.
		cleanup.push(...created, `${hostname}s`)
		console.info(`platform-facts.live: run ${runId} will create ${created.join(', ')} in the configured project`)
		await reportLeaks(transport, account.projectId, cleanup)
	}, ROW_TIMEOUT_MS)

	afterAll(async () => {
		if (account === null) return
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
