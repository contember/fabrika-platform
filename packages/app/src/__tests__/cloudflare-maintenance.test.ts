// The environment object's maintenance barrier (ADR-0069 §3): transitions published to R2 by conditional puts, the
// drain of what runs, the write fence and the cold starts, each driven through Control's ops requests and checked by
// what ordinary traffic sees. Each object is constructed directly over bun:sqlite, as workerd constructs it, with an
// in-memory bucket whose versions, conflicts and failures the test controls, and workerd's input gate: while a storage
// transaction or `blockConcurrencyWhile` runs, no other event reaches the object.

import { defineApp, file } from '@fabrika/app/contract'
import {
	ENDPOINT_HEADER,
	FABRIKA_APPLICATION_OBJECT,
	FABRIKA_APPLICATION_OBJECTS,
	FABRIKA_OPS_KEY_DIGESTS,
	formatOpsKeyDigests,
	opsKeyDigest,
	type OpsPublishedState,
	parseOpsMigrateAck,
	parseOpsStateAck,
	parseOpsView,
	PROXY_SECRET_HEADER,
} from '@fabrika/auth-core'
import { scoped, type TypedColumnList } from '@fabrika/db'
import { defineTables } from '@fabrika/db/tables'
import { Database as BunDatabase } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { AsyncLocalStorage } from 'node:async_hooks'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { bunSqliteStorage } from '../../../db/src/sqlite-bun'
import { applicationMigrations } from '../build'
import { type ApplicationState, createContractWorker, FabrikaApplication } from '../cloudflare'
import { TICK_HEADER } from '../cloudflare/application'
import { MaintenanceBarrier, type MaintenanceStore } from '../cloudflare/maintenance'
import { CLOUDFLARE_FILES_BINDING } from '../cloudflare/names'
import { OPS_ENDPOINT } from '../cloudflare/ops'
import { type ContractImplementation, serve } from '../implement'
import { admitInvocation, runGated } from '../implement/dispatch'
import type { NotesTable } from './cloudflare-fixture/src/db/schema.generated'
import { vocabulary } from './cloudflare-fixture/src/vocabulary'
import {
	endpointHeaderFor,
	frameworkEnvFor,
	grant,
	keepingProcessEnvironment,
	keySource,
	ORIGIN,
	PROXY_SECRET,
	token,
	workloadTokensFor,
} from './fixtures/implement/harness'

const FIXTURE_ROOT = join(import.meta.dir, 'cloudflare-fixture')
const OPS_KEY = 'ops-key-of-the-environment-0123456789abcdef'
const STATE_KEY = '__fabrika/ops/application.json'
const WORKSPACE = { type: 'workspace', value: 'w1' }
/** A minute tick on the file sweep's schedule (minute 41), when no contract job is due. */
const SWEEP_TICK = Date.UTC(2026, 9, 25, 4, 41, 0)
/** A stored timestamp past the sweep's grace and the file retention window. */
const LONG_AGO = '2020-01-01T00:00:00.000Z'

/** The fixture's notes, and documents: an application-wide table whose column references a stored file. */
interface DB {
	notes: NotesTable
	documents: { id: string; file: string }
}

const columns: TypedColumnList<DB> = {
	notes: { columns: ['id', 'workspace_id', 'title', 'created_by', 'version'], foreignKeys: [] },
	documents: { columns: ['id', 'file'], foreignKeys: [] },
}

const tables = defineTables(vocabulary, columns)({
	notes: {
		scope: { dimension: 'note', key: 'id', in: { dimension: 'workspace', column: 'workspace_id' } },
		actions: { read: 'notes.read', insert: 'notes.write', update: 'notes.write' },
		insert: ['title'],
		update: ['title'],
		version: 'version',
		createdBy: 'created_by',
	},
	documents: {
		scope: { app: 'one shelf of documents per environment' },
		actions: { read: 'notes.read', insert: 'notes.write' },
		insert: ['file'],
		files: { file: 'attachments' },
	},
})

const DOCUMENTS_MIGRATION = {
	name: '20261025120000_documents.sql',
	sql: 'CREATE TABLE documents (id TEXT PRIMARY KEY, file TEXT NOT NULL REFERENCES fabrika_files (id)) STRICT;',
}

const app = defineApp(vocabulary, tables)

/** What the handlers of the contract below wait for; each test sets the ones it holds. */
const holds: {
	afterWrite: (() => Promise<void>) | null
	job: ((signal: AbortSignal) => Promise<void>) | null
} = { afterWrite: null, job: null }

const NewNote = z.strictObject({ workspaceId: z.string().min(1), title: z.string().min(1) })
const InWorkspace = z.strictObject({ workspaceId: z.string().min(1) })
const Created = z.strictObject({ id: z.uuid() })
const Titles = z.strictObject({ titles: z.array(z.string()) })

