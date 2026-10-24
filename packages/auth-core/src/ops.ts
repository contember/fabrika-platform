// The ops wire (ADR-0069): the one platform-composed row through which Control reaches an application environment's
// object on Cloudflare, the requests it sends there and the answers the object gives. Control and the framework both
// import it, so the two sides parse one shape. Every parser is strict: an unknown key, a missing field or a wrong type
// refuses the whole value.

import { isDigest } from './endpoint-digest'
import { FRAMEWORK_RELEASE_PATTERN } from './framework-release'
import { prop } from './json'
import { sha256Hex } from './sha256'
import { WORKLOAD_NAME } from './workloads'

/** Every ops request's path lies under this prefix, on the environment's own domain. */
export const OPS_PREFIX = '/__fabrika/ops/'

/**
 * The fixed id of the composed row. An authored endpoint id starts with a letter, so no contract can take it. The row's
 * digest is not a constant: proxy-core computes it where every row is digested, from these fields.
 */
export const OPS_ROW_ID = '__fabrika.ops'

/** The composed row's path. */
export const OPS_ROW_PATH = `${OPS_PREFIX}*`

/** The composed row's method. */
export const OPS_METHOD = 'POST'

/** The one content type the composed row admits. */
export const OPS_CONTENT_TYPE = 'application/json'

/** The operations the object serves, each at `opsPath(operation)`. */
export const OPS_OPERATIONS = ['inspect', 'state', 'migrate'] as const

export type OpsOperation = (typeof OPS_OPERATIONS)[number]

export function opsPath(operation: OpsOperation): string {
	return `${OPS_PREFIX}${operation}`
}

/** The operation a request path names, or `null` for any other path, which gets `opsRefusal()`. */
export function parseOpsOperation(path: string): OpsOperation | null {
	return OPS_OPERATIONS.find((operation) => opsPath(operation) === path) ?? null
}

/**
 * The one answer inside the prefix to a missing or wrong key, a wrong endpoint header, an unknown operation and a
 * refused object name: the same status, no body and no headers, so none of them tells the caller which it was.
 */
export const OPS_REFUSAL_STATUS = 404

export function opsRefusal(): Response {
	return new Response(null, { status: OPS_REFUSAL_STATUS })
}

/** Ops key digests: `sha256:<64 hex>` of each key, joined by `,`; one, or two while a rotation reconciles. */
export type OpsKeyDigests = readonly [string] | readonly [string, string]

/** The digest of an ops key, the only form the object holds (`FABRIKA_OPS_KEY_DIGESTS`). */
export function opsKeyDigest(key: string): string {
	return `sha256:${sha256Hex(key)}`
}

/** The value of `FABRIKA_OPS_KEY_DIGESTS`, or `null` unless it holds one or two distinct digests. */
export function parseOpsKeyDigests(value: string): OpsKeyDigests | null {
	const [first, second, ...rest] = value.split(',')
	if (first === undefined || !isDigest(first) || rest.length > 0) return null
	if (second === undefined) return [first]
	return isDigest(second) && second !== first ? [first, second] : null
}

/** The value Control writes into `FABRIKA_OPS_KEY_DIGESTS`; throws on a list `parseOpsKeyDigests` would refuse. */
export function formatOpsKeyDigests(digests: OpsKeyDigests): string {
	const value = digests.join(',')
	if (parseOpsKeyDigests(value) === null) throw new Error('ops key digests must be one or two distinct sha256 digests')
	return value
}

/** The object of ordinary traffic without `FABRIKA_APPLICATION_OBJECT`, and the only one an ops request may name then. */
export const DEFAULT_APPLICATION_OBJECT = 'application'

/** The most names `FABRIKA_APPLICATION_OBJECTS` holds. */
export const MAX_APPLICATION_OBJECTS = 16

/** An object name: lowercase, at most 63 characters, safe as one segment of an R2 key. */
const APPLICATION_OBJECT_NAME = /^[a-z][a-z0-9-]{0,62}$/

export function parseApplicationObjectName(value: unknown): string | null {
	return typeof value === 'string' && APPLICATION_OBJECT_NAME.test(value) ? value : null
}

/** The object of ordinary traffic, and the objects an ops request may name, which include it. */
export interface ApplicationObjects {
	readonly object: string
	readonly objects: readonly string[]
}

