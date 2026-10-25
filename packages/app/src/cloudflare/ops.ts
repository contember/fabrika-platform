// The object's side of Control's ops channel (ADR-0069 §1, §2): it authenticates the caller before it reads anything
// the request names, answers every refusal with `opsRefusal()`, and serves the view from its storage alone, so it
// works while the application cannot boot. Framework code only: an ops request never reaches the contract.

import {
	type ApplicationObjects,
	ENDPOINT_HEADER,
	FABRIKA_APPLICATION_OBJECT,
	FABRIKA_APPLICATION_OBJECTS,
	FABRIKA_OPS_KEY_DIGESTS,
	formatEndpointHeader,
	OPS_METHOD,
	OPS_ROW_COUNT_CAP,
	OPS_STALE_STATUS,
	type OpsBootFailureContent,
	type OpsContentView,
	opsKeyDigest,
	type OpsOperation,
	type OpsPublishedState,
	opsRefusal,
	type OpsStaleRefusal,
	type OpsView,
	parseApplicationObjects,
	parseOpsContentView,
	parseOpsExportRequest,
	parseOpsImportRequest,
	parseOpsInspectRequest,
	parseOpsKeyDigests,
	parseOpsMigrateAck,
	parseOpsMigrateRequest,
	parseOpsOperation,
	parseOpsRestoreRequest,
	parseOpsStateRequest,
	parseOpsTimersRequest,
	parseOpsView,
} from '@fabrika/auth-core'
import { FILES_TABLE, JOB_LEASES_TABLE, WEBHOOK_BINDINGS_TABLE, WEBHOOK_DELIVERIES_TABLE } from '@fabrika/db/migrations'
import type { SqliteCursor, SqliteStorage, SqliteValue } from '@fabrika/db/sqlite'
import { opsProxyRow } from '@fabrika/proxy-core/manifest'
import { timingSafeEqual } from 'node:crypto'
import appPackage from '../../package.json' with { type: 'json' }
import { jsonResponse } from '../errors.js'
import { serveExport } from './export.js'
import { serveImport } from './import.js'
import type { MaintenanceBarrier, TransitionResult } from './maintenance.js'
import { serveRestore } from './restore.js'
import { serveTimers } from './tracker.js'

/** What the view reads of the object's storage; workerd's `DurableObjectStorage` has both optional members. */
export interface OpsStorage {
	readonly sql: {
		exec(query: string, ...bindings: SqliteValue[]): SqliteCursor
		/** The bun:sqlite test double has no size. */
		readonly databaseSize?: number
	}
	/** The bun:sqlite test double has no alarm. */
	getAlarm?(): Promise<number | null>
}

/**
 * The object's point-in-time recovery: workerd's storage bookmarks and the abort that resets the object. `null` where the
 * storage has none (the bun:sqlite double, a runtime without PITR).
 */
export interface OpsRecovery {
	getCurrentBookmark(): Promise<string>
	getBookmarkForTime(time: number): Promise<string>
	onNextSessionRestoreBookmark(bookmark: string): Promise<string>
	abort(reason: string): void
}

const OPS_ROW = opsProxyRow()

/** `X-Fabrika-Endpoint` of the composed ops row, the only value an ops request may carry (ADR-0022 rule 3). */
export const OPS_ENDPOINT = formatEndpointHeader(OPS_ROW.id, OPS_ROW.digest)

/** A view with no data but one table, through which `admittedTableName` asks the wire's own parser about a name. */
const ONE_TABLE_VIEW = {
	release: '0.0.0',
	maintenance: { mode: 'open', generation: null, published: false },
	migrations: [],
	scheduler: { alarm: null },
	jobs: [],
	files: [],
	webhooks: [],
	bootFailure: null,
}

/** The migration ledger `@fabrika/db/sqlite-migrate` keeps in the object's SQLite. */
const MIGRATION_LEDGER = 'fabrika_migrations'

/** What the platform wrote for the ops channel: the key digests and the objects a request may name. */
export interface OpsAccess {
	readonly digests: readonly Uint8Array[]
	readonly objects: ApplicationObjects
}

/** The environment's ops access, or `null` (an older deploy, or a malformed value), which refuses every ops request. */
export function opsAccess(env: Readonly<Record<string, unknown>>): OpsAccess | null {
	const digests = parseOpsKeyDigests(stringOf(env[FABRIKA_OPS_KEY_DIGESTS]) ?? '')
	const objects = parseApplicationObjects(stringOf(env[FABRIKA_APPLICATION_OBJECT]), stringOf(env[FABRIKA_APPLICATION_OBJECTS]))
	if (digests === null || objects === null) {
		return null
	}
	return { digests: digests.map((digest) => new TextEncoder().encode(digest)), objects }
}