const notes = app.group({ callers: ['human'] }, (r) => ({
	create: r.mutation({ input: NewNote, output: Created, access: { action: 'notes.write', in: 'workspace', from: 'workspaceId' } })
		.handle(async ({ input, ctx }) => {
			const { id } = await ctx.db.target.notes.insert({ title: input.title })
			await holds.afterWrite?.()
			return { id }
		}),
	createAndAttach: r.mutation({ input: NewNote, output: Created, access: { action: 'notes.write', in: 'workspace', from: 'workspaceId' } })
		.handle(async ({ input, ctx }) => {
			const { id } = await ctx.db.target.notes.insert({ title: input.title })
			await ctx.files.put('attachments', new TextEncoder().encode(input.title), { type: 'text/plain' })
			return { id }
		}),
	createAndKick: r.mutation({
		input: NewNote,
		output: Created,
		access: { action: 'notes.write', in: 'workspace', from: 'workspaceId' },
		kicks: ['slow'],
	}).handle(async ({ input, ctx }) => {
		const { id } = await ctx.db.target.notes.insert({ title: input.title })
		ctx.kick('slow')
		return { id }
	}),
	titles: r.query({ input: InWorkspace, output: Titles, access: { action: 'notes.read', in: 'workspace', from: 'workspaceId' } })
		.handle(async ({ ctx }) => ({ titles: (await ctx.db.target.notes.list({ orderBy: [['title', 'asc']] })).items.map((note) => note.title) })),
	upload: r.mutation({ input: z.strictObject({ file: file('attachments') }), output: Created, access: { action: 'notes.write', app: true } })
		.handle(async ({ input, ctx }) => ({ id: (await ctx.db.app.documents.insert({ file: input.file })).id })),
}))

const slow = app.cron('0 3 * * *', { actions: ['notes.read'] }).handle(async ({ ctx }) => {
	await holds.job?.(ctx.signal)
})

const alerts = app.webhook('/hooks/alerts', {
	boundTo: 'app',
	actions: ['notes.write'],
	scheme: { bearer: true },
	input: z.strictObject({ id: z.string() }),
})
	.handle(async () => {})

const contract = app.contract((c) => ({
	api: c.rpc('/api', { notes }),
	health: c.health('/healthz'),
	files: { attachments: c.files({ maxBytes: 4096, types: ['text/plain'] }) },
	jobs: { slow },
	alerts,
}))

/**
 * The environment's bucket: the maintenance state's versioned object, with the conditions R2 applies and failures a
 * test injects, and the stored files' objects.
 */
class Bucket {
	readonly objects = new Map<string, { readonly body: string; readonly etag: string }>()
	readonly files = new Map<string, Uint8Array>()
	/** Every key a file's object was written under, and every key deleted, in order. */
	readonly written: string[] = []
	readonly deleted: string[] = []
	/** How many of the next reads, or puts, of the maintenance state fail. */
	failReads = 0
	failPuts = 0
	/** Runs before each put of the maintenance state is applied, so a test can act while it is in flight. */
	beforePut: (() => Promise<void>) | null = null
	/** Runs before a file's object is deleted, so a test can hold the sweep there. */
	beforeDelete: (() => Promise<void>) | null = null
	puts = 0
	#versions = 0

	set(state: OpsPublishedState): void {
		this.objects.set(STATE_KEY, { body: JSON.stringify(state), etag: `v${++this.#versions}` })
	}

	state(): unknown {
		const stored = this.objects.get(STATE_KEY)
		return stored === undefined ? null : JSON.parse(stored.body)
	}

	head = (key: string) => {
		const bytes = this.files.get(key)
		return Promise.resolve(bytes === undefined ? null : { size: bytes.byteLength, etag: `f-${key}` })
	}

	delete = async (key: string) => {
		await this.beforeDelete?.()
		this.deleted.push(key)
		this.files.delete(key)
	}

	get = (key: string) => {
		if (key !== STATE_KEY) {
			const bytes = this.files.get(key)
			return Promise.resolve(bytes === undefined ? null : { size: bytes.byteLength, etag: `f-${key}`, body: new Blob([bytes.slice()]).stream() })
		}
		if (this.failReads > 0) {
			this.failReads--
			return Promise.reject(new Error('R2 is unavailable'))
		}
		const stored = this.objects.get(key)
		return Promise.resolve(stored === undefined ? null : { etag: stored.etag, text: () => Promise.resolve(stored.body) })
	}

	put = async (
		key: string,
		body: string | Uint8Array,
		options: { readonly onlyIf: { readonly etagMatches?: string; readonly etagDoesNotMatch?: string } },
	) => {
		if (key !== STATE_KEY) {
			if (typeof body === 'string' || this.files.has(key)) return null
			this.files.set(key, body)
			this.written.push(key)
			return { etag: `f-${key}`, size: body.byteLength }
		}
		if (typeof body !== 'string') throw new Error('the maintenance state is JSON text')
		this.puts++
		await this.beforePut?.()
		if (this.failPuts > 0) {
			this.failPuts--
			throw new Error('R2 is unavailable')
		}
		const stored = this.objects.get(key)
		const { etagMatches, etagDoesNotMatch } = options.onlyIf
		if ((etagMatches !== undefined && stored?.etag !== etagMatches) || (etagDoesNotMatch === '*' && stored !== undefined)) {
			return null
		}
		const etag = `v${++this.#versions}`
		this.objects.set(key, { body, etag })
		return { etag }
	}
}

/**
 * workerd's input gate: while a storage transaction or a `blockConcurrencyWhile` callback runs, no other event is
 * delivered to the object. One nested inside a callback already holds the gate.
 */
class InputGate {
	#closed: Promise<void> | null = null
	readonly #inside = new AsyncLocalStorage<true>()

	async hold<T>(work: () => Promise<T>): Promise<T> {
		if (this.#inside.getStore() === true) {
			return await work()
		}
		while (this.#closed !== null) {
			await this.#closed
		}
		const opened = Promise.withResolvers<void>()
		this.#closed = opened.promise
		try {
			return await this.#inside.run(true, work)
		} finally {
			this.#closed = null
			opened.resolve()
		}
	}

	async deliver<T>(event: () => Promise<T>): Promise<T> {
		while (this.#closed !== null) {
			await this.#closed
		}
		return await event()
	}
}