/**
 * `FABRIKA_APPLICATION_OBJECT` and `FABRIKA_APPLICATION_OBJECTS` (distinct names joined by `,`, 1 to 16, holding the
 * first), or `null`. Without either the object is `application`; a deploy writes both, so one alone is refused.
 */
export function parseApplicationObjects(object: string | undefined, objects: string | undefined): ApplicationObjects | null {
	if (object === undefined && objects === undefined) return { object: DEFAULT_APPLICATION_OBJECT, objects: [DEFAULT_APPLICATION_OBJECT] }
	if (object === undefined || objects === undefined || parseApplicationObjectName(object) === null) return null
	const names = objects.split(',')
	const valid = names.length <= MAX_APPLICATION_OBJECTS && names.every((name) => parseApplicationObjectName(name) !== null)
	return valid && new Set(names).size === names.length && names.includes(object) ? { object, objects: names } : null
}

/** The R2 key, in the environment's bucket, of the maintenance state of `object`. */
export function OPS_STATE_KEY(object: string): string {
	if (parseApplicationObjectName(object) === null) throw new Error('an ops state key needs a valid object name')
	return `__fabrika/ops/${object}.json`
}

/** The maintenance modes, from the most permissive. */
export const OPS_MODES = ['open', 'read-only', 'closed', 'inspect'] as const

export type OpsMode = (typeof OPS_MODES)[number]

/** A table's row count is capped here: a full count bills every row read. A count at the cap means at least the cap. */
export const OPS_ROW_COUNT_CAP = 100_000

/** `POST /__fabrika/ops/inspect`: the projection, or with `content` the content-bearing view (`data.content.read`). */
export interface OpsInspectRequest {
	readonly object: string
	readonly content: boolean
}

/** `POST /__fabrika/ops/state`: a maintenance transition under a generation Control allocated. */
export interface OpsStateRequest {
	readonly object: string
	readonly generation: number
	readonly mode: OpsMode
}

/** Sent once the state is published and the drain is over; `stillRunning` counts what ran past the drain's bound. */
export interface OpsStateAck {
	readonly generation: number
	readonly mode: OpsMode
	readonly stillRunning: number
}

/** `POST /__fabrika/ops/migrate`: run the pending migrations under the published generation. */
export interface OpsMigrateRequest {
	readonly object: string
	readonly generation: number
}

/** The state a transition is judged against: the object's current generation and mode, `null` before the first. */
export interface OpsPublishedState {
	readonly generation: number
	readonly mode: OpsMode
}

/**
 * Whether a transition is stale: a lower generation, or the same with another mode. The same generation and mode is a
 * retry, which the object replays.
 */
export function opsTransitionRefused(current: OpsPublishedState | null, request: OpsPublishedState): boolean {
	if (current === null) return false
	return request.generation < current.generation || (request.generation === current.generation && request.mode !== current.mode)
}

/** The status of a stale refusal. It is answered only after authentication, so it may say what is published. */
export const OPS_STALE_STATUS = 409

/** The body of a stale refusal of a transition or a migration. */
export interface OpsStaleRefusal {
	readonly refused: 'stale_generation'
	readonly published: OpsPublishedState | null
}

/** One row of the object's migration ledger. */
export interface OpsMigration {
	readonly bundle: string
	readonly name: string
	readonly checksum: string
	readonly appliedAt: string
}

/** Sent once the migrations ran and the application booted, with the new ledger. */
export interface OpsMigrateAck {
	readonly generation: number
	readonly migrations: readonly OpsMigration[]
}

export interface OpsMaintenance {
	readonly mode: OpsMode
	/** `null` while no transition was ever published: the object is `open`. */
	readonly generation: number | null
	/** Whether R2 holds this state; `false` while its put is pending. */
	readonly published: boolean
}

export interface OpsTableCount {
	readonly name: string
	/** At most `OPS_ROW_COUNT_CAP`. */
	readonly rows: number
}

export interface OpsDatabase {
	readonly sizeBytes: number
	readonly tables: readonly OpsTableCount[]
}

export interface OpsScheduler {
	/** The current alarm, or `null` when none is set. */
	readonly alarm: string | null
}

/** A job's last run and its outcome. */
export interface OpsJob {
	readonly job: string
	readonly lastStatus: 'succeeded' | 'failed' | null
	readonly lastStartedAt: string | null
	readonly lastFinishedAt: string | null
	readonly lastDurationMs: number | null
}

export type OpsFileStatus = 'pending' | 'quarantined' | 'live' | 'rejected'

