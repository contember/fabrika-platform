// Control's daily backup and its rehearsal (ADR-0070 §7, §8) against a fake environment that keeps each object's
// published state, produces a dump of a few parts and imports it into `rehearsal` the way the object does, with the
// real SQL lease and records on SQLite always and on Postgres when FABRIKA_TEST_POSTGRES_URL is set.

import type { AuthContext } from '@fabrika/auth'
import {
	OPS_DUMP_PART_SIZE,
	OPS_EMPTY_TABLE_HASH,
	type OpsDataRefusalReason,
	type OpsDumpCursor,
	type OpsDumpTable,
	type OpsExportRequest,
	type OpsImportRequest,
	type OpsInspectRequest,
	type OpsPublishedState,
	type OpsStateAck,
	type OpsStateRequest,
	opsTransitionRefused,
	type OpsUploadedPart,
	parseOpsDumpManifest,
	sha256Hex,
} from '@fabrika/auth-core'
import { type SqlDatabase, SqlDeployLocks, uuidv7 } from '@fabrika/platform'
import type { ControlProvider, ProviderApprovedAccess } from '@fabrika/provider-contract'
import { afterEach, describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { BACKUP_INTERVAL_S, BACKUP_RETENTION_S, BACKUP_RETRY_S, type BackupScheduleDeps, runBackupSchedule } from '../backups'
import {
	advanceDataOperation,
	BACKUP_FAILED_CODE,
	type DataOperationDeps,
	httpOpsTransport,
	type OpsAnswer,
	type OpsDataAnswer,
	type OpsExportAck,
	type OpsFencedAnswer,
	type OpsImportAck,
	type OpsInspection,
	type OpsTarget,
	type OpsTransport,
	recordedMaintenance,
	REHEARSAL_FAILED_CODE,
	startBackup,
} from '../data-operations'
import { type ControlRepositories, createControlRepositories } from '../db'
import { LEASE_TTL_MS, runLeaseKey } from '../lease'
import type { ControlRpcDeps } from '../services'
import { createHarness } from './helpers/harness'
import { authWithActions, authWithPermissions } from './helpers/iam'
import { ManualClock } from './helpers/lease'
import { createPostgres, hasPostgres, skipReason } from './helpers/postgres'
import { fakeControlProvider, providerEnvironment, TEST_PROVIDER_ID } from './helpers/provider'
import { rpcRequest, rpcResult } from './helpers/rpc'

if (!hasPostgres) console.warn(`backups.test.ts Postgres half ${skipReason}`)

const APP = 'crm'
const ENV = 'prod'
const TARGET: OpsTarget = { appId: APP, env: ENV }
const T0 = 1_800_000_000
const GATED = '0.9.0'

const digest = (text: string): string => sha256Hex(text)

type Sent =
	| { readonly op: 'inspect'; readonly env: string }
	| { readonly op: 'state'; readonly env: string; readonly object: string; readonly generation: number; readonly mode: string }
	| { readonly op: 'export'; readonly env: string; readonly step: string; readonly generation: number | null; readonly part?: number }
	| { readonly op: 'import'; readonly env: string; readonly step: string; readonly generation: number; readonly part?: number }

/** What the fake does with one request: answer it, apply it and lose the answer, never receive it, or refuse it. */
type Fault = 'down' | 'lose' | 'not_served' | { readonly refused: OpsDataRefusalReason; readonly table?: string }

/** An import target's KV marker: the backup it loads and the parts it holds. */
interface Marker {
	readonly dump: string
	readonly loaded: Set<number>
}

/**
 * Every environment's objects as Control sees them: a published state per object judged by the wire's own rule, a
 * database that dumps into `parts` parts, and a `rehearsal` target that imports like the object's importer. Its answers
 * are the wire's shapes, so Control's records of them parse again.
 */
class FakeEnvironments implements OpsTransport {
	readonly published = new Map<string, OpsPublishedState>()
	readonly sent: Sent[] = []
	fault: (sent: Sent) => Fault | undefined | Promise<Fault | undefined> = () => undefined
	parts = 3
	/** The parts whose rows have a deferred foreign key, which the link pass sets. */
	deferred = new Set([2])
	/** Export `begin`s answered: each starts another upload. */
	begins = 0
	upload: string | null = null
	rehearsal: { marker: Marker | null; tables: boolean } = { marker: null, tables: false }

	inspect(target: OpsTarget, request: OpsInspectRequest): Promise<OpsAnswer<OpsInspection>> {
		this.sent.push({ op: 'inspect', env: target.env })
		const published = this.published.get(key(target, request.object))
		return Promise.resolve({
			kind: 'ok',
			value: {
				content: false,
				view: {
					release: GATED,
					maintenance: published === undefined ? { mode: 'open', generation: null, published: false } : { ...published, published: true },
					database: { sizeBytes: 4096, tables: [] },
					migrations: [],
					scheduler: { alarm: null },
					jobs: [],
					files: [],
					webhooks: [],
					bootFailure: null,
				},
			},
		})
	}

	async state(target: OpsTarget, request: OpsStateRequest): Promise<OpsFencedAnswer<OpsStateAck>> {
		const sent: Sent = { op: 'state', env: target.env, object: request.object, generation: request.generation, mode: request.mode }
		this.sent.push(sent)
		const fault = await this.fault(sent)
		if (fault === 'down') return { kind: 'unavailable', reason: 'unreachable' }
		if (fault === 'not_served') return { kind: 'unavailable', reason: 'not_served' }
		const current = this.published.get(key(target, request.object)) ?? null
		if (opsTransitionRefused(current, request)) return { kind: 'stale', published: current }
		this.published.set(key(target, request.object), { generation: request.generation, mode: request.mode })
		if (fault === 'lose') return { kind: 'unavailable', reason: 'unreachable' }
		return { kind: 'ok', value: { generation: request.generation, mode: request.mode, stillRunning: 0 } }
	}

	migrate(): Promise<OpsFencedAnswer<never>> {
		return Promise.resolve({ kind: 'unavailable', reason: 'invalid_answer' })
	}

	async export(target: OpsTarget, request: OpsExportRequest): Promise<OpsDataAnswer<OpsExportAck>> {
		const sent: Sent = {
			op: 'export',
			env: target.env,
			step: request.step,
			generation: request.generation,
			...(request.step === 'part' ? { part: request.part } : {}),
		}
		this.sent.push(sent)
		const fault = await this.fault(sent)
		if (fault === 'down') return { kind: 'unavailable', reason: 'unreachable' }
		if (fault === 'not_served') return { kind: 'unavailable', reason: 'not_served' }
		if (typeof fault === 'object') return { kind: 'refused', refusal: { refused: fault.refused, table: fault.table ?? null } }
		const published = this.published.get(key(target, request.object)) ?? null
		if (published === null || published.generation !== request.generation) return { kind: 'stale', published }
		if (published.mode === 'open') return { kind: 'refused', refusal: { refused: 'wrong_mode', table: null } }
		const answer = this.exportAnswer(request)
		return fault === 'lose' ? { kind: 'unavailable', reason: 'unreachable' } : answer
	}

	private exportAnswer(request: OpsExportRequest): OpsDataAnswer<OpsExportAck> {
		switch (request.step) {
			case 'begin':
				this.begins++
				this.upload = `upload-${this.begins}`
				return { kind: 'ok', value: { step: 'begin', uploadId: this.upload, bookmark: 'bookmark-0001' } }
			case 'part': {
				if (request.uploadId !== this.upload) return { kind: 'unavailable', reason: 'unreachable' }
				expect(request.cursor).toEqual(request.part === 1 ? null : cursorAt(request.part))
				const next = request.part < this.parts ? cursorAt(request.part + 1) : null
				return { kind: 'ok', value: { step: 'part', uploaded: uploadedPart(request.part, this.parts), tables: [table(request.part)], next } }
			}
			case 'complete': {
				if (request.uploadId !== this.upload) return { kind: 'unavailable', reason: 'unreachable' }
				const parts = Array.from({ length: this.parts }, (_, index) => uploadedPart(index + 1, this.parts))
				expect(request.parts).toEqual(parts)
				expect(request.tables).toEqual(parts.map((part) => table(part.part)))
				const manifest = parseOpsDumpManifest({
					format: 1,
					dump: request.dump,
					object: request.object,
					consistent: request.consistent,
					createdAt: '2027-01-15T08:00:00.000Z',
					bookmark: request.bookmark,
					release: GATED,
					contractDigest: `sha256:${digest('contract')}`,
					ddl: request.tables.map((dumped) => ({ type: 'table', name: dumped.name, table: dumped.name, sql: `CREATE TABLE ${dumped.name} (id)` })),
					migrations: [],
					tables: request.tables,
					parts: request.parts.map(({ part, size, sha256 }) => ({ part, size, sha256 })),
				})
				if (manifest === null) throw new Error('the fake wrote a manifest the wire refuses')
				return { kind: 'ok', value: { step: 'complete', manifest } }
			}
		}
	}

	async import(target: OpsTarget, request: OpsImportRequest): Promise<OpsDataAnswer<OpsImportAck>> {
		const sent: Sent = {
			op: 'import',
			env: target.env,
			step: request.step,
			generation: request.generation,
			...(request.step === 'part' || request.step === 'link' ? { part: request.part } : {}),
		}
		this.sent.push(sent)
		const fault = await this.fault(sent)
		if (fault === 'down') return { kind: 'unavailable', reason: 'unreachable' }
		if (typeof fault === 'object') return { kind: 'refused', refusal: { refused: fault.refused, table: fault.table ?? null } }
		const published = this.published.get(key(target, request.object)) ?? null
		if (published === null || published.generation !== request.generation) return { kind: 'stale', published }
		if (published.mode !== 'inspect') return refusal('wrong_mode')
		const answer = this.importAnswer(request)
		return fault === 'lose' ? { kind: 'unavailable', reason: 'unreachable' } : answer
	}

	private importAnswer(request: OpsImportRequest): OpsDataAnswer<OpsImportAck> {
		const target = this.rehearsal
		if (request.step === 'discard') {
			if (target.marker === null) return refusal('no_import')
			this.rehearsal = { marker: null, tables: false }
			return { kind: 'ok', value: { step: 'discard' } }
		}
		if (request.step === 'begin') {
			if ((target.marker !== null && target.marker.dump !== request.source.dump) || (target.marker === null && target.tables)) {
				return refusal('not_fresh')
			}
			this.rehearsal = { marker: target.marker ?? { dump: request.source.dump, loaded: new Set() }, tables: true }
			return { kind: 'ok', value: { step: 'begin', parts: this.parts } }
		}
		const marker = target.marker
		if (marker === null || marker.dump !== request.source.dump) return refusal('no_import')
		switch (request.step) {
			case 'part':
				marker.loaded.add(request.part)
				return { kind: 'ok', value: { step: 'part', part: request.part, rows: 3, deferred: this.deferred.has(request.part) ? 2 : 0 } }
			case 'link':
				if (marker.loaded.size !== this.parts) return refusal('part_mismatch')
				return { kind: 'ok', value: { step: 'link', part: request.part, rows: 2 } }
			case 'verify': {
				// Two steps: every table but the last, then the last.
				if (request.cursor === null && this.parts > 1) {
					const verified = Array.from({ length: this.parts - 1 }, (_, index) => table(index + 1))
					return { kind: 'ok', value: { step: 'verify', tables: verified, next: { ...cursorAt(this.parts), after: '7', rows: 1, hash: digest('x') } } }
				}
				return { kind: 'ok', value: { step: 'verify', tables: [table(this.parts)], next: null } }
			}
			case 'complete':
				throw new Error('a rehearsal never completes the import: complete clears the marker discard needs')
		}
	}

	requests(env = ENV): string[] {
		return this.sent.flatMap((sent) => {
			if (sent.env !== env) return []
			if (sent.op === 'inspect') return ['inspect']
			if (sent.op === 'state') return [`state ${sent.object} ${sent.mode} @${sent.generation}`]
			const part = sent.part === undefined ? '' : ` ${sent.part}`
			return [`${sent.op} ${sent.step}${part} @${sent.generation}`]
		})
	}
}

function key(target: OpsTarget, object: string): string {
	return `${target.appId}/${target.env}/${object}`
}

function refusal(refused: OpsDataRefusalReason): OpsDataAnswer<never> {
	return { kind: 'refused', refusal: { refused, table: null } }
}

function table(part: number): OpsDumpTable {
	return { name: `t${part}`, rows: 3, hash: digest(`t${part}`) }
}

function cursorAt(part: number): OpsDumpCursor {
	return { table: `t${part}`, after: null, rows: 0, hash: OPS_EMPTY_TABLE_HASH }
}

function uploadedPart(part: number, parts: number): OpsUploadedPart {
	return { part, size: part < parts ? OPS_DUMP_PART_SIZE : 4096, sha256: digest(`part ${part}`), etag: `etag-${part}` }
}

/** Every request a whole backup of three parts sends, from generation `g`: the dump, the reopening, the rehearsal. */
function wholeBackup(g: number): string[] {
	return [
		'inspect',
		`state application read-only @${g}`,
		`export begin @${g}`,
		`export part 1 @${g}`,
		`export part 2 @${g}`,
		`export part 3 @${g}`,
		`export complete @${g}`,
		`state application open @${g + 1}`,
		`state rehearsal inspect @${g + 2}`,
		`import begin @${g + 2}`,
		`import part 1 @${g + 2}`,
		`import part 2 @${g + 2}`,
		`import part 3 @${g + 2}`,
		`import link 2 @${g + 2}`,
		`import verify @${g + 2}`,
		`import verify @${g + 2}`,
		`import discard @${g + 2}`,
	]
}

/** The provider gate: only an application at the gated release is served the channel. */
const gatedProvider: Pick<ControlProvider, 'id' | 'opsChannel'> = {
	id: TEST_PROVIDER_ID,
	opsChannel: (access: ProviderApprovedAccess) => access.checker === GATED,
}

interface Backend {
	repositories: ControlRepositories
	db: SqlDatabase
	close(): Promise<void>
}

const backends: { name: string; skip: boolean; open(now: () => number): Promise<Backend> }[] = [
	{
		name: 'sqlite',
		skip: false,
		open: (now) => {
			const harness = createHarness(now)
			return Promise.resolve({
				repositories: harness.repositories,
				db: harness.d1,
				close: () => {
					harness.sqlite.close()
					return Promise.resolve()
				},
			})
		},
	},
	{
		name: 'postgres',
		skip: !hasPostgres,
		open: async (now) => {
			const fixture = await createPostgres('backups')
			return { repositories: createControlRepositories(fixture.db, { now }), db: fixture.db, close: () => fixture.close() }
		},
	},
]

for (const backend of backends) {
	describe.skipIf(backend.skip)(`backups (${backend.name})`, () => {
		let opened: Backend | null = null
		let seconds = T0

		afterEach(async () => {
			await opened?.close()
			opened = null
			seconds = T0
		})

		/** An environment with a domain, published at `checker`, or unpublished with `null`. */
		async function environment(b: Backend, env: string, options: { domain?: string | null; checker?: string | null } = {}): Promise<void> {
			await b.repositories.registry.upsertAppEnv(
				providerEnvironment(APP, env, { domain: options.domain === undefined ? `${env}.crm.example.com` : options.domain }),
			)
			const checker = options.checker === undefined ? GATED : options.checker
			if (checker === null) return
			const snapshot = JSON.stringify({ version: 1, contract: notesArtifact, migrations: [], checker })
			await b.db.prepare('UPDATE app_envs SET published_run_id = ?, published_snapshot_json = ? WHERE app_id = ? AND env = ?').bind(
				uuidv7(),
				snapshot,
				APP,
				env,
			).run()
		}

		async function open() {
			const b = await backend.open(() => seconds)
			opened = b
			await b.repositories.registry.createApp({ id: APP, repoUrl: 'github.com/acme/crm' })
			await environment(b, ENV)
			const fake = new FakeEnvironments()
			const deps = (options: { clock?: ManualClock; passSpent?: () => boolean } = {}): DataOperationDeps => ({
				repositories: b.repositories,
				lock: new SqlDeployLocks(b.db, options.clock === undefined ? {} : { now: options.clock.now }),
				...(options.clock === undefined ? {} : { leaseClock: options.clock }),
				ops: fake,
				...(options.passSpent === undefined ? {} : { passSpent: options.passSpent }),
			})
			const schedule = (options: { passSpent?: () => boolean; provider?: Pick<ControlProvider, 'id' | 'opsChannel'> } = {}): BackupScheduleDeps => ({
				...deps(options.passSpent === undefined ? {} : { passSpent: options.passSpent }),
				repositories: b.repositories,
				provider: options.provider ?? gatedProvider,
				now: () => seconds,
			})
			return { b, fake, deps, schedule }
		}

		/** A plain array: Postgres answers its own array type, which `toMatchObject` does not match against a plain one. */
		async function backupsOf(b: Backend, env = ENV) {
			return [...(await b.repositories.backups.listForEnvironment(APP, env, { limit: 10 }))]
		}

		test('a backup restricts, dumps at that generation, reopens at a new one and rehearses at a third', async () => {
			const { b, fake, deps } = await open()
			const outcome = await startBackup(deps(), { ...TARGET, actor: 'user:test' })
			expect(outcome).toMatchObject({
				kind: 'driven',
				result: 'succeeded',
				operation: { kind: 'backup', state: 'succeeded', step: 'verify', target_mode: 'open' },
			})
			expect(fake.requests()).toEqual(wholeBackup(1))
			expect(fake.published.get(key(TARGET, 'application'))).toEqual({ generation: 2, mode: 'open' })
			expect(fake.rehearsal).toEqual({ marker: null, tables: false })
			const [backup] = await backupsOf(b)
			expect(backup).toMatchObject({
				operation_id: outcome.kind === 'driven' ? outcome.operation.id : null,
				object: 'application',
				state: 'succeeded',
				error_code: null,
				created_at: T0,
				finished_at: T0,
				bookmark: 'bookmark-0001',
				size_bytes: 2 * OPS_DUMP_PART_SIZE + 4096,
				parts: 3,
				tables: 3,
				rehearsal: 'passed',
				rehearsal_code: null,
			})
			expect(await recordedMaintenance(b, TARGET)).toBe('open')
		})

		test('a lost answer repeats the same step, and the part is recorded once', async () => {
			const { b, fake, deps } = await open()
			let lost = false
			fake.fault = (sent) => {
				if (sent.op !== 'export' || sent.part !== 2 || lost) return undefined
				lost = true
				return 'lose'
			}
			expect(await startBackup(deps(), { ...TARGET, actor: 'user:test' })).toMatchObject({ result: 'succeeded' })
			expect(fake.requests().filter((request) => request === 'export part 2 @1')).toHaveLength(2)
			const [backup] = await backupsOf(b)
			expect((await b.repositories.backups.parts(backup?.id ?? '')).map((part) => part.part)).toEqual([1, 2, 3])
		})

		test('a failed export reopens the object and fails the operation, and the environment stays deployable', async () => {
			const { b, fake, deps } = await open()
			fake.fault = (sent) => sent.op === 'export' && sent.part === 2 ? { refused: 'row_too_large', table: 't2' } : undefined
			const outcome = await startBackup(deps(), { ...TARGET, actor: 'user:test' })
			expect(outcome).toMatchObject({ result: 'failed', operation: { state: 'failed', error_code: BACKUP_FAILED_CODE, step: 'open' } })
			expect(fake.requests()).toEqual([
				'inspect',
				'state application read-only @1',
				'export begin @1',
				'export part 1 @1',
				'export part 2 @1',
				'state application open @2',
			])
			expect(fake.published.get(key(TARGET, 'application'))).toEqual({ generation: 2, mode: 'open' })
			expect(await backupsOf(b)).toMatchObject([{ state: 'failed', error_code: 'row_too_large', parts: null, rehearsal: 'pending' }])
			expect(await recordedMaintenance(b, TARGET)).toBe('open')
		})

		test('a failed rehearsal records the backup failed; the object is already open', async () => {
			const { b, fake, deps } = await open()
			fake.fault = (sent) => sent.op === 'import' && sent.step === 'verify' ? { refused: 'verify_mismatch', table: 't1' } : undefined
			const outcome = await startBackup(deps(), { ...TARGET, actor: 'user:test' })
			expect(outcome).toMatchObject({ result: 'failed', operation: { state: 'failed', error_code: REHEARSAL_FAILED_CODE, step: 'verify' } })
			expect(fake.requests().at(-1)).toBe('import verify @3')
			expect(fake.published.get(key(TARGET, 'application'))).toEqual({ generation: 2, mode: 'open' })
			expect(await backupsOf(b)).toMatchObject([{
				state: 'failed',
				error_code: 'rehearsal_failed',
				parts: 3,
				rehearsal: 'failed',
				rehearsal_code: 'verify_mismatch',
			}])
			expect(await recordedMaintenance(b, TARGET)).toBe('open')
		})

		test('a rehearsal that finds rehearsal not fresh discards it first, then imports', async () => {
			const { b, fake, deps } = await open()
			// An earlier rehearsal died after its begin.
			fake.rehearsal = { marker: { dump: uuidv7(), loaded: new Set([1]) }, tables: true }
			expect(await startBackup(deps(), { ...TARGET, actor: 'user:test' })).toMatchObject({ result: 'succeeded' })
			const rehearsal = fake.requests().filter((request) => request.startsWith('import'))
			expect(rehearsal.slice(0, 4)).toEqual(['import begin @3', 'import discard @3', 'import begin @3', 'import part 1 @3'])
			expect(await backupsOf(b)).toMatchObject([{ state: 'succeeded', rehearsal: 'passed' }])
		})

		test('the 501 of an older release fails the operation not_served at once, and the environment stays open', async () => {
			const { b, fake, deps } = await open()
			fake.fault = (sent) => sent.op === 'state' ? 'not_served' : undefined
			expect(await startBackup(deps(), { ...TARGET, actor: 'user:test' })).toMatchObject({
				result: 'failed',
				operation: { state: 'failed', error_code: 'not_served' },
			})
			expect(fake.requests()).toEqual(['inspect', 'state application read-only @1'])
			expect(await backupsOf(b)).toMatchObject([{ state: 'failed', error_code: 'not_served' }])
			expect(await recordedMaintenance(b, TARGET)).toBe('open')

			// A release that serves the transition but not the dump: the object reopens, and nothing is retried.
			fake.fault = (sent) => sent.op === 'export' ? 'not_served' : undefined
			fake.sent.length = 0
			expect(await startBackup(deps(), { ...TARGET, actor: 'user:test' })).toMatchObject({
				result: 'failed',
				operation: { state: 'failed', error_code: 'not_served' },
			})
			expect(fake.requests()).toEqual(['inspect', 'state application read-only @2', 'export begin @2', 'state application open @3'])
			expect(await recordedMaintenance(b, TARGET)).toBe('open')
		})

		test('a pass out of time leaves the backup running; the next pass carries on without a second dump', async () => {
			const { b, fake, schedule } = await open()
			let budget = 4
			const passSpent = () => budget-- <= 0
			const first = await runBackupSchedule(schedule({ passSpent }))
			expect(first).toMatchObject({ continued: 0, started: 1, unfinished: 1 })
			const [operation] = await b.repositories.dataOperations.listForEnvironment(APP, ENV, { limit: 1 })
			expect(operation).toMatchObject({ kind: 'backup', state: 'running', step: 'backup', target_mode: 'read-only', generation: 1 })
			expect(await recordedMaintenance(b, TARGET)).toBe('unsettled')

			// The next pass fences above every reserved generation in read-only, then sends only what the record lacks.
			fake.sent.length = 0
			budget = 6
			const second = await runBackupSchedule(schedule({ passSpent }))
			expect(second).toMatchObject({ continued: 1, started: 0, unfinished: 1 })
			expect(fake.requests()).toEqual([
				'state application read-only @2',
				'export part 3 @2',
				'export complete @2',
				'state application open @3',
				'state rehearsal inspect @4',
				'import begin @4',
				'import part 1 @4',
				'import part 2 @4',
			])

			fake.sent.length = 0
			const third = await runBackupSchedule(schedule({ passSpent: () => false }))
			expect(third).toMatchObject({ continued: 1, started: 0, succeeded: 1 })
			expect(fake.requests()).toEqual([
				'state application open @5',
				'state rehearsal inspect @5',
				'import part 3 @5',
				'import link 2 @5',
				'import verify @5',
				'import verify @5',
				'import discard @5',
			])
			expect(fake.begins).toBe(1)
			expect(await backupsOf(b)).toMatchObject([{ state: 'succeeded', parts: 3, rehearsal: 'passed' }])
			expect(await recordedMaintenance(b, TARGET)).toBe('open')
		})

		test("a lost lease mid-dump stops the holder; its successor resumes the dump and refuses the former holder's late request", async () => {
			const { b, fake, deps } = await open()
			const clock = new ManualClock()
			fake.fault = async (sent) => {
				// The holder stalls in part 2 past its lease.
				if (sent.op === 'export' && sent.part === 2 && fake.begins === 1 && sent.generation === 1) await clock.advance(LEASE_TTL_MS + 1)
				return undefined
			}
			const stalled = await startBackup(deps({ clock }), { ...TARGET, actor: 'user:test' })
			expect(stalled).toMatchObject({ result: 'lease_lost', operation: { state: 'running', step: 'backup' } })
			const [backup] = await backupsOf(b)
			expect((await b.repositories.backups.parts(backup?.id ?? '')).map((part) => part.part)).toEqual([1])

			fake.sent.length = 0
			const resumed = await advanceDataOperation(deps({ clock }), stalled.kind === 'driven' ? stalled.operation.id : '')
			expect(resumed).toMatchObject({ result: 'succeeded', operation: { state: 'succeeded' } })
			expect(fake.requests().slice(0, 4)).toEqual(['state application read-only @2', 'export part 2 @2', 'export part 3 @2', 'export complete @2'])
			expect(fake.begins).toBe(1)
			const late = await fake.export(TARGET, {
				step: 'part',
				object: 'application',
				generation: 1,
				consistent: true,
				dump: backup?.id ?? '',
				uploadId: 'upload-1',
				part: 2,
				cursor: cursorAt(2),
			})
			expect(late).toEqual({ kind: 'stale', published: { generation: 3, mode: 'open' } })
			expect(await backupsOf(b)).toMatchObject([{ state: 'succeeded' }])
			expect((await b.repositories.backups.parts(backup?.id ?? '')).map((part) => part.part)).toEqual([1, 2, 3])
		})

		test('one backup a day per due environment; none opted out, none without the channel', async () => {
			const { b, fake, schedule } = await open()
			await environment(b, 'stage')
			await environment(b, 'nodomain', { domain: null })
			await environment(b, 'older', { checker: '0.8.0' })
			await environment(b, 'unpublished', { checker: null })
			await b.repositories.backups.setSchedule(APP, 'stage', false, 'user:ops')

			expect(await runBackupSchedule(schedule())).toMatchObject({ started: 1, succeeded: 1 })
			for (const env of ['stage', 'nodomain', 'older', 'unpublished']) {
				expect(await backupsOf(b, env)).toEqual([])
				expect(fake.requests(env)).toEqual([])
			}
			expect(await backupsOf(b)).toHaveLength(1)

			seconds = T0 + BACKUP_INTERVAL_S - 1
			expect(await runBackupSchedule(schedule())).toMatchObject({ started: 0 })
			seconds = T0 + BACKUP_INTERVAL_S + 1
			expect(await runBackupSchedule(schedule())).toMatchObject({ started: 1, succeeded: 1 })
			expect(await backupsOf(b)).toHaveLength(2)

			// Opting back in makes stage due at once.
			await b.repositories.backups.setSchedule(APP, 'stage', true, 'user:ops')
			expect(await runBackupSchedule(schedule())).toMatchObject({ started: 1, succeeded: 1 })
			expect(await backupsOf(b, 'stage')).toHaveLength(1)
		})

		test('a failed backup is tried again only after the retry interval, and a busy environment is skipped', async () => {
			const { b, fake, schedule } = await open()
			fake.fault = (sent) => sent.op === 'export' && sent.step === 'begin' ? { refused: 'unsupported_schema', table: 't1' } : undefined
			expect(await runBackupSchedule(schedule())).toMatchObject({ started: 1, failed: 1 })
			seconds = T0 + BACKUP_RETRY_S - 1
			expect(await runBackupSchedule(schedule())).toMatchObject({ started: 0 })
			fake.fault = () => undefined
			seconds = T0 + BACKUP_RETRY_S
			expect(await runBackupSchedule(schedule())).toMatchObject({ started: 1, succeeded: 1 })

			// A deploy holds stage's lease: the schedule sends it nothing and tries again next pass.
			const lease = await new SqlDeployLocks(b.db).acquire(runLeaseKey(APP, 'stage'), 'operator', LEASE_TTL_MS)
			expect(lease).toBe(true)
			await environment(b, 'stage')
			fake.sent.length = 0
			expect(await runBackupSchedule(schedule())).toMatchObject({ started: 1, skipped: 1 })
			expect(fake.requests('stage')).toEqual([])
		})

		test('a provider that serves no ops channel backs nothing up', async () => {
			const { b, fake, schedule } = await open()
			expect(await runBackupSchedule(schedule({ provider: { id: TEST_PROVIDER_ID } }))).toEqual({
				continued: 0,
				started: 0,
				succeeded: 0,
				failed: 0,
				unfinished: 0,
				skipped: 0,
				errored: 0,
			})
			expect(fake.sent).toEqual([])
			expect(await backupsOf(b)).toEqual([])
		})

		test('a backup never starts on an environment its record leaves restricted', async () => {
			const { b, fake, deps } = await open()
			const generation = await b.repositories.dataOperations.allocateGeneration(APP, ENV)
			const locks = new SqlDeployLocks(b.db)
			expect(await locks.acquire(runLeaseKey(APP, ENV), 'operator', LEASE_TTL_MS)).toBe(true)
			const fields = { id: uuidv7(), appId: APP, env: ENV, step: 'restrict', targetMode: 'closed', generation, actor: 'user:ops' } as const
			const created = await b.repositories.dataOperations.create({ ...fields, kind: 'maintenance' }, { holder: 'operator', nowMs: Date.now() })
			expect(await b.repositories.dataOperations.finish(created?.id ?? '', { holder: 'operator', nowMs: Date.now() })).toBe(true)
			await locks.release(runLeaseKey(APP, ENV), 'operator')
			expect(await startBackup(deps(), { ...TARGET, actor: 'user:test' })).toEqual({ kind: 'refused', reason: 'not_open' })
			expect(fake.sent).toEqual([])
		})

		test('backup writes hold the environment lease', async () => {
			const { b, deps } = await open()
			expect(await startBackup(deps(), { ...TARGET, actor: 'user:test' })).toMatchObject({ result: 'succeeded' })
			const [backup] = await backupsOf(b)
			if (backup === undefined) throw new Error('no backup')
			const stranger = { holder: uuidv7(), nowMs: Date.now() }
			const input = { id: uuidv7(), appId: APP, env: ENV, operationId: backup.operation_id, object: 'application' }
			expect(await b.repositories.backups.create(input, stranger)).toBeNull()
			expect(await b.repositories.backups.fail(backup.id, 'invalid_answer', stranger)).toBe(false)
			expect(await b.repositories.backups.addPart(backup.id, 4, '{}', stranger)).toBe(false)
			expect(await backupsOf(b)).toEqual([backup])
			await expect(b.repositories.backups.fail(backup.id, 'Error: tenant 7', stranger)).rejects.toThrow('backup code')
		})
	})
}

describe('the HTTP ops transport for dumps', () => {
	async function transport(answer: () => Response) {
		const repositories = createHarness().repositories
		await repositories.registry.createApp({ id: APP, repoUrl: 'github.com/acme/crm' })
		await repositories.registry.upsertAppEnv(providerEnvironment(APP, ENV, { domain: 'crm.example.com' }))
		const urls: string[] = []
		const ops = httpOpsTransport({
			registry: repositories.registry,
			opsKeysFor: () => Promise.resolve(['ops-key']),
			fetch: (url) => {
				urls.push(url)
				return Promise.resolve(answer())
			},
		})
		return { ops, urls }
	}

	const signal = new AbortController().signal
	const dump = uuidv7()
	const begin = { step: 'begin', object: 'application', generation: 4, consistent: true, dump } as const
	const part = { step: 'part', object: 'application', generation: 4, consistent: true, dump, uploadId: 'u-1', part: 1, cursor: null } as const
	const verify = { step: 'verify', object: 'rehearsal', generation: 5, source: { object: 'application', dump }, cursor: null } as const

	test('each step is parsed by its own parser', async () => {
		const begun = await transport(() => Response.json({ step: 'begin', uploadId: 'u-1', bookmark: 'b-1' }))
		expect(await begun.ops.export(TARGET, begin, signal)).toEqual({ kind: 'ok', value: { step: 'begin', uploadId: 'u-1', bookmark: 'b-1' } })
		expect(begun.urls).toEqual(['https://crm.example.com/__fabrika/ops/export'])
		// A begin answer to a part request, and a part that is not the fixed size although the dump continues, do not parse.
		expect(await begun.ops.export(TARGET, part, signal)).toEqual({ kind: 'unavailable', reason: 'invalid_answer' })
		const short = await transport(() =>
			Response.json({
				step: 'part',
				uploaded: { part: 1, size: 10, sha256: digest('p'), etag: 'e' },
				tables: [],
				next: cursorAt(1),
			})
		)
		expect(await short.ops.export(TARGET, part, signal)).toEqual({ kind: 'unavailable', reason: 'invalid_answer' })
		const verified = await transport(() => Response.json({ step: 'verify', tables: [table(1)], next: null }))
		expect(await verified.ops.import(TARGET, verify, signal)).toEqual({ kind: 'ok', value: { step: 'verify', tables: [table(1)], next: null } })
		expect(verified.urls).toEqual(['https://crm.example.com/__fabrika/ops/import'])
	})

	test('a 422 is the parsed data refusal, a 409 the stale refusal and a 501 not_served; a transition answers no 422', async () => {
		const refused = await transport(() => Response.json({ refused: 'unsupported_schema', table: 'notes' }, { status: 422 }))
		expect(await refused.ops.export(TARGET, begin, signal)).toEqual({ kind: 'refused', refusal: { refused: 'unsupported_schema', table: 'notes' } })
		expect(await refused.ops.state(TARGET, { object: 'application', generation: 4, mode: 'read-only' }, signal)).toEqual({
			kind: 'unavailable',
			reason: 'invalid_answer',
		})
		const unknown = await transport(() => Response.json({ refused: 'tenant 7 broke', table: null }, { status: 422 }))
		expect(await unknown.ops.import(TARGET, verify, signal)).toEqual({ kind: 'unavailable', reason: 'invalid_answer' })
		const stale = await transport(() => Response.json({ refused: 'stale_generation', published: { generation: 6, mode: 'closed' } }, { status: 409 }))
		expect(await stale.ops.import(TARGET, verify, signal)).toEqual({ kind: 'stale', published: { generation: 6, mode: 'closed' } })
		const older = await transport(() => Response.json({ refused: 'not_implemented' }, { status: 501 }))
		expect(await older.ops.export(TARGET, begin, signal)).toEqual({ kind: 'unavailable', reason: 'not_served' })
	})
})

describe('data.backups RPC', () => {
	function fixture() {
		const harness = createHarness()
		const repositories = harness.repositories
		const fake = new FakeEnvironments()
		const lock = new SqlDeployLocks(harness.d1)
		const call = async (auth: AuthContext, method: string, input: unknown): Promise<{ status: number; body: unknown }> => {
			const deps: ControlRpcDeps & { opsTransport: OpsTransport } = {
				repositories,
				auth,
				queue: { send: () => Promise.resolve() },
				logs: { get: () => Promise.resolve(null) },
				provider: fakeControlProvider,
				lock,
				cancelRun: () => Promise.resolve(),
				opsTransport: fake,
			}
			const response = await rpcResult(rpcRequest(method, input), deps)
			return { status: response.status, body: await response.json() }
		}
		const seed = async (): Promise<void> => {
			await repositories.registry.createApp({ id: APP, repoUrl: 'github.com/acme/crm' })
			await repositories.registry.upsertAppEnv(providerEnvironment(APP, ENV, { domain: 'crm.example.com' }))
		}
		return { fake, call, seed, repositories, harness, lock }
	}

	const appGrant = (action: string) => ({ action, scope: { type: 'app', value: APP } })

	test('data.read lists the backups newest first, a page at a time, and marks one past its retention expired', async () => {
		const f = fixture()
		await f.seed()
		const deps = { repositories: f.repositories, lock: f.lock, ops: f.fake }
		for (let i = 0; i < 3; i++) expect(await startBackup(deps, { ...TARGET, actor: 'user:test' })).toMatchObject({ result: 'succeeded' })
		const [newest, middle, oldest] = await f.repositories.backups.listForEnvironment(APP, ENV, { limit: 10 })
		const now = Math.floor(Date.now() / 1000)
		f.harness.sqlite.query('UPDATE app_env_backups SET created_at = ? WHERE id = ?').run(now - BACKUP_RETENTION_S - 1, oldest?.id ?? '')
		const reader = authWithPermissions([appGrant('data.read')])
		const first = await f.call(reader, 'data.backups.list', { ...TARGET, limit: 2 })
		expect(first).toMatchObject({ status: 200, body: { items: [{ id: newest?.id, expired: false }, { id: middle?.id }], nextCursor: middle?.id } })
		const second = await f.call(reader, 'data.backups.list', { ...TARGET, limit: 2, before: middle?.id })
		expect(second).toMatchObject({ status: 200, body: { items: [{ id: oldest?.id, expired: true }], nextCursor: null } })
		const [item] = typeof first.body === 'object' && first.body !== null ? Reflect.get(first.body, 'items') : []
		expect(item).toEqual({
			id: newest?.id,
			appId: APP,
			env: ENV,
			operationId: newest?.operation_id,
			object: 'application',
			state: 'succeeded',
			errorCode: null,
			createdAt: newest?.created_at,
			finishedAt: newest?.finished_at,
			bookmark: 'bookmark-0001',
			sizeBytes: 2 * OPS_DUMP_PART_SIZE + 4096,
			parts: 3,
			tables: 3,
			rehearsal: 'passed',
			rehearsalCode: null,
			expired: false,
		})
	})

	test('the daily schedule reads under data.read and is set under data.manage', async () => {
		const f = fixture()
		await f.seed()
		const reader = authWithPermissions([appGrant('data.read')])
		expect(await f.call(reader, 'data.backups.schedule', TARGET)).toEqual({ status: 200, body: { ...TARGET, daily: true, updatedAt: null } })
		expect((await f.call(reader, 'data.backups.setSchedule', { ...TARGET, daily: false })).status).toBe(404)
		const manager = authWithPermissions([appGrant('data.read'), appGrant('data.manage')])
		const set = await f.call(manager, 'data.backups.setSchedule', { ...TARGET, daily: false })
		expect(set).toMatchObject({ status: 200, body: { ...TARGET, daily: false } })
		expect(await f.call(reader, 'data.backups.schedule', TARGET)).toMatchObject({ status: 200, body: { daily: false } })
	})

	test('an environment the caller may not act on is the same 404 as one that does not exist', async () => {
		const f = fixture()
		await f.seed()
		const stranger = authWithPermissions([{ action: 'data.read', scope: { type: 'app', value: 'other' } }, {
			action: 'data.manage',
			scope: { type: 'app', value: 'other' },
		}])
		for (
			const [method, input] of [
				['data.backups.list', TARGET],
				['data.backups.schedule', TARGET],
				['data.backups.setSchedule', { ...TARGET, daily: false }],
			] as const
		) {
			const denied = await f.call(stranger, method, input)
			expect(denied.status).toBe(404)
			expect(await f.call(authWithActions(['data.read', 'data.manage']), method, { ...input, env: 'missing' })).toEqual(denied)
		}
		expect(await f.repositories.backups.getSchedule(APP, ENV)).toBeNull()
	})
})