/** The object as its Worker reaches it: each request is an event the input gate delivers. */
interface ObjectStub {
	fetch(request: Request): Promise<Response>
}

interface Started {
	readonly object: ObjectStub
	readonly database: BunDatabase
	readonly bucket: Bucket
	/** What the object handed to `waitUntil`. */
	readonly pending: Promise<unknown>[]
	readonly loads: { count: number }
	/** Another instance of the same object over the same database and bucket, as after an eviction. */
	restart(): ObjectStub
}

interface StartOptions {
	readonly bucket?: Bucket
	readonly database?: BunDatabase
	readonly load?: () => Promise<{ readonly default: ContractImplementation }>
}

async function start(options: StartOptions = {}): Promise<Started> {
	const implementation = serve(contract, { database: scoped(tables) })
	const loads = { count: 0 }
	createContractWorker(() => {
		loads.count++
		return options.load?.() ?? Promise.resolve({ default: implementation })
	}, { migrations: [...(await applicationMigrations(FIXTURE_ROOT)), DOCUMENTS_MIGRATION] })
	const database = options.database ?? new BunDatabase(':memory:')
	const bucket = options.bucket ?? new Bucket()
	const tokens = workloadTokensFor(implementation)
	const pending: Promise<unknown>[] = []
	const env = {
		...frameworkEnvFor(implementation),
		FABRIKA_PROXY_SECRET: PROXY_SECRET,
		IAM: { getJwks: () => keySource.getJwks(), mintFromKey: (input: { app: string; key: string }) => tokens.exchange(input) },
		[CLOUDFLARE_FILES_BINDING]: bucket,
		[FABRIKA_OPS_KEY_DIGESTS]: formatOpsKeyDigests([opsKeyDigest(OPS_KEY)]),
		[FABRIKA_APPLICATION_OBJECT]: 'application',
		[FABRIKA_APPLICATION_OBJECTS]: 'application',
	}
	const instance = (): ObjectStub => {
		const gate = new InputGate()
		const inner = bunSqliteStorage(database)
		const state: ApplicationState = {
			// The size and the alarm the ops view reads, which workerd's storage has.
			storage: {
				...inner,
				sql: { exec: inner.sql.exec, databaseSize: 0 },
				getAlarm: () => Promise.resolve(null),
				transaction: (closure) => gate.hold(() => inner.transaction(closure)),
			},
			blockConcurrencyWhile: (callback) => gate.hold(callback),
			waitUntil: (promise) => void pending.push(promise),
		}
		const object = new FabrikaApplication(state, env)
		return { fetch: (request) => gate.deliver(() => object.fetch(request)) }
	}
	return { object: instance(), database, bucket, pending, loads, restart: instance }
}