export interface OpsFileCount {
	readonly kind: string
	readonly status: OpsFileStatus
	readonly count: number
}

/** A delivery is `claimed` while it holds a lease, `completed` once its handler's transaction cleared it. */
export interface OpsWebhookCount {
	readonly webhook: string
	readonly state: 'claimed' | 'completed'
	readonly count: number
}

export interface OpsBootFailure {
	readonly at: string
}

/** The boot failure with the application's error text, which is content. */
export interface OpsBootFailureContent extends OpsBootFailure {
	readonly message: string
	readonly stack: string | null
}

/**
 * The allowlisted projection (`data.read`): counts, sizes, timestamps, the identifiers the platform or the contract
 * names, and status codes. Every timestamp is ISO 8601 in UTC with milliseconds.
 */
export interface OpsView {
	readonly release: string
	readonly maintenance: OpsMaintenance
	readonly database: OpsDatabase
	readonly migrations: readonly OpsMigration[]
	readonly scheduler: OpsScheduler
	readonly jobs: readonly OpsJob[]
	readonly files: readonly OpsFileCount[]
	readonly webhooks: readonly OpsWebhookCount[]
	readonly bootFailure: OpsBootFailure | null
}

/** The view a `data.content.read` caller gets: the projection, with the application's error text. */
export interface OpsContentView extends Omit<OpsView, 'bootFailure'> {
	readonly bootFailure: OpsBootFailureContent | null
}

// A request's `object` is only well-formed here; the handler refuses a name its list does not hold with `opsRefusal()`.
export function parseOpsInspectRequest(body: unknown): OpsInspectRequest | null {
	const object = parseApplicationObjectName(prop(body, 'object'))
	const content = prop(body, 'content')
	return exactKeys(body, ['object', 'content']) && object !== null && typeof content === 'boolean' ? { object, content } : null
}

export function parseOpsStateRequest(body: unknown): OpsStateRequest | null {
	if (!exactKeys(body, ['object', 'generation', 'mode'])) return null
	const object = parseApplicationObjectName(prop(body, 'object'))
	const generation = readGeneration(prop(body, 'generation'))
	const mode = readMode(prop(body, 'mode'))
	return object === null || generation === null || mode === null ? null : { object, generation, mode }
}

export function parseOpsStateAck(body: unknown): OpsStateAck | null {
	if (!exactKeys(body, ['generation', 'mode', 'stillRunning'])) return null
	const generation = readGeneration(prop(body, 'generation'))
	const mode = readMode(prop(body, 'mode'))
	const stillRunning = readCount(prop(body, 'stillRunning'))
	return generation === null || mode === null || stillRunning === null ? null : { generation, mode, stillRunning }
}

export function parseOpsMigrateRequest(body: unknown): OpsMigrateRequest | null {
	const object = parseApplicationObjectName(prop(body, 'object'))
	const generation = readGeneration(prop(body, 'generation'))
	return exactKeys(body, ['object', 'generation']) && object !== null && generation !== null ? { object, generation } : null
}

export function parseOpsStaleRefusal(body: unknown): OpsStaleRefusal | null {
	if (!exactKeys(body, ['refused', 'published']) || prop(body, 'refused') !== 'stale_generation') return null
	const raw = prop(body, 'published')
	if (raw === null) return { refused: 'stale_generation', published: null }
	if (!exactKeys(raw, ['generation', 'mode'])) return null
	const generation = readGeneration(prop(raw, 'generation'))
	const mode = readMode(prop(raw, 'mode'))
	return generation === null || mode === null ? null : { refused: 'stale_generation', published: { generation, mode } }
}

export function parseOpsMigrateAck(body: unknown): OpsMigrateAck | null {
	if (!exactKeys(body, ['generation', 'migrations'])) return null
	const generation = readGeneration(prop(body, 'generation'))
	const migrations = readList(prop(body, 'migrations'), readMigration)
	return generation === null || migrations === null ? null : { generation, migrations }
}

export function parseOpsView(body: unknown): OpsView | null {
	const failure = prop(body, 'bootFailure')
	const bootFailure = failure === null ? null : readBootFailure(failure)
	if (bootFailure === undefined) return null
	const view = readViewFields(body)
	return view === null ? null : { ...view, bootFailure }
}