/** What an ops request reads of the object it reached. */
export interface OpsTarget {
	readonly storage: OpsStorage & SqliteStorage
	/** The environment's bucket (the `FABRIKA_FILES` R2 binding), where dumps and the maintenance state live. */
	readonly bucket: unknown
	readonly recovery: OpsRecovery | null
	/**
	 * The instance's last failed boot, the application's error text included. Asked only after authentication: it
	 * waits for a boot under way and never starts one.
	 */
	bootFailure(): Promise<OpsBootFailureContent | null>
	/** The barrier of the object named `object`, read from R2 on a cold start; rejects while R2 cannot be read. */
	maintenance(object: string): Promise<MaintenanceBarrier>
	/** Runs the pending migrations and boots the application; `false` when the boot failed. */
	migrate(): Promise<boolean>
}

/**
 * Answers an ops request the Worker forwarded with the proxy secret, which the object checked before. Authentication
 * runs first; an unknown operation, a malformed body and an object name the list lacks are refused after it. Every
 * operation needs the barrier, so while R2 cannot be read each answers 503.
 */
export async function serveOps(request: Request, access: OpsAccess | null, target: OpsTarget): Promise<Response> {
	if (access === null || !opsAuthenticated(request, access)) {
		return opsRefusal()
	}
	const operation = parseOpsOperation(new URL(request.url).pathname)
	if (operation === null) {
		return opsRefusal()
	}
	const body = await jsonBody(request)
	const object = objectNamed(operation, body)
	if (object === null || !access.objects.objects.includes(object)) {
		return opsRefusal()
	}
	let barrier: MaintenanceBarrier
	try {
		barrier = await target.maintenance(object)
	} catch {
		return new Response(null, { status: 503 })
	}
	switch (operation) {
		case 'inspect': {
			const inspect = parseOpsInspectRequest(body)
			return inspect === null ? opsRefusal() : jsonResponse(await inspectView(target, barrier, inspect.content), 200)
		}
		case 'state': {
			const transition = parseOpsStateRequest(body)
			return transition === null ? opsRefusal() : transitionAnswer(await barrier.transition(transition))
		}
		case 'migrate': {
			const migration = parseOpsMigrateRequest(body)
			return migration === null ? opsRefusal() : await migrateAnswer(target, barrier, migration.generation)
		}
		case 'export': {
			const step = parseOpsExportRequest(body)
			return step === null ? opsRefusal() : await serveExport(target, barrier, step)
		}
		case 'import': {
			const step = parseOpsImportRequest(body)
			return step === null ? opsRefusal() : await serveImport(target, barrier, step)
		}
		case 'restore': {
			const step = parseOpsRestoreRequest(body)
			return step === null ? opsRefusal() : await serveRestore(target, barrier, step, object === access.objects.object)
		}
		case 'timers': {
			const timers = parseOpsTimersRequest(body)
			return timers === null ? opsRefusal() : serveTimers(timers)
		}
	}
}

/** A transition's answer: the acknowledgement, the 409 naming what is published, or a 503 that Control retries. */
function transitionAnswer(result: TransitionResult): Response {
	switch (result.kind) {
		case 'acknowledged':
			return jsonResponse(result.ack, 200)
		case 'stale':
			return staleRefusal(result.published)
		case 'failed':
			return new Response(null, { status: 503 })
	}
}

/** Runs the migrations under the published generation and acknowledges with the new ledger; a failed boot is a 500. */
async function migrateAnswer(target: OpsTarget, barrier: MaintenanceBarrier, generation: number): Promise<Response> {
	const result = await barrier.migrate(generation, () => target.migrate())
	if (result.kind === 'stale') {
		return staleRefusal(result.published)
	}
	if (!result.value) {
		return new Response(null, { status: 500 })
	}
	const migrations = tableNames(target.storage).includes(MIGRATION_LEDGER) ? migrationLedger(target.storage) : []
	const ack = parseOpsMigrateAck({ generation, migrations })
	if (ack === null) {
		throw new Error("the object's migration ledger does not parse as the wire's acknowledgement")
	}
	return jsonResponse(ack, 200)
}

function staleRefusal(published: OpsPublishedState | null): Response {
	const refusal: OpsStaleRefusal = { refused: 'stale_generation', published }
	return jsonResponse(refusal, OPS_STALE_STATUS)
}

/** The object an ops request names, read with its operation's strict parser; `null` for a body that does not parse. */
export function objectNamed(operation: OpsOperation, body: unknown): string | null {
	switch (operation) {
		case 'inspect':
			return parseOpsInspectRequest(body)?.object ?? null
		case 'state':
			return parseOpsStateRequest(body)?.object ?? null
		case 'migrate':
			return parseOpsMigrateRequest(body)?.object ?? null
		case 'export':
			return parseOpsExportRequest(body)?.object ?? null
		case 'import':
			return parseOpsImportRequest(body)?.object ?? null
		case 'restore':
			return parseOpsRestoreRequest(body)?.object ?? null
		case 'timers':
			return parseOpsTimersRequest(body)?.object ?? null
	}
}

/** The request's body as JSON, or `undefined` when it is none: every parser refuses `undefined`. */
export async function jsonBody(request: { text(): Promise<string> }): Promise<unknown> {
	try {
		return JSON.parse(await request.text())
	} catch {
		return undefined
	}
}