function opsRequest(operation: string, body: unknown): Request {
	return new Request(`${ORIGIN}/__fabrika/ops/${operation}`, {
		method: 'POST',
		headers: {
			[PROXY_SECRET_HEADER]: PROXY_SECRET,
			[ENDPOINT_HEADER]: OPS_ENDPOINT,
			Authorization: `Bearer ${OPS_KEY}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	})
}

async function transition(object: ObjectStub, generation: number, mode: OpsPublishedState['mode']): Promise<Response> {
	return await object.fetch(opsRequest('state', { object: 'application', generation, mode }))
}

async function maintenance(object: ObjectStub): Promise<unknown> {
	const response = await object.fetch(opsRequest('inspect', { object: 'application', content: false }))
	expect(response.status).toBe(200)
	return parseOpsView(await response.json())?.maintenance
}

type Procedure = 'create' | 'createAndAttach' | 'createAndKick' | 'titles' | 'upload'

async function procedureRequest(procedure: Procedure, contentType: string, body: BodyInit): Promise<Request> {
	const path = `/api/notes.${procedure}`
	return new Request(`${ORIGIN}${path}`, {
		method: 'POST',
		headers: {
			[PROXY_SECRET_HEADER]: PROXY_SECRET,
			'X-Fabrika-Token': await token('user', [grant('notes.read', WORKSPACE), grant('notes.write', WORKSPACE), grant('notes.write')]),
			'X-Fabrika-Endpoint': endpointHeaderFor(serve(contract, { database: scoped(tables) }), 'POST', path) ?? '',
			'Content-Type': contentType,
			'Sec-Fetch-Site': 'same-origin',
		},
		body,
	})
}

async function call(object: ObjectStub, procedure: Procedure, input: unknown): Promise<Response> {
	return await object.fetch(await procedureRequest(procedure, 'application/json', JSON.stringify(input)))
}

/**
 * A body whose bytes from `split` on arrive only once the test releases them. `waiting` resolves once the reader took
 * the first bytes and asked for more: the request was admitted and is reading its body.
 */
function heldBody(bytes: Uint8Array, split: number): { readonly body: ReadableStream<Uint8Array>; readonly waiting: Promise<void>; release(): void } {
	const waiting = Promise.withResolvers<void>()
	const released = Promise.withResolvers<void>()
	let pulls = 0
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			pulls++
			if (pulls === 1) {
				controller.enqueue(bytes.slice(0, split))
				return
			}
			waiting.resolve()
			await released.promise
			controller.enqueue(bytes.slice(split))
			controller.close()
		},
	})
	return { body, waiting: waiting.promise, release: () => released.resolve() }
}

const BOUNDARY = 'maintenance-boundary'

/** A form's body: the input part, then one text file under the field `file`. */
function uploadForm(content: string): Uint8Array<ArrayBuffer> {
	const text = [
		`--${BOUNDARY}`,
		'Content-Disposition: form-data; name="input"',
		'Content-Type: application/json',
		'',
		'{}',
		`--${BOUNDARY}`,
		'Content-Disposition: form-data; name="file"; filename="note.txt"',
		'Content-Type: text/plain',
		'',
		content,
		`--${BOUNDARY}--`,
		'',
	].join('\r\n')
	return new TextEncoder().encode(text)
}

async function upload(object: ObjectStub, body: BodyInit): Promise<Response> {
	return await object.fetch(await procedureRequest('upload', `multipart/form-data; boundary=${BOUNDARY}`, body))
}

const health = () => new Request(`${ORIGIN}/healthz`, { headers: { [PROXY_SECRET_HEADER]: PROXY_SECRET } })
const tick = (at: number) =>
	new Request(`${ORIGIN}/`, { method: 'POST', headers: { [PROXY_SECRET_HEADER]: PROXY_SECRET, [TICK_HEADER]: String(at) } })

function noteTitles(database: BunDatabase): string[] {
	return database.query<{ title: string }, []>('select title from notes order by title').all().map((row) => row.title)
}

function hasTable(database: BunDatabase, name: string): boolean {
	return database.query<{ name: string }, [string]>("select name from sqlite_schema where type = 'table' and name = ?").get(name) !== null
}

function storedFiles(database: BunDatabase): { status: string; object_key: string }[] {
	return database.query<{ status: string; object_key: string }, []>('select status, object_key from fabrika_files order by created_at').all()
}

function queuedDeletions(database: BunDatabase): string[] {
	return database.query<{ object_key: string }, []>('select object_key from fabrika_file_deletions order by object_key').all().map((row) =>
		row.object_key
	)
}

/** Whether `promise` settled within a few turns of the event loop. */
async function settles(promise: Promise<unknown>): Promise<boolean> {
	let settled = false
	void promise.then(() => (settled = true), () => (settled = true))
	await Bun.sleep(20)
	return settled
}

/** Waits until `condition` holds, a turn of the event loop at a time. */
async function until(condition: () => boolean): Promise<void> {
	for (let turn = 0; turn < 200 && !condition(); turn++) {
		await Bun.sleep(1)
	}
	expect(condition()).toBe(true)
}

async function acked(response: Response): Promise<unknown> {
	expect(response.status).toBe(200)
	return parseOpsStateAck(await response.json())
}

/** A refusal of maintenance: 503 with `Retry-After`. */
function refusedForMaintenance(response: Response): void {
	expect(response.status).toBe(503)
	expect(response.headers.get('Retry-After')).toBe('30')
}

describe('the write fence and the drain', () => {
	test('a mutation admitted before read-only and paused in its body rolls back on the stale generation: 503, and the drain waits for it', async () => {
		await keepingProcessEnvironment(async () => {
			const { object, database } = await start()
			expect((await call(object, 'create', { workspaceId: 'w1', title: 'before' })).status).toBe(200)
			const held = heldBody(new TextEncoder().encode(JSON.stringify({ workspaceId: 'w1', title: 'in flight' })), 8)
			const mutation = object.fetch(await procedureRequest('create', 'application/json', held.body))
			// Admitted and reading its body: no transaction is open yet, so the transition is delivered.
			await held.waiting
			const restricting = transition(object, 1, 'read-only')
			expect(await settles(restricting)).toBe(false)
			// The switch came before any await: a new mutation is refused while the first still runs.
			refusedForMaintenance(await call(object, 'create', { workspaceId: 'w1', title: 'after' }))
			held.release()
			// Its write ran in its transaction, and the fence refused the commit: a maintenance refusal, nothing kept.
			refusedForMaintenance(await mutation)
			expect(await acked(await restricting)).toEqual({ generation: 1, mode: 'read-only', stillRunning: 0 })
			expect(noteTitles(database)).toEqual(['before'])
			const read = await call(object, 'titles', { workspaceId: 'w1' })
			expect(read.status).toBe(200)
			expect(await read.json()).toEqual({ result: { titles: ['before'] } })
		})
	})

	test('a transition sent while a write holds the object transaction is delivered once it committed', async () => {
		await keepingProcessEnvironment(async () => {
			const { object, database, bucket } = await start()
			const written = Promise.withResolvers<void>()
			const release = Promise.withResolvers<void>()
			holds.afterWrite = () => {
				written.resolve()
				return release.promise
			}
			try {
				const mutation = call(object, 'create', { workspaceId: 'w1', title: 'in flight' })
				await written.promise
				const restricting = transition(object, 1, 'read-only')
				expect(await settles(restricting)).toBe(false)
				// The input gate holds the transition back: it has not switched the mode or put anything yet.
				expect(bucket.puts).toBe(0)
				release.resolve()
				expect((await mutation).status).toBe(200)
				expect(await acked(await restricting)).toEqual({ generation: 1, mode: 'read-only', stillRunning: 0 })
			} finally {
				holds.afterWrite = null
			}
			expect(noteTitles(database)).toEqual(['in flight'])
		})
	})

	test('a put whose commit the fence refuses is a known rollback: its object is deleted at once', async () => {
		await keepingProcessEnvironment(async () => {
			const { object, database, bucket } = await start()
			const held = heldBody(new TextEncoder().encode(JSON.stringify({ workspaceId: 'w1', title: 'attached' })), 8)
			const mutation = object.fetch(await procedureRequest('createAndAttach', 'application/json', held.body))
			await held.waiting
			const restricting = transition(object, 1, 'read-only')
			expect(await settles(restricting)).toBe(false)
			held.release()
			refusedForMaintenance(await mutation)
			await acked(await restricting)
			// The bytes reached R2 inside the handler; the rolled-back pending row left only the request knowing them.
			expect(bucket.written).toHaveLength(1)
			expect(bucket.deleted).toEqual(bucket.written)
			expect(bucket.files.size).toBe(0)
			expect(noteTitles(database)).toEqual([])
			expect(storedFiles(database)).toEqual([])
		})
	})

	test('the drain stops a kicked run and waits until its handler settled', async () => {
		await keepingProcessEnvironment(async () => {
			const { object, pending } = await start()
			const started = Promise.withResolvers<AbortSignal>()
			const release = Promise.withResolvers<void>()
			holds.job = (signal) => {
				started.resolve(signal)
				return release.promise
			}
			try {
				expect((await call(object, 'createAndKick', { workspaceId: 'w1', title: 'kicks' })).status).toBe(200)
				const signal = await started.promise
				const closing = transition(object, 1, 'closed')
				expect(await settles(closing)).toBe(false)
				expect(signal.aborted).toBe(true)
				release.resolve()
				expect(await acked(await closing)).toEqual({ generation: 1, mode: 'closed', stillRunning: 0 })
				await Promise.all(pending)
			} finally {
				holds.job = null
			}
			expect((await object.fetch(health())).status).toBe(503)
		})
	})

	test('the drain stops a scheduled run the minute tick started and waits until its handler settled', async () => {
		await keepingProcessEnvironment(async () => {
			const { object, pending } = await start()
			const started = Promise.withResolvers<AbortSignal>()
			const release = Promise.withResolvers<void>()
			holds.job = (signal) => {
				started.resolve(signal)
				return release.promise
			}
			try {
				expect((await object.fetch(tick(Date.UTC(2026, 9, 25, 3, 0, 0)))).status).toBe(204)
				const signal = await started.promise
				const closing = transition(object, 1, 'closed')
				expect(await settles(closing)).toBe(false)
				expect(signal.aborted).toBe(true)
				release.resolve()
				expect(await acked(await closing)).toEqual({ generation: 1, mode: 'closed', stillRunning: 0 })
				await Promise.all(pending)
			} finally {
				holds.job = null
			}
		})
	})

	test('the drain stops a framework run, the file sweep, and its writes after the switch are fenced', async () => {
		await keepingProcessEnvironment(async () => {
			const { object, database, bucket, pending } = await start()
			expect((await object.fetch(health())).status).toBe(200)
			// Two tombstones past the retention window, whose objects the sweep deletes one after the other.
			for (const key of ['attachments/first', 'attachments/second']) {
				bucket.files.set(key, new TextEncoder().encode(key))
				database.query('insert into fabrika_file_deletions (object_key, recorded_at) values (?, ?)').run(key, LONG_AGO)
			}
			const deleting = Promise.withResolvers<void>()
			const release = Promise.withResolvers<void>()
			bucket.beforeDelete = () => {
				bucket.beforeDelete = null
				deleting.resolve()
				return release.promise
			}
			expect((await object.fetch(tick(SWEEP_TICK))).status).toBe(204)
			await deleting.promise
			const closing = transition(object, 1, 'closed')
			expect(await settles(closing)).toBe(false)
			release.resolve()
			expect(await acked(await closing)).toEqual({ generation: 1, mode: 'closed', stillRunning: 0 })
			await Promise.all(pending)
			// The first object went; the claim of the second is a write the fence refused, so its tombstone stays.
			expect(bucket.deleted).toEqual(['attachments/first'])
			expect(queuedDeletions(database)).toEqual(['attachments/second'])
			expect(bucket.files.has('attachments/second')).toBe(true)
		})
	})

	test('read-only admits reads only, and an event admitted before a transition admits nothing more', async () => {
		const barrier = await MaintenanceBarrier.load({ read: () => Promise.resolve(null), put: () => Promise.resolve('v1') })
		const before = barrier.event()
		expect(await barrier.transition({ generation: 1, mode: 'read-only' })).toMatchObject({ kind: 'acknowledged' })
		expect(runGated(before, () => admitInvocation('read'))).toBeNull()
		const after = barrier.event()
		expect(runGated(after, () => admitInvocation('read'))).not.toBeNull()
		for (const kind of ['write', 'webhook', 'kick', 'job', 'framework-job'] as const) {
			expect(runGated(after, () => admitInvocation(kind))).toBeNull()
		}
		// Outside an object nothing is gated.
		expect(admitInvocation('write')).not.toBeNull()
	})

	test('a webhook delivery is refused outside open, and the sender retries', async () => {
		await keepingProcessEnvironment(async () => {
			const { object } = await start()
			const path = `/hooks/alerts/${crypto.randomUUID()}`
			const delivery = () =>
				new Request(`${ORIGIN}${path}`, {
					method: 'POST',
					headers: {
						[PROXY_SECRET_HEADER]: PROXY_SECRET,
						'X-Fabrika-Endpoint': endpointHeaderFor(serve(contract, { database: scoped(tables) }), 'POST', path) ?? '',
						'Content-Type': 'application/json',
						Authorization: 'Bearer the-senders-own-token',
					},
					body: JSON.stringify({ id: 'evt_1' }),
				})
			// Open: the delivery reaches the webhook, which refuses a binding it does not know.
			expect((await object.fetch(delivery())).status).not.toBe(503)
			for (const [generation, mode] of [[1, 'read-only'], [2, 'closed']] as const) {
				await acked(await transition(object, generation, mode))
				refusedForMaintenance(await object.fetch(delivery()))
			}
		})
	})

	test('work running past the bound is counted in the acknowledgement, not waited for', async () => {
		const barrier = await MaintenanceBarrier.load({ read: () => Promise.resolve(null), put: () => Promise.resolve('v1') }, { drainBoundMs: 10 })
		const admission = barrier.event().admit('write')
		if (admission === null) throw new Error('an open object admits a write')
		const job = barrier.event().admit('job')
		if (job === null) throw new Error('an open object admits a job')
		// A handler that outlived its attempt counts on its own, past the run.
		const outliving = Promise.withResolvers<void>()
		job.track(outliving.promise)
		const result = await barrier.transition({ generation: 1, mode: 'closed' })
		expect(result).toEqual({ kind: 'acknowledged', ack: { generation: 1, mode: 'closed', stillRunning: 3 } })
		// The drain stops a run at once; a request gets the handler's share of the bound and is fenced instead.
		expect(job.signal.aborted).toBe(true)
		expect(admission.signal.aborted).toBe(false)
		admission.release()
		job.release()
		outliving.resolve()
	})

	test('in read-only and closed the minute tick runs nothing and writes nothing', async () => {
		await keepingProcessEnvironment(async () => {
			const { object, database, pending } = await start()
			expect((await object.fetch(health())).status).toBe(200)
			let ran = 0
			holds.job = () => {
				ran++
				return Promise.resolve()
			}
			try {
				for (const [generation, mode] of [[1, 'read-only'], [2, 'closed']] as const) {
					await acked(await transition(object, generation, mode))
					const changes = database.query<{ changes: number }, []>('select total_changes() as changes').get()?.changes
					expect((await object.fetch(tick(Date.UTC(2026, 9, 25, 3, 0, 0)))).status).toBe(204)
					await Promise.all(pending.splice(0))
					expect(database.query<{ changes: number }, []>('select total_changes() as changes').get()?.changes).toBe(changes)
				}
				expect(ran).toBe(0)
				await acked(await transition(object, 3, 'open'))
				expect((await object.fetch(tick(Date.UTC(2026, 9, 25, 3, 0, 0)))).status).toBe(204)
				await Promise.all(pending.splice(0))
				expect(ran).toBe(1)
			} finally {
				holds.job = null
			}
		})
	})
})

describe('an upload in flight at the switch', () => {
	test('counts in the drain, its pending row stays as the cleanup intent, and after an eviction the sweep removes its bytes', async () => {
		await keepingProcessEnvironment(async () => {
			const { object, database, bucket, pending, restart } = await start()
			// An upload that committed before the switch: its row references its file, whose object stays.
			expect((await upload(object, uploadForm('kept'))).status).toBe(200)
			const [committed] = storedFiles(database)
			expect(committed).toMatchObject({ status: 'live' })

			// Past the bytes the type is sniffed from, so the file is staged before the body stalls.
			const form = uploadForm('interrupted '.repeat(60))
			const held = heldBody(form, form.byteLength - 20)
			const uploading = upload(object, held.body)
			// The pending row committed on its own before the first byte; the bytes are still on their way.
			await until(() => storedFiles(database).length === 2)
			await held.waiting
			const restricting = transition(object, 1, 'read-only')
			expect(await settles(restricting)).toBe(false)
			held.release()
			refusedForMaintenance(await uploading)
			expect(await acked(await restricting)).toEqual({ generation: 1, mode: 'read-only', stillRunning: 0 })
			// The bytes reached R2 and the record of their size was fenced: the committed pending row is what knows them.
			const interrupted = bucket.written.find((key) => key !== committed?.object_key)
			expect(interrupted).toBeDefined()
			expect(storedFiles(database)).toEqual([
				{ status: 'live', object_key: committed?.object_key ?? '' },
				{ status: 'pending', object_key: interrupted ?? '' },
			])
			expect(bucket.deleted).toEqual([])

			// Evicted; the next instance opens, and the sweep runs past the grace, then past the retention window.
			const next = restart()
			await acked(await transition(next, 2, 'open'))
			database.query('update fabrika_files set created_at = ?').run(LONG_AGO)
			expect((await next.fetch(tick(SWEEP_TICK))).status).toBe(204)
			await Promise.all(pending.splice(0))
			expect(storedFiles(database)).toEqual([{ status: 'live', object_key: committed?.object_key ?? '' }])
			expect(queuedDeletions(database)).toEqual([interrupted ?? ''])
			database.query('update fabrika_file_deletions set recorded_at = ?').run(LONG_AGO)
			expect((await next.fetch(tick(SWEEP_TICK))).status).toBe(204)
			await Promise.all(pending.splice(0))
			expect(bucket.deleted).toEqual([interrupted ?? ''])
			expect(bucket.files.has(interrupted ?? '')).toBe(false)
			expect(bucket.files.has(committed?.object_key ?? '')).toBe(true)
		})
	})
})

describe('publishing to R2', () => {
	test('opening writes R2 first: while the put is in flight, and after it failed, the object stays restrictive', async () => {
		await keepingProcessEnvironment(async () => {
			const bucket = new Bucket()
			const { object } = await start({ bucket })
			await acked(await transition(object, 1, 'read-only'))
			let during = 0
			bucket.beforePut = async () => {
				bucket.beforePut = null
				during = (await call(object, 'create', { workspaceId: 'w1', title: 'during' })).status
			}
			bucket.failPuts = 1
			expect((await transition(object, 2, 'open')).status).toBe(503)
			expect(during).toBe(503)
			expect(await maintenance(object)).toEqual({ mode: 'read-only', generation: 1, published: true })
			expect((await call(object, 'create', { workspaceId: 'w1', title: 'refused' })).status).toBe(503)
			expect(await acked(await transition(object, 2, 'open'))).toEqual({ generation: 2, mode: 'open', stillRunning: 0 })
			expect(bucket.state()).toEqual({ generation: 2, mode: 'open' })
			expect((await call(object, 'create', { workspaceId: 'w1', title: 'opened' })).status).toBe(200)
		})
	})

	test('a restricting put that fails keeps the mode pending; the retry puts again and acknowledges only then', async () => {
		await keepingProcessEnvironment(async () => {
			const bucket = new Bucket()
			const { object } = await start({ bucket })
			bucket.failPuts = 1
			expect((await transition(object, 1, 'closed')).status).toBe(503)
			expect(await maintenance(object)).toEqual({ mode: 'closed', generation: 1, published: false })
			expect((await object.fetch(health())).status).toBe(503)
			expect(bucket.state()).toBeNull()
			expect(await acked(await transition(object, 1, 'closed'))).toEqual({ generation: 1, mode: 'closed', stillRunning: 0 })
			expect(await maintenance(object)).toEqual({ mode: 'closed', generation: 1, published: true })
			expect(bucket.state()).toEqual({ generation: 1, mode: 'closed' })
		})
	})

	test('a lost answer is retried under the same generation: the object drains again and answers, and puts nothing new', async () => {
		await keepingProcessEnvironment(async () => {
			const bucket = new Bucket()
			const { object } = await start({ bucket })
			await acked(await transition(object, 1, 'read-only'))
			expect(bucket.puts).toBe(1)
			expect(await acked(await transition(object, 1, 'read-only'))).toEqual({ generation: 1, mode: 'read-only', stillRunning: 0 })
			expect(bucket.puts).toBe(1)
		})
	})

	test('a failed put and an eviction: the next instance reads the older mode, and the retry is a full transition for it', async () => {
		await keepingProcessEnvironment(async () => {
			const bucket = new Bucket()
			const { object, restart } = await start({ bucket })
			await acked(await transition(object, 1, 'read-only'))
			bucket.failPuts = 1
			expect((await transition(object, 2, 'closed')).status).toBe(503)
			const next = restart()
			expect(await maintenance(next)).toEqual({ mode: 'read-only', generation: 1, published: true })
			expect(await acked(await transition(next, 2, 'closed'))).toEqual({ generation: 2, mode: 'closed', stillRunning: 0 })
			expect(bucket.state()).toEqual({ generation: 2, mode: 'closed' })
		})
	})

	test('a conflicting put adopts the higher generation R2 holds and refuses the request as stale', async () => {
		await keepingProcessEnvironment(async () => {
			const bucket = new Bucket()
			const { object } = await start({ bucket })
			expect(await maintenance(object)).toEqual({ mode: 'open', generation: null, published: false })
			// A successor's instance published while this one held the version it read.
			bucket.set({ generation: 7, mode: 'closed' })
			const refused = await transition(object, 5, 'read-only')
			expect(refused.status).toBe(409)
			expect(await refused.json()).toEqual({ refused: 'stale_generation', published: { generation: 7, mode: 'closed' } })
			expect(await maintenance(object)).toEqual({ mode: 'closed', generation: 7, published: true })
			expect((await object.fetch(health())).status).toBe(503)
		})
	})

	test('a conflicting put never overwrites the same generation in another mode: it adopts it and refuses the request as stale', async () => {
		await keepingProcessEnvironment(async () => {
			const bucket = new Bucket()
			const { object } = await start({ bucket })
			await acked(await transition(object, 4, 'read-only'))
			// Another instance published generation 5 closed over the version this one last wrote.
			bucket.set({ generation: 5, mode: 'closed' })
			const refused = await transition(object, 5, 'open')
			expect(refused.status).toBe(409)
			expect(await refused.json()).toEqual({ refused: 'stale_generation', published: { generation: 5, mode: 'closed' } })
			expect(bucket.state()).toEqual({ generation: 5, mode: 'closed' })
			expect(bucket.puts).toBe(2)
			expect(await maintenance(object)).toEqual({ mode: 'closed', generation: 5, published: true })
			refusedForMaintenance(await call(object, 'titles', { workspaceId: 'w1' }))
		})
	})

	test('a conflicting put under a lower generation puts again against the version it read', async () => {
		await keepingProcessEnvironment(async () => {
			const bucket = new Bucket()
			const { object } = await start({ bucket })
			expect(await maintenance(object)).toEqual({ mode: 'open', generation: null, published: false })
			bucket.set({ generation: 3, mode: 'read-only' })
			expect(await acked(await transition(object, 5, 'closed'))).toEqual({ generation: 5, mode: 'closed', stillRunning: 0 })
			expect(bucket.state()).toEqual({ generation: 5, mode: 'closed' })
			expect(bucket.puts).toBe(2)
		})
	})

	test('a lower generation, or the same with another mode, is refused and leaves the state as it was', async () => {
		await keepingProcessEnvironment(async () => {
			const bucket = new Bucket()
			const { object } = await start({ bucket })
			await acked(await transition(object, 4, 'read-only'))
			for (const [generation, mode] of [[3, 'closed'], [4, 'closed'], [2, 'read-only']] as const) {
				const refused = await transition(object, generation, mode)
				expect(refused.status).toBe(409)
				expect(await refused.json()).toEqual({ refused: 'stale_generation', published: { generation: 4, mode: 'read-only' } })
			}
			expect(await maintenance(object)).toEqual({ mode: 'read-only', generation: 4, published: true })
			expect(bucket.puts).toBe(1)
		})
	})
})

describe('cold starts', () => {
	test('an unreadable R2 answers 503 to ordinary and ops requests, and the next request reads it again', async () => {
		await keepingProcessEnvironment(async () => {
			const bucket = new Bucket()
			const { object, loads } = await start({ bucket })
			bucket.failReads = 2
			const ordinary = await object.fetch(health())
			expect(ordinary.status).toBe(503)
			expect(ordinary.headers.get('Retry-After')).toBe('30')
			expect((await object.fetch(opsRequest('inspect', { object: 'application', content: false }))).status).toBe(503)
			expect(loads.count).toBe(0)
			expect((await object.fetch(health())).status).toBe(200)
			expect(await maintenance(object)).toEqual({ mode: 'open', generation: null, published: false })
		})
	})

	test('a stored state that does not parse is never read as open', async () => {
		await keepingProcessEnvironment(async () => {
			const bucket = new Bucket()
			bucket.objects.set(STATE_KEY, { body: '{"generation":1,"mode":"open","extra":true}', etag: 'v1' })
			const { object } = await start({ bucket })
			expect((await object.fetch(health())).status).toBe(503)
		})
	})

	test('a restricted cold start with a pending migration does not migrate or boot until the migrate request', async () => {
		await keepingProcessEnvironment(async () => {
			const bucket = new Bucket()
			bucket.set({ generation: 2, mode: 'read-only' })
			const { object, database } = await start({ bucket })
			const refused = await call(object, 'titles', { workspaceId: 'w1' })
			expect(refused.status).toBe(503)
			expect(refused.headers.get('Retry-After')).toBe('30')
			expect(hasTable(database, 'notes')).toBe(false)
			expect(hasTable(database, 'fabrika_migrations')).toBe(false)

			const stale = await object.fetch(opsRequest('migrate', { object: 'application', generation: 1 }))
			expect(stale.status).toBe(409)
			expect(await stale.json()).toEqual({ refused: 'stale_generation', published: { generation: 2, mode: 'read-only' } })
			expect(hasTable(database, 'notes')).toBe(false)

			const migrated = await object.fetch(opsRequest('migrate', { object: 'application', generation: 2 }))
			expect(migrated.status).toBe(200)
			const ack = parseOpsMigrateAck(await migrated.json())
			expect(ack?.generation).toBe(2)
			expect(ack?.migrations.map((migration) => `${migration.bundle}/${migration.name}`)).toContain('app/20261022120000_notes.sql')
			expect(hasTable(database, 'notes')).toBe(true)
			// Read-only: the booted application serves reads and refuses writes.
			expect((await call(object, 'titles', { workspaceId: 'w1' })).status).toBe(200)
			expect((await call(object, 'create', { workspaceId: 'w1', title: 'refused' })).status).toBe(503)
		})
	})

	test('a restricted cold start without a pending migration boots and serves reads', async () => {
		await keepingProcessEnvironment(async () => {
			const bucket = new Bucket()
			const database = new BunDatabase(':memory:')
			const first = await start({ bucket, database })
			expect((await call(first.object, 'create', { workspaceId: 'w1', title: 'kept' })).status).toBe(200)
			await acked(await transition(first.object, 1, 'read-only'))
			const next = first.restart()
			const read = await call(next, 'titles', { workspaceId: 'w1' })
			expect(read.status).toBe(200)
			expect(await read.json()).toEqual({ result: { titles: ['kept'] } })
		})
	})

	test('an inspect object refuses ordinary traffic and never loads the application', async () => {
		await keepingProcessEnvironment(async () => {
			const bucket = new Bucket()
			bucket.set({ generation: 1, mode: 'inspect' })
			const { object, loads } = await start({ bucket })
			expect((await object.fetch(health())).status).toBe(503)
			expect((await object.fetch(tick(Date.UTC(2026, 9, 25, 3, 0, 0)))).status).toBe(204)
			const migrate = await object.fetch(opsRequest('migrate', { object: 'application', generation: 1 }))
			expect(migrate.status).toBe(409)
			expect(loads.count).toBe(0)
			expect(await maintenance(object)).toEqual({ mode: 'inspect', generation: 1, published: true })
		})
	})

	test('an application that fails to boot still accepts a transition', async () => {
		await keepingProcessEnvironment(async () => {
			const { object } = await start({ load: () => Promise.reject(new Error('the module exploded while loading')) })
			await expect(object.fetch(health())).rejects.toThrow('the module exploded while loading')
			expect(await acked(await transition(object, 1, 'closed'))).toEqual({ generation: 1, mode: 'closed', stillRunning: 0 })
		})
	})
})

describe('the store the barrier publishes through', () => {
	test('one transition runs at a time: the next waits for the drain of the one before it', async () => {
		const puts: number[] = []
		const store: MaintenanceStore = {
			read: () => Promise.resolve(null),
			put: (state) => {
				puts.push(state.generation)
				return Promise.resolve(`v${state.generation}`)
			},
		}
		const barrier = await MaintenanceBarrier.load(store)
		const write = barrier.event().admit('write')
		if (write === null) throw new Error('an open object admits a write')
		const first = barrier.transition({ generation: 1, mode: 'read-only' })
		const second = barrier.transition({ generation: 2, mode: 'closed' })
		expect(await settles(first)).toBe(false)
		expect(puts).toEqual([1])
		write.release()
		expect(await first).toMatchObject({ kind: 'acknowledged', ack: { generation: 1 } })
		expect(await second).toMatchObject({ kind: 'acknowledged', ack: { generation: 2 } })
		expect(puts).toEqual([1, 2])
	})
})