export function parseOpsContentView(body: unknown): OpsContentView | null {
	const failure = prop(body, 'bootFailure')
	const bootFailure = failure === null ? null : readBootFailureContent(failure)
	if (bootFailure === undefined) return null
	const view = readViewFields(body)
	return view === null ? null : { ...view, bootFailure }
}

const VIEW_KEYS = ['release', 'maintenance', 'database', 'migrations', 'scheduler', 'jobs', 'files', 'webhooks', 'bootFailure']
const FILE_STATUSES: readonly OpsFileStatus[] = ['pending', 'quarantined', 'live', 'rejected']
const WEBHOOK_STATES = ['claimed', 'completed'] as const
const JOB_STATUSES = ['succeeded', 'failed'] as const
/** The form `Date.prototype.toISOString` and SQLite's `%Y-%m-%dT%H:%M:%fZ` both write. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
/** `@fabrika/db`'s `isPlainIdentifier`: the only table names the data layer admits. */
const TABLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/
/** The contract build's authored-name rule (`@fabrika/app/contract`), which a file kind follows. */
const CONTRACT_NAME = /^[A-Za-z][A-Za-z0-9_]*$/
/** `@fabrika/db`'s SQLite migration runner: a bundle name, a migration file name and a file's SHA-256 hex. */
const MIGRATION_BUNDLE = /^[a-z][a-z0-9-]*$/
const MIGRATION_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.sql$/
const MIGRATION_CHECKSUM = /^[0-9a-f]{64}$/

/** Every field of the view but the boot failure, whose form differs between the two views. */
function readViewFields(body: unknown): Omit<OpsView, 'bootFailure'> | null {
	if (!exactKeys(body, VIEW_KEYS)) return null
	const release = prop(body, 'release')
	const maintenance = readMaintenance(prop(body, 'maintenance'))
	const database = readDatabase(prop(body, 'database'))
	const migrations = readList(prop(body, 'migrations'), readMigration)
	const scheduler = readScheduler(prop(body, 'scheduler'))
	const jobs = readList(prop(body, 'jobs'), readJob)
	const files = readList(prop(body, 'files'), readFileCount)
	const webhooks = readList(prop(body, 'webhooks'), readWebhookCount)
	if (
		typeof release !== 'string' || !FRAMEWORK_RELEASE_PATTERN.test(release) || maintenance === null || database === null || migrations === null
		|| scheduler === null || jobs === null || files === null || webhooks === null
	) {
		return null
	}
	return { release, maintenance, database, migrations, scheduler, jobs, files, webhooks }
}

function readMaintenance(value: unknown): OpsMaintenance | null {
	if (!exactKeys(value, ['mode', 'generation', 'published'])) return null
	const mode = readMode(prop(value, 'mode'))
	const rawGeneration = prop(value, 'generation')
	const generation = rawGeneration === null ? null : readGeneration(rawGeneration)
	const published = prop(value, 'published')
	if (mode === null || (rawGeneration !== null && generation === null) || typeof published !== 'boolean') return null
	return { mode, generation, published }
}

function readDatabase(value: unknown): OpsDatabase | null {
	if (!exactKeys(value, ['sizeBytes', 'tables'])) return null
	const sizeBytes = readCount(prop(value, 'sizeBytes'))
	const tables = readList(prop(value, 'tables'), readTableCount)
	return sizeBytes === null || tables === null ? null : { sizeBytes, tables }
}

function readTableCount(value: unknown): OpsTableCount | null {
	if (!exactKeys(value, ['name', 'rows'])) return null
	const name = readMatch(prop(value, 'name'), TABLE_NAME)
	const rows = readCount(prop(value, 'rows'))
	return name === null || rows === null || rows > OPS_ROW_COUNT_CAP ? null : { name, rows }
}

function readMigration(value: unknown): OpsMigration | null {
	if (!exactKeys(value, ['bundle', 'name', 'checksum', 'appliedAt'])) return null
	const bundle = readMatch(prop(value, 'bundle'), MIGRATION_BUNDLE)
	const name = readMatch(prop(value, 'name'), MIGRATION_NAME)
	const checksum = readMatch(prop(value, 'checksum'), MIGRATION_CHECKSUM)
	const appliedAt = readTimestamp(prop(value, 'appliedAt'))
	return bundle === null || name === null || checksum === null || appliedAt === null ? null : { bundle, name, checksum, appliedAt }
}