/**
 * Control's credentials on an ops request: the row's method, its endpoint header, and a key whose digest is one the
 * platform wrote, compared in constant time. The Worker and the object both run it; it reads nothing the body names.
 */
export function opsAuthenticated(request: Request, access: OpsAccess): boolean {
	if (request.method !== OPS_METHOD || request.headers.get(ENDPOINT_HEADER) !== OPS_ENDPOINT) {
		return false
	}
	const authorization = request.headers.get('Authorization') ?? ''
	const key = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : ''
	if (key === '') {
		return false
	}
	const presented = new TextEncoder().encode(opsKeyDigest(key))
	let matched = false
	for (const digest of access.digests) {
		// Every digest is compared, so the answer's timing does not say which one matched.
		if (timingSafeEqual(presented, digest)) {
			matched = true
		}
	}
	return matched
}

/**
 * The view of the object's storage, read and never written. A table the framework has not created yet (a boot that
 * failed before its migrations) reads as empty. What the storage holds is parsed by the wire's own parser.
 */
async function inspectView(target: OpsTarget, barrier: MaintenanceBarrier, content: boolean): Promise<OpsView | OpsContentView> {
	const { storage } = target
	const bootFailure = await target.bootFailure()
	const tables = tableNames(storage)
	const has = (name: string) => tables.includes(name)
	const alarm = storage.getAlarm === undefined ? missing('getAlarm') : await storage.getAlarm()
	const view = {
		release: appPackage.version,
		maintenance: barrier.view(),
		database: {
			sizeBytes: storage.sql.databaseSize ?? missing('sql.databaseSize'),
			tables: tables.filter(admittedTableName).map((name) => ({ name, rows: cappedCount(storage, name) })),
		},
		migrations: has(MIGRATION_LEDGER) ? migrationLedger(storage) : [],
		scheduler: { alarm: alarm === null ? null : new Date(alarm).toISOString() },
		jobs: has(JOB_LEASES_TABLE)
			? rows(
				storage,
				`select job, last_status as lastStatus, last_started_at as lastStartedAt, last_finished_at as lastFinishedAt,
					last_duration_ms as lastDurationMs from ${JOB_LEASES_TABLE} order by job`,
			)
			: [],
		files: has(FILES_TABLE)
			? rows(storage, `select kind, status, count(*) as count from ${FILES_TABLE} group by kind, status order by kind, status`)
			: [],
		webhooks: has(WEBHOOK_BINDINGS_TABLE) && has(WEBHOOK_DELIVERIES_TABLE)
			? rows(
				storage,
				`select b.webhook as webhook, case when d.lease_until is null then 'completed' else 'claimed' end as state, count(*) as count
				from ${WEBHOOK_DELIVERIES_TABLE} d join ${WEBHOOK_BINDINGS_TABLE} b on b.id = d.binding_id
				group by 1, 2 order by 1, 2`,
			)
			: [],
		bootFailure: content || bootFailure === null ? bootFailure : { at: bootFailure.at },
	}
	const parsed = content ? parseOpsContentView(view) : parseOpsView(view)
	if (parsed === null) {
		throw new Error("the object's ops view does not parse as the wire's view")
	}
	return parsed
}

/** The ledger `@fabrika/db/sqlite-migrate` keeps, as the wire names its rows; read only once the table exists. */
function migrationLedger(storage: OpsStorage): Record<string, SqliteValue>[] {
	return rows(storage, `select bundle, name, checksum, applied_at as appliedAt from ${MIGRATION_LEDGER} order by bundle, name`)
}

/** Cloudflare's own `_cf_*` tables and SQLite's `sqlite_*` are no table of the application or the framework. */
function tableNames(storage: OpsStorage): string[] {
	return storage.sql.exec(
		`select name from sqlite_schema where type = 'table' and name not like '\\_cf\\_%' escape '\\' and name not like 'sqlite\\_%' escape '\\'
		order by name`,
	).toArray().flatMap((row) => typeof row['name'] === 'string' ? [row['name']] : [])
}

/**
 * Whether the view admits `name`. A table SQLite allows but the wire does not (`"MixedCase"`, from a raw migration) is
 * left out, so one such table never takes the whole view down with it.
 */
function admittedTableName(name: string): boolean {
	return parseOpsView({ ...ONE_TABLE_VIEW, database: { sizeBytes: 0, tables: [{ name, rows: 0 }] } }) !== null
}

/** At most `OPS_ROW_COUNT_CAP`: a full count bills every row read. */
function cappedCount(storage: OpsStorage, table: string): unknown {
	const quoted = `"${table.replaceAll('"', '""')}"`
	return storage.sql.exec(`select count(*) as count from (select 1 from ${quoted} limit ${OPS_ROW_COUNT_CAP})`).toArray()[0]?.['count']
}

function rows(storage: OpsStorage, query: string): Record<string, SqliteValue>[] {
	return storage.sql.exec(query).toArray()
}

function missing(member: string): never {
	throw new Error(`the object's storage has no ${member}; a Durable Object's storage has it`)
}

function stringOf(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined
}