function readScheduler(value: unknown): OpsScheduler | null {
	if (!exactKeys(value, ['alarm'])) return null
	const raw = prop(value, 'alarm')
	const alarm = raw === null ? null : readTimestamp(raw)
	return raw !== null && alarm === null ? null : { alarm }
}

function readJob(value: unknown): OpsJob | null {
	if (!exactKeys(value, ['job', 'lastStatus', 'lastStartedAt', 'lastFinishedAt', 'lastDurationMs'])) return null
	const job = readMatch(prop(value, 'job'), WORKLOAD_NAME)
	const lastStatus = readNullable(prop(value, 'lastStatus'), (status) => readEnum(status, JOB_STATUSES))
	const lastStartedAt = readNullable(prop(value, 'lastStartedAt'), readTimestamp)
	const lastFinishedAt = readNullable(prop(value, 'lastFinishedAt'), readTimestamp)
	const lastDurationMs = readNullable(prop(value, 'lastDurationMs'), readCount)
	if (job === null || lastStatus === undefined || lastStartedAt === undefined || lastFinishedAt === undefined || lastDurationMs === undefined) {
		return null
	}
	return { job, lastStatus, lastStartedAt, lastFinishedAt, lastDurationMs }
}

function readFileCount(value: unknown): OpsFileCount | null {
	if (!exactKeys(value, ['kind', 'status', 'count'])) return null
	const kind = readMatch(prop(value, 'kind'), CONTRACT_NAME)
	const status = readEnum(prop(value, 'status'), FILE_STATUSES)
	const count = readCount(prop(value, 'count'))
	return kind === null || status === null || count === null ? null : { kind, status, count }
}

function readWebhookCount(value: unknown): OpsWebhookCount | null {
	if (!exactKeys(value, ['webhook', 'state', 'count'])) return null
	const webhook = readMatch(prop(value, 'webhook'), WORKLOAD_NAME)
	const state = readEnum(prop(value, 'state'), WEBHOOK_STATES)
	const count = readCount(prop(value, 'count'))
	return webhook === null || state === null || count === null ? null : { webhook, state, count }
}

/** `undefined` for a value that is no boot failure; the caller reads `null` as none before calling. */
function readBootFailure(value: unknown): OpsBootFailure | undefined {
	const at = readTimestamp(prop(value, 'at'))
	return exactKeys(value, ['at']) && at !== null ? { at } : undefined
}

function readBootFailureContent(value: unknown): OpsBootFailureContent | undefined {
	if (!exactKeys(value, ['at', 'message', 'stack'])) return undefined
	const at = readTimestamp(prop(value, 'at'))
	const message = prop(value, 'message')
	const stack = prop(value, 'stack')
	if (at === null || typeof message !== 'string' || (stack !== null && typeof stack !== 'string')) return undefined
	return { at, message, stack }
}

/** Whether `value` is a plain object holding exactly `keys`: no key missing, none unknown. */
function exactKeys(value: unknown, keys: readonly string[]): boolean {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
	const own = Object.keys(value)
	return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function readList<T>(value: unknown, read: (item: unknown) => T | null): readonly T[] | null {
	if (!Array.isArray(value)) return null
	const items: T[] = []
	for (const item of value) {
		const parsed = read(item)
		if (parsed === null) return null
		items.push(parsed)
	}
	return items
}

/** `null` stays `null`; anything else is read, and `undefined` marks a value `read` refused. */
function readNullable<T>(value: unknown, read: (value: unknown) => T | null): T | null | undefined {
	if (value === null) return null
	return read(value) ?? undefined
}

function readEnum<T extends string>(value: unknown, members: readonly T[]): T | null {
	return members.find((member) => member === value) ?? null
}

function readMode(value: unknown): OpsMode | null {
	return readEnum(value, OPS_MODES)
}

/** A generation Control allocated: a positive safe integer. */
function readGeneration(value: unknown): number | null {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function readCount(value: unknown): number | null {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** An identifier the platform or the contract names, in its owner's format: free text never fits one. */
function readMatch(value: unknown, pattern: RegExp): string | null {
	return typeof value === 'string' && pattern.test(value) ? value : null
}

/** `Date` rolls an impossible date over (`02-31` to `03-03`), so the instant must print back as the same text. */
function readTimestamp(value: unknown): string | null {
	if (typeof value !== 'string' || !TIMESTAMP.test(value)) return null
	const instant = new Date(value)
	return !Number.isNaN(instant.getTime()) && instant.toISOString() === value ? value : null
}
