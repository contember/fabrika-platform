import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
	decodeOpsDumpLine,
	decodeOpsDumpRow,
	DEFAULT_APPLICATION_OBJECT,
	encodeOpsDumpLine,
	encodeOpsDumpRow,
	foldOpsTableHash,
	formatOpsKeyDigests,
	MAX_APPLICATION_OBJECTS,
	OPS_CONTENT_TYPE,
	OPS_DATA_REFUSALS,
	OPS_DATA_REFUSED_STATUS,
	OPS_DUMP_FORMAT,
	OPS_DUMP_KEY,
	OPS_DUMP_MANIFEST_MAX_BYTES,
	OPS_DUMP_MAX_PARTS,
	OPS_DUMP_PAGE_ROWS,
	OPS_DUMP_PART_MAX_RAW_BYTES,
	OPS_DUMP_PART_MAX_ROWS,
	OPS_DUMP_PART_SIZE,
	OPS_EMPTY_TABLE_HASH,
	OPS_METHOD,
	OPS_MODES,
	OPS_OPERATIONS,
	OPS_PREFIX,
	OPS_REFUSAL_STATUS,
	OPS_REHEARSAL_OBJECT,
	OPS_ROW_COUNT_CAP,
	OPS_ROW_ID,
	OPS_ROW_PATH,
	OPS_STALE_STATUS,
	OPS_STATE_KEY,
	OPS_TIMERS_CAP,
	type OpsBootFailureContent,
	type OpsContentView,
	type OpsDumpCursor,
	type OpsDumpManifest,
	type OpsDumpSource,
	type OpsDumpTable,
	type OpsDumpValue,
	type OpsExportBegin,
	type OpsExportBeginAck,
	type OpsExportComplete,
	type OpsExportCompleteAck,
	type OpsExportPart,
	type OpsExportPartAck,
	type OpsImportBegin,
	type OpsImportBeginAck,
	type OpsImportComplete,
	type OpsImportCompleteAck,
	type OpsImportDiscard,
	type OpsImportLink,
	type OpsImportLinkAck,
	type OpsImportPart,
	type OpsImportPartAck,
	type OpsImportVerify,
	type OpsImportVerifyAck,
	opsKeyDigest,
	type OpsMigration,
	opsPath,
	type OpsPublishedState,
	opsRefusal,
	type OpsRestoreArm,
	type OpsRestoreArmAck,
	type OpsRestorePrepare,
	type OpsRestorePrepareAck,
	type OpsRestoreVerify,
	type OpsStaleRefusal,
	type OpsStateAck,
	type OpsTimer,
	type OpsTimersView,
	opsTransitionRefused,
	type OpsUploadedPart,
	type OpsView,
	parseApplicationObjectName,
	parseApplicationObjects,
	parseOpsContentView,
	parseOpsDataRefusal,
	parseOpsDumpManifest,
	parseOpsExportBeginAck,
	parseOpsExportCompleteAck,
	parseOpsExportPartAck,
	parseOpsExportRequest,
	parseOpsImportBeginAck,
	parseOpsImportCompleteAck,
	parseOpsImportDiscardAck,
	parseOpsImportLinkAck,
	parseOpsImportPartAck,
	parseOpsImportRequest,
	parseOpsImportVerifyAck,
	parseOpsInspectRequest,
	parseOpsKeyDigests,
	parseOpsMigrateAck,
	parseOpsMigrateRequest,
	parseOpsOperation,
	parseOpsRestoreArmAck,
	parseOpsRestorePrepareAck,
	parseOpsRestoreRequest,
	parseOpsRestoreVerifyAck,
	parseOpsStaleRefusal,
	parseOpsStateAck,
	parseOpsStateRequest,
	parseOpsTimersRequest,
	parseOpsTimersView,
	parseOpsView,
	readOpsDumpManifest,
} from '../ops'

const AT = '2026-10-24T12:00:00.000Z'
const failure: OpsBootFailureContent = { at: AT, message: 'boot failed', stack: 'Error: boot failed\n    at boot' }
const migration: OpsMigration = { bundle: 'framework', name: '0001_framework.sql', checksum: 'a'.repeat(64), appliedAt: AT }
const view: OpsView = {
	release: '0.9.0',
	maintenance: { mode: 'read-only', generation: 7, published: true },
	database: { sizeBytes: 4096, tables: [{ name: 'notes', rows: 12 }, { name: 'events', rows: OPS_ROW_COUNT_CAP }] },
	migrations: [migration],
	scheduler: { alarm: AT },
	jobs: [{ job: 'nightlyDigest', lastStatus: 'failed', lastStartedAt: AT, lastFinishedAt: AT, lastDurationMs: 120 }],
	files: [{ kind: 'avatar', status: 'live', count: 3 }],
	webhooks: [{ webhook: 'github', state: 'claimed', count: 1 }],
	bootFailure: { at: AT },
}
const contentView: OpsContentView = { ...view, bootFailure: failure }

/** Each value with one more key, one key's value replaced by a wrong type, and each key removed. */
function variants<T extends object>(value: T, wrong: Partial<Record<keyof T, unknown>>): unknown[] {
	const out: unknown[] = [{ ...value, extra: 1 }]
	for (const [key, replacement] of Object.entries(wrong)) out.push({ ...value, [key]: replacement })
	for (const key of Object.keys(value)) {
		const rest = { ...value }
		Reflect.deleteProperty(rest, key)
		out.push(rest)
	}
	return out
}

describe('the ops row', () => {
	test('is the platform-composed protocol row under /__fabrika/ops/', () => {
		expect(OPS_PREFIX).toBe('/__fabrika/ops/')
		expect(OPS_ROW_PATH).toBe('/__fabrika/ops/*')
		expect(OPS_METHOD).toBe('POST')
		expect(OPS_CONTENT_TYPE).toBe('application/json')
	})

	test('has an id no authored endpoint can take, since an authored name starts with a letter', () => {
		expect(OPS_ROW_ID).toBe('__fabrika.ops')
		expect(/^[A-Za-z]/.test(OPS_ROW_ID)).toBe(false)
	})

	test('names each operation by its path segment, and nothing else', () => {
		expect(opsPath('state')).toBe('/__fabrika/ops/state')
		expect(parseOpsOperation('/__fabrika/ops/state')).toBe('state')
		expect(parseOpsOperation('/__fabrika/ops/migrate')).toBe('migrate')
		expect(parseOpsOperation('/__fabrika/ops/inspect')).toBe('inspect')
		for (
			const path of ['/__fabrika/ops/', '/__fabrika/ops/State', '/__fabrika/ops/state/', '/__fabrika/ops/state/x', '/__fabrika/ops/toString', '/state']
		) {
			expect(parseOpsOperation(path)).toBeNull()
		}
	})

	test('refuses with one answer: 404, no body, no headers', async () => {
		const first = opsRefusal()
		const second = opsRefusal()
		expect(first.status).toBe(OPS_REFUSAL_STATUS)
		expect(OPS_REFUSAL_STATUS).toBe(404)
		expect(await first.text()).toBe('')
		expect([...first.headers]).toEqual([...second.headers])
		expect(first.headers.get('content-type')).toBeNull()
	})
})

describe('FABRIKA_OPS_KEY_DIGESTS', () => {
	const current = opsKeyDigest('ok_current')
	const previous = opsKeyDigest('ok_previous')

	test('digests a key as sha256:<hex>', () => {
		expect(current).toMatch(/^sha256:[0-9a-f]{64}$/)
		expect(current).toBe(opsKeyDigest('ok_current'))
		expect(current).not.toBe(previous)
	})

	test('holds one digest, or two during a rotation', () => {
		expect(parseOpsKeyDigests(current)).toEqual([current])
		expect(parseOpsKeyDigests(`${previous},${current}`)).toEqual([previous, current])
		expect(formatOpsKeyDigests([previous, current])).toBe(`${previous},${current}`)
		expect(parseOpsKeyDigests(formatOpsKeyDigests([current]))).toEqual([current])
	})

	test('refuses no digest, three, a repeated one and a malformed one', () => {
		const third = opsKeyDigest('ok_third')
		for (
			const value of [
				'',
				',',
				`${current},`,
				`${previous},${current},${third}`,
				`${current},${current}`,
				`${current}, ${previous}`,
				current.slice(7),
				current.toUpperCase(),
				`sha256:${'0'.repeat(63)}`,
			]
		) {
			expect(parseOpsKeyDigests(value)).toBeNull()
		}
		expect(() => formatOpsKeyDigests([current, current])).toThrow()
		expect(() => formatOpsKeyDigests(['ok_plain_key'])).toThrow()
	})
})

describe('the inspect request', () => {
	test('asks for the projection or for content', () => {
		expect(parseOpsInspectRequest({ object: 'application', content: false })).toEqual({ object: 'application', content: false })
		expect(parseOpsInspectRequest({ object: 'restore-1', content: true })).toEqual({ object: 'restore-1', content: true })
	})

	test('refuses an unknown key, a wrong type and a missing field', () => {
		for (const body of [...variants({ object: 'application', content: false }, { object: 'Application', content: 'yes' }), null, [], 'content']) {
			expect(parseOpsInspectRequest(body)).toBeNull()
		}
	})
})

describe('the state transition', () => {
	test('carries a generation and one of the four modes', () => {
		expect(OPS_MODES).toEqual(['open', 'read-only', 'closed', 'inspect'])
		for (const mode of OPS_MODES) {
			expect(parseOpsStateRequest({ object: 'application', generation: 3, mode })).toEqual({ object: 'application', generation: 3, mode })
		}
	})

	test('refuses an unknown mode, an unknown key and a wrong type', () => {
		const request = { object: 'application', generation: 3, mode: 'closed' }
		for (const body of [...variants(request, { object: '../x', generation: '3', mode: 'frozen' }), { ...request, mode: 'Open' }]) {
			expect(parseOpsStateRequest(body)).toBeNull()
		}
	})

	test('refuses a generation that is not a positive safe integer', () => {
		for (const generation of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, null]) {
			expect(parseOpsStateRequest({ object: 'application', generation, mode: 'closed' })).toBeNull()
		}
		expect(parseOpsStateRequest({ object: 'application', generation: Number.MAX_SAFE_INTEGER, mode: 'closed' })).not.toBeNull()
	})

	test('is acknowledged with the state and the count still running past the bound', () => {
		const ack: OpsStateAck = { generation: 3, mode: 'read-only', stillRunning: 0 }
		expect(parseOpsStateAck(ack)).toEqual(ack)
		expect(parseOpsStateAck({ ...ack, stillRunning: 2 })).toEqual({ ...ack, stillRunning: 2 })
		for (const body of [...variants(ack, { generation: 0, mode: 'frozen', stillRunning: -1 }), { ...ack, stillRunning: 1.5 }]) {
			expect(parseOpsStateAck(body)).toBeNull()
		}
	})
})

describe('the migration request', () => {
	test('carries the generation it runs under', () => {
		const request = { object: 'application', generation: 9 }
		expect(parseOpsMigrateRequest(request)).toEqual(request)
		for (const body of [...variants(request, { object: '', generation: '9' }), { ...request, generation: 0 }, { ...request, mode: 'open' }]) {
			expect(parseOpsMigrateRequest(body)).toBeNull()
		}
	})

	test('is acknowledged with the new ledger', () => {
		const ack = { generation: 9, migrations: [migration] }
		expect(parseOpsMigrateAck(ack)).toEqual(ack)
		expect(parseOpsMigrateAck({ generation: 9, migrations: [] })).toEqual({ generation: 9, migrations: [] })
		for (
			const body of [
				...variants(ack, { generation: -9, migrations: {} }),
				...variants(migration, { bundle: 1, name: '', checksum: null, appliedAt: '2026-10-24' }).map((entry) => ({ generation: 9, migrations: [entry] })),
			]
		) {
			expect(parseOpsMigrateAck(body)).toBeNull()
		}
	})
})

describe('the view', () => {
	test('parses the projection', () => {
		expect(parseOpsView(view)).toEqual(view)
		const fresh: OpsView = {
			...view,
			maintenance: { mode: 'open', generation: null, published: false },
			scheduler: { alarm: null },
			jobs: [{ job: 'nightlyDigest', lastStatus: null, lastStartedAt: null, lastFinishedAt: null, lastDurationMs: null }],
			bootFailure: null,
		}
		expect(parseOpsView(fresh)).toEqual(fresh)
	})

	test('refuses content in the projection: a boot failure carries only its time', () => {
		expect(parseOpsView(contentView)).toBeNull()
	})

	test('refuses an unknown key, a wrong type and an unknown mode at every level', () => {
		const bodies = [
			...variants(view, { release: 'latest', migrations: {}, jobs: null, files: 'x', webhooks: 1, bootFailure: 'boom' }),
			...variants(view.maintenance, { mode: 'frozen', generation: 0, published: 'yes' }).map((maintenance) => ({ ...view, maintenance })),
			...variants(view.database, { sizeBytes: -1, tables: {} }).map((database) => ({ ...view, database })),
			...variants({ name: 'notes', rows: 12 }, { name: '', rows: OPS_ROW_COUNT_CAP + 1 }).map((table) => ({
				...view,
				database: { sizeBytes: 1, tables: [table] },
			})),
			...variants(view.scheduler, { alarm: 1730000000000 }).map((scheduler) => ({ ...view, scheduler })),
			...variants(view.jobs[0] ?? {}, { job: '', lastStatus: 'running', lastStartedAt: 'yesterday', lastFinishedAt: 1, lastDurationMs: -1 }).map((
				job,
			) => ({
				...view,
				jobs: [job],
			})),
			...variants(view.files[0] ?? {}, { kind: '', status: 'deleted', count: 1.5 }).map((file) => ({ ...view, files: [file] })),
			...variants(view.webhooks[0] ?? {}, { webhook: '', state: 'done', count: -1 }).map((webhook) => ({ ...view, webhooks: [webhook] })),
			...variants({ at: AT }, { at: 'now' }).map((bootFailure) => ({ ...view, bootFailure })),
		]
		for (const body of bodies) {
			expect(parseOpsView(body)).toBeNull()
		}
	})

	test('parses the content-bearing view, which adds the boot failure text', () => {
		expect(parseOpsContentView(contentView)).toEqual(contentView)
		const noStack = { ...contentView, bootFailure: { at: AT, message: 'boot failed', stack: null } }
		expect(parseOpsContentView(noStack)).toEqual(noStack)
		expect(parseOpsContentView({ ...view, bootFailure: null })).toEqual({ ...view, bootFailure: null })
		for (const bootFailure of variants(failure, { at: 'now', message: 1, stack: 2 })) {
			expect(parseOpsContentView({ ...contentView, bootFailure })).toBeNull()
		}
		expect(parseOpsContentView({ ...contentView, extra: 1 })).toBeNull()
		expect(parseOpsContentView({ ...contentView, maintenance: { ...view.maintenance, mode: 'frozen' } })).toBeNull()
	})
})

describe('the view refuses text in an identifier slot', () => {
	const freeText = [
		'',
		' notes',
		'notes ',
		'no tes',
		'notes\n',
		'invoice.pdf',
		'customer-invoice.pdf\nprivate payload',
		'Boot failed: connection refused',
	]

	test('a table name follows the data layer identifier rule', () => {
		for (const name of ['notes', '_private', 'fabrika_job_leases', `a${'b'.repeat(62)}`]) {
			expect(parseOpsView({ ...view, database: { sizeBytes: 1, tables: [{ name, rows: 1 }] } })).not.toBeNull()
		}
		for (const name of [...freeText, 'Notes', '1notes', 'note-comments', `a${'b'.repeat(63)}`]) {
			expect(parseOpsView({ ...view, database: { sizeBytes: 1, tables: [{ name, rows: 1 }] } })).toBeNull()
		}
	})

	test('a job, a webhook and a file kind follow the contract name rule', () => {
		const job = view.jobs[0]
		const file = view.files[0]
		const webhook = view.webhooks[0]
		if (job === undefined || file === undefined || webhook === undefined) throw new Error('fixture')
		for (const name of ['nightlyDigest', 'Github', 'scan_2']) {
			expect(parseOpsView({ ...view, jobs: [{ ...job, job: name }], files: [{ ...file, kind: name }], webhooks: [{ ...webhook, webhook: name }] })).not
				.toBeNull()
		}
		for (const name of [...freeText, '_job', '2fa', 'nightly-digest']) {
			expect(parseOpsView({ ...view, jobs: [{ ...job, job: name }] })).toBeNull()
			expect(parseOpsView({ ...view, files: [{ ...file, kind: name }] })).toBeNull()
			expect(parseOpsView({ ...view, webhooks: [{ ...webhook, webhook: name }] })).toBeNull()
		}
		expect(parseOpsView({ ...view, jobs: [{ ...job, job: `a${'b'.repeat(64)}` }] })).toBeNull()
	})

	test("a migration's bundle, filename and checksum follow the ledger's rules", () => {
		const withMigration = (entry: Record<string, unknown>) => ({ ...view, migrations: [{ ...migration, ...entry }] })
		for (const entry of [{ bundle: 'app' }, { bundle: 'framework-v2' }, { name: '0002_notes.down.sql' }, { checksum: '0123456789abcdef'.repeat(4) }]) {
			expect(parseOpsView(withMigration(entry))).not.toBeNull()
		}
		for (const text of freeText) {
			expect(parseOpsView(withMigration({ bundle: text }))).toBeNull()
			expect(parseOpsView(withMigration({ name: text }))).toBeNull()
			expect(parseOpsView(withMigration({ checksum: text }))).toBeNull()
		}
		for (
			const entry of [
				{ bundle: 'App' },
				{ bundle: '1app' },
				{ name: '0001_notes' },
				{ name: '.hidden.sql' },
				{ name: '0001 notes.sql' },
				{ checksum: 'a'.repeat(63) },
				{ checksum: 'A'.repeat(64) },
				{ checksum: `sha256:${'a'.repeat(64)}` },
				{ checksum: 'g'.repeat(64) },
			]
		) {
			expect(parseOpsView(withMigration(entry))).toBeNull()
		}
	})
})

describe('timestamps', () => {
	const at = (alarm: string) => parseOpsView({ ...view, scheduler: { alarm } })

	test('accept a real instant, a leap day included', () => {
		for (const alarm of ['2028-02-29T00:00:00.000Z', '2000-02-29T23:59:59.999Z', '2026-12-31T23:59:59.999Z']) {
			expect(at(alarm)?.scheduler.alarm).toBe(alarm)
		}
	})

	test('refuse an impossible date that Date would roll over', () => {
		for (
			const alarm of [
				'2026-02-31T12:00:00.000Z',
				'2026-02-29T12:00:00.000Z',
				'1900-02-29T12:00:00.000Z',
				'2026-04-31T00:00:00.000Z',
				'2026-01-01T24:00:00.000Z',
			]
		) {
			expect(at(alarm)).toBeNull()
		}
	})
})

describe('object names', () => {
	test('admit a lowercase name of at most 63 characters, safe as an R2 key segment', () => {
		for (const name of ['application', 'a', 'restore-2026-10-24', `a${'b'.repeat(62)}`]) {
			expect(parseApplicationObjectName(name)).toBe(name)
		}
		for (const name of ['', 'Application', '1st', '-a', 'a_b', 'a.b', 'a/b', '../a', 'a b', `a${'b'.repeat(63)}`, 7, null, undefined]) {
			expect(parseApplicationObjectName(name)).toBeNull()
		}
	})

	test('default to the one object `application` without either variable', () => {
		expect(DEFAULT_APPLICATION_OBJECT).toBe('application')
		expect(parseApplicationObjects(undefined, undefined)).toEqual({ object: 'application', objects: ['application'] })
	})

	test('list distinct names that hold the object of ordinary traffic', () => {
		expect(parseApplicationObjects('application', 'application')).toEqual({ object: 'application', objects: ['application'] })
		expect(parseApplicationObjects('restore-1', 'application,restore-1')).toEqual({ object: 'restore-1', objects: ['application', 'restore-1'] })
		const sixteen = Array.from({ length: MAX_APPLICATION_OBJECTS }, (_, index) => `o${index}`)
		expect(parseApplicationObjects('o0', sixteen.join(','))?.objects).toEqual(sixteen)
	})

	test('refuse a list without the object, a repeated or malformed name, too many names, and only one variable', () => {
		const seventeen = Array.from({ length: MAX_APPLICATION_OBJECTS + 1 }, (_, index) => `o${index}`).join(',')
		for (
			const [object, objects] of [
				['application', 'restore-1'],
				['application', 'application,application'],
				['application', 'application,'],
				['application', ''],
				['application', 'application, restore-1'],
				['application', 'application,Restore'],
				['Application', 'Application'],
				['o0', seventeen],
				['application', undefined],
				[undefined, 'application'],
			] as const
		) {
			expect(parseApplicationObjects(object, objects)).toBeNull()
		}
	})

	test("key each object's maintenance state under __fabrika/ops/ in the bucket", () => {
		expect(OPS_STATE_KEY('application')).toBe('__fabrika/ops/application.json')
		expect(() => OPS_STATE_KEY('../application')).toThrow()
	})
})

describe('a stale generation', () => {
	test('is refused with 409 and the published state', () => {
		expect(OPS_STALE_STATUS).toBe(409)
		const published: OpsPublishedState = { generation: 8, mode: 'closed' }
		const refusal: OpsStaleRefusal = { refused: 'stale_generation', published }
		expect(parseOpsStaleRefusal(refusal)).toEqual(refusal)
		expect(parseOpsStaleRefusal({ refused: 'stale_generation', published: null })).toEqual({ refused: 'stale_generation', published: null })
		for (
			const body of [
				...variants(refusal, { refused: 'stale', published: 'closed' }),
				...variants(published, { generation: 0, mode: 'frozen' }).map((published) => ({ ...refusal, published })),
			]
		) {
			expect(parseOpsStaleRefusal(body)).toBeNull()
		}
	})

	test('is a lower generation, or the same with another mode; the same generation and mode is a retry', () => {
		const current = { generation: 8, mode: 'read-only' } as const
		expect(opsTransitionRefused(current, { generation: 7, mode: 'read-only' })).toBe(true)
		expect(opsTransitionRefused(current, { generation: 8, mode: 'closed' })).toBe(true)
		expect(opsTransitionRefused(current, { generation: 8, mode: 'read-only' })).toBe(false)
		expect(opsTransitionRefused(current, { generation: 9, mode: 'open' })).toBe(false)
		expect(opsTransitionRefused(null, { generation: 1, mode: 'closed' })).toBe(false)
	})
})

const DUMP = '0192a4c6-7b1e-7c3d-9e2f-0a1b2c3d4e5f'
const SENTINEL = '0192a4c6-7b1e-7c3d-9e2f-ffffffffffff'
const HASH = 'b'.repeat(64)
const SHA = 'c'.repeat(64)
const BOOKMARK = '0000007b-0000b26e-00001538-0c3e87bb37b3db5cc52eedb93cd3b96b'
const UPLOAD = 'ABPnzm7-upload_id.1'
const cursor: OpsDumpCursor = { table: 'notes', after: '9223372036854775807', rows: 2, hash: HASH }
const uploaded: OpsUploadedPart = { part: 1, size: OPS_DUMP_PART_SIZE, sha256: SHA, etag: 'etag-1' }
const authors: OpsDumpTable = { name: 'authors', rows: 3, hash: HASH }
const manifest: OpsDumpManifest = {
	format: 1,
	dump: DUMP,
	object: 'application',
	consistent: true,
	createdAt: AT,
	bookmark: BOOKMARK,
	release: '0.9.0',
	contractDigest: `sha256:${'d'.repeat(64)}`,
	ddl: [
		{ type: 'table', name: 'authors', table: 'authors', sql: 'CREATE TABLE authors (id TEXT PRIMARY KEY)' },
		{ type: 'table', name: 'notes', table: 'notes', sql: 'CREATE TABLE notes (id TEXT PRIMARY KEY, author TEXT REFERENCES authors (id))' },
		{ type: 'index', name: 'Notes_By_Author', table: 'notes', sql: 'CREATE INDEX Notes_By_Author ON notes (author)' },
		{ type: 'table', name: 'empty', table: 'empty', sql: 'CREATE TABLE empty (id INTEGER PRIMARY KEY)' },
	],
	migrations: [migration, { ...migration, bundle: 'app', name: '0001_notes.sql' }],
	tables: [authors, { name: 'notes', rows: 2, hash: HASH }, { name: 'empty', rows: 0, hash: OPS_EMPTY_TABLE_HASH }],
	parts: [{ part: 1, size: OPS_DUMP_PART_SIZE, sha256: SHA }, { part: 2, size: 345, sha256: SHA }],
}

describe('the data operations', () => {
	test('are served each at its own path', () => {
		for (const operation of ['export', 'import', 'restore', 'timers'] as const) {
			expect(OPS_OPERATIONS).toContain(operation)
			expect(parseOpsOperation(opsPath(operation))).toBe(operation)
		}
		expect(parseOpsOperation('/__fabrika/ops/export/step')).toBeNull()
	})
})

describe('dump bounds', () => {
	test('every part but the last has one size, which R2 accepts and a 2 MB row as hex fits', () => {
		expect(OPS_DUMP_PART_SIZE).toBe(8 * 1024 * 1024)
		expect(OPS_DUMP_PART_SIZE).toBeGreaterThanOrEqual(5 * 1024 * 1024)
		expect(OPS_DUMP_PART_SIZE).toBeGreaterThan(2 * 2_000_000)
		expect(OPS_DUMP_MAX_PARTS).toBe(10_000)
		expect(OPS_DUMP_PAGE_ROWS).toBe(1000)
		expect(OPS_DUMP_MANIFEST_MAX_BYTES).toBe(4 * 1024 * 1024)
		expect(OPS_DUMP_PART_MAX_RAW_BYTES).toBe(16 * 1024 * 1024)
		expect(OPS_DUMP_PART_MAX_ROWS).toBe(50_000)
		// A 2 MB row of text or blobs doubles as hex, and still fits one part's raw bound.
		expect(OPS_DUMP_PART_MAX_RAW_BYTES).toBeGreaterThan(2 * 2_000_000 + 1024)
		expect(OPS_DUMP_FORMAT).toBe(1)
	})

	test('keys a consistent backup under __fabrika/backups/ and a diagnostic export under __fabrika/exports/', () => {
		expect(OPS_DUMP_KEY({ object: 'application', dump: DUMP, consistent: true }, 'data')).toBe(`__fabrika/backups/application/${DUMP}/data.ndjson.gz`)
		expect(OPS_DUMP_KEY({ object: 'application', dump: DUMP, consistent: true }, 'manifest')).toBe(
			`__fabrika/backups/application/${DUMP}/manifest.json`,
		)
		expect(OPS_DUMP_KEY({ object: 'restore-1', dump: DUMP, consistent: false }, 'data')).toBe(`__fabrika/exports/restore-1/${DUMP}/data.ndjson.gz`)
		for (
			const ref of [{ object: '../x', dump: DUMP }, { object: 'application', dump: 'latest' }, { object: 'application', dump: DUMP.toUpperCase() }]
		) {
			expect(() => OPS_DUMP_KEY({ ...ref, consistent: true }, 'data')).toThrow()
		}
	})

	test('rehearses in an object of its own name, which is never the default', () => {
		expect(parseApplicationObjectName(OPS_REHEARSAL_OBJECT)).toBe(OPS_REHEARSAL_OBJECT)
		expect(OPS_REHEARSAL_OBJECT).not.toBe(DEFAULT_APPLICATION_OBJECT)
	})
})

describe('the canonical row encoding', () => {
	const row: OpsDumpValue[] = [
		{ type: 'integer', value: '9007199254740993' },
		{ type: 'integer', value: '-9223372036854775808' },
		{ type: 'integer', value: '9223372036854775807' },
		{ type: 'real', value: -0 },
		{ type: 'real', value: 0 },
		{ type: 'real', value: 0.1 },
		{ type: 'real', value: 5e-324 },
		{ type: 'real', value: Number.MAX_VALUE },
		{ type: 'real', value: Number.POSITIVE_INFINITY },
		{ type: 'real', value: Number.NEGATIVE_INFINITY },
		{ type: 'blob', value: '00FF10' },
		{ type: 'blob', value: '' },
		// 'a', NUL, 'b' and U+1F600, as UTF-8 bytes.
		{ type: 'text', value: '610062F09F9880' },
		{ type: 'text', value: '' },
		null,
	]
	const encoded = '["i:9007199254740993","i:-9223372036854775808","i:9223372036854775807","r:-0","r:0","r:0.1","r:5e-324",'
		+ '"r:1.7976931348623157e+308","r:Infinity","r:-Infinity","b:00FF10","b:","t:610062F09F9880","t:",null]'

	test('is stable', () => {
		expect(encodeOpsDumpRow(row)).toBe(encoded)
	})

	test('round-trips every value exactly', () => {
		const decoded = decodeOpsDumpRow(encoded)
		expect(decoded).toEqual(row)
		const negativeZero = decoded?.[3]
		expect(negativeZero?.type === 'real' && Object.is(negativeZero.value, -0)).toBe(true)
	})

	test('keeps an integer above 2^53 as its decimal text, which a double would round', () => {
		expect(Number('9007199254740993')).toBe(9007199254740992)
		expect(decodeOpsDumpRow('["i:9007199254740993"]')).toEqual([{ type: 'integer', value: '9007199254740993' }])
	})

	test('tells a negative zero from zero', () => {
		expect(encodeOpsDumpRow([{ type: 'real', value: -0 }])).not.toBe(encodeOpsDumpRow([{ type: 'real', value: 0 }]))
	})

	test('refuses to encode a value outside the rules, and names no value in the error', () => {
		const values: OpsDumpValue[] = [
			{ type: 'real', value: Number.NaN },
			{ type: 'integer', value: '9223372036854775808' },
			{ type: 'integer', value: '01' },
			{ type: 'integer', value: '-0' },
			{ type: 'integer', value: '1.5' },
			{ type: 'blob', value: 'ab' },
			{ type: 'blob', value: 'ABC' },
			{ type: 'text', value: 'hi' },
			{ type: 'text', value: '6a' },
			{ type: 'text', value: '686' },
		]
		for (const value of values) {
			expect(() => encodeOpsDumpRow([value])).toThrow()
		}
		expect(() => encodeOpsDumpRow([{ type: 'integer', value: '123456789012345678901234' }])).toThrow(/^(?!.*1234567890)/)
	})

	test('decodes only the canonical text', () => {
		for (
			const text of [
				'["i:01"]',
				'["i:-0"]',
				'["i:9223372036854775808"]',
				'["i:-9223372036854775809"]',
				'["i:1e3"]',
				'["i:"]',
				'["r:1.0"]',
				'["r:0x10"]',
				'["r: 1"]',
				'["r:NaN"]',
				'["r:"]',
				'["r:+1"]',
				'["r:1E+21"]',
				'["b:ab"]',
				'["b:ABC"]',
				'["t:hi"]',
				'["t:6a"]',
				'["t:616"]',
				'["x:1"]',
				'["i"]',
				'[1]',
				'[true]',
				'[["t:61"]]',
				'{"0":"t:61"}',
				'[ "t:61"]',
				'["t:61"] ',
				'["t:\\u0036\\u0031"]',
				'not json',
			]
		) {
			expect(decodeOpsDumpRow(text)).toBeNull()
		}
	})
})

describe('a dump line', () => {
	const row: OpsDumpValue[] = [{ type: 'integer', value: '1' }, { type: 'text', value: '6869' }, null]

	test('names its table and carries the canonical row', () => {
		const line = encodeOpsDumpLine({ table: 'notes', row })
		expect(line).toBe('{"table":"notes","row":["i:1","t:6869",null]}')
		expect(decodeOpsDumpLine(line)).toEqual({ table: 'notes', row })
	})

	test('refuses an unknown key, a table outside the identifier rule and a text that is not canonical', () => {
		for (
			const text of [
				'{"table":"notes","row":["i:1"],"x":1}',
				'{"table":"Notes","row":["i:1"]}',
				'{"row":["i:1"],"table":"notes"}',
				'{"table":"notes","row":["i:01"]}',
				'{"table":"notes"}',
				'null',
				'',
			]
		) {
			expect(decodeOpsDumpLine(text)).toBeNull()
		}
		expect(() => encodeOpsDumpLine({ table: 'Notes', row })).toThrow()
	})
})

describe('a table hash', () => {
	const spec = (hash: string, row: string) => createHash('sha256').update(`${hash}\n${row}`, 'utf8').digest('hex')
	const inserted = [{ rowid: 3, row: '["i:3","t:63"]' }, { rowid: 1, row: '["i:1","t:6100"]' }, { rowid: 2, row: '["i:2","t:F09F9880"]' }]
	const keyset = [...inserted].sort((left, right) => left.rowid - right.rowid).map((entry) => entry.row)

	test('starts from the SHA-256 of the empty string', () => {
		expect(OPS_EMPTY_TABLE_HASH).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
		expect(foldOpsTableHash(OPS_EMPTY_TABLE_HASH, [])).toBe(OPS_EMPTY_TABLE_HASH)
	})

	test('chains the rows in keyset order: each step is the SHA-256 of the previous hash, a newline and the row', () => {
		expect(foldOpsTableHash(OPS_EMPTY_TABLE_HASH, keyset)).toBe(keyset.reduce(spec, OPS_EMPTY_TABLE_HASH))
	})

	test('is order-sensitive', () => {
		const insertion = inserted.map((entry) => entry.row)
		expect(foldOpsTableHash(OPS_EMPTY_TABLE_HASH, insertion)).not.toBe(foldOpsTableHash(OPS_EMPTY_TABLE_HASH, keyset))
	})

	test('folds page after page into the value one pass gives', () => {
		const once = foldOpsTableHash(OPS_EMPTY_TABLE_HASH, keyset)
		for (let split = 0; split <= keyset.length; split++) {
			expect(foldOpsTableHash(foldOpsTableHash(OPS_EMPTY_TABLE_HASH, keyset.slice(0, split)), keyset.slice(split))).toBe(once)
		}
	})

	test('refuses a malformed starting hash', () => {
		expect(() => foldOpsTableHash('x', [])).toThrow()
	})
})

describe('the export request', () => {
	const scope = { object: 'application', generation: 4, consistent: true, dump: DUMP }
	const begin: OpsExportBegin = { ...scope, step: 'begin' }
	const first: OpsExportPart = { ...scope, step: 'part', uploadId: UPLOAD, part: 1, cursor: null }
	const next: OpsExportPart = { ...scope, step: 'part', uploadId: UPLOAD, part: 2, cursor }
	const complete: OpsExportComplete = {
		...scope,
		step: 'complete',
		uploadId: UPLOAD,
		bookmark: BOOKMARK,
		parts: [uploaded, { ...uploaded, part: 2, size: 12 }],
		tables: [authors],
	}

	test('begins, writes a part and completes a consistent backup under a generation', () => {
		for (const request of [begin, first, next, complete]) {
			expect(parseOpsExportRequest(request)).toEqual(request)
		}
	})

	test('takes a diagnostic export without a generation, and a consistent one only with one', () => {
		const diagnostic: OpsExportBegin = { ...begin, generation: null, consistent: false }
		expect(parseOpsExportRequest(diagnostic)).toEqual(diagnostic)
		expect(parseOpsExportRequest({ ...diagnostic, generation: 4 })).toBeNull()
		expect(parseOpsExportRequest({ ...diagnostic, consistent: true })).toBeNull()
	})

	test('refuses an unknown key, a wrong type and a missing field at every step', () => {
		const bodies = [
			...variants(begin, { object: 'Application', generation: '4', consistent: 'yes', dump: 'not-a-uuid', step: 'start' }),
			...variants(first, { uploadId: '', part: 0, cursor: 'start' }),
			...variants(next, { uploadId: 'a b', part: OPS_DUMP_MAX_PARTS + 1 }),
			...variants(cursor, { table: 'Notes', after: 9, rows: -1, hash: 'B'.repeat(64) }).map((value) => ({ ...next, cursor: value })),
			...variants(complete, { bookmark: '', parts: [], tables: {} }),
			...variants(uploaded, { part: 0, size: OPS_DUMP_PART_SIZE + 1, sha256: 'x', etag: 1 }).map((part) => ({ ...complete, parts: [part] })),
			null,
			[],
			'begin',
		]
		for (const body of bodies) {
			expect(parseOpsExportRequest(body)).toBeNull()
		}
	})

	test('starts the first part from no cursor, and every later part from one', () => {
		expect(parseOpsExportRequest({ ...first, cursor })).toBeNull()
		expect(parseOpsExportRequest({ ...next, cursor: null })).toBeNull()
	})

	test("holds a cursor's rowid as decimal text, and before a table's first row a cursor has folded nothing", () => {
		const start: OpsDumpCursor = { table: 'notes', after: null, rows: 0, hash: OPS_EMPTY_TABLE_HASH }
		expect(parseOpsExportRequest({ ...next, cursor: start })).toEqual({ ...next, cursor: start })
		expect(parseOpsExportRequest({ ...next, cursor: { ...cursor, after: '-12' } })).not.toBeNull()
		for (
			const value of [
				{ ...cursor, after: '01' },
				{ ...cursor, after: '9223372036854775808' },
				{ ...cursor, after: null },
				{ ...cursor, rows: 0 },
				{ ...start, hash: HASH },
			]
		) {
			expect(parseOpsExportRequest({ ...next, cursor: value })).toBeNull()
		}
	})

	test('completes only with every part but the last at the fixed size, numbered from 1 without a gap', () => {
		expect(parseOpsExportRequest({ ...complete, parts: [{ ...uploaded, size: 20 }] })).not.toBeNull()
		const tooMany = Array.from({ length: OPS_DUMP_MAX_PARTS + 1 }, (_, index) => ({ ...uploaded, part: index + 1 }))
		for (
			const parts of [
				[{ ...uploaded, size: 12 }, { ...uploaded, part: 2 }],
				[{ ...uploaded, part: 2 }],
				[uploaded, { ...uploaded, part: 3 }],
				[uploaded, uploaded],
				[{ ...uploaded, size: 0 }],
				tooMany,
			]
		) {
			expect(parseOpsExportRequest({ ...complete, parts })).toBeNull()
		}
		expect(parseOpsExportRequest({ ...complete, tables: [authors, authors] })).toBeNull()
	})
})

describe('the export answers', () => {
	test('begin answers the upload and the bookmark', () => {
		const ack: OpsExportBeginAck = { step: 'begin', uploadId: UPLOAD, bookmark: BOOKMARK }
		expect(parseOpsExportBeginAck(ack)).toEqual(ack)
		for (const body of [...variants(ack, { step: 'part', uploadId: 1, bookmark: '' }), null]) {
			expect(parseOpsExportBeginAck(body)).toBeNull()
		}
	})

	test('a part answers its upload, the tables it finished and the next cursor', () => {
		const ack: OpsExportPartAck = { step: 'part', uploaded, tables: [authors], next: cursor }
		expect(parseOpsExportPartAck(ack)).toEqual(ack)
		expect(parseOpsExportPartAck({ ...ack, tables: [], next: null })).toEqual({ ...ack, tables: [], next: null })
		const bodies = [
			...variants(ack, { step: 'begin', uploaded: { ...uploaded, etag: '' }, tables: [{ ...authors, rows: -1 }], next: 'done' }),
			...variants(uploaded, { part: 0, size: OPS_DUMP_PART_SIZE + 1, sha256: 'x', etag: 1 }).map((value) => ({ ...ack, uploaded: value })),
			...variants(authors, { name: 'Authors', rows: 1.5, hash: SHA.toUpperCase() }).map((table) => ({ ...ack, tables: [table] })),
			{ ...ack, next: { ...cursor, table: 'authors' } },
			{ ...ack, tables: [authors, authors] },
			{ ...ack, tables: [{ name: 'empty', rows: 0, hash: HASH }] },
		]
		for (const body of bodies) {
			expect(parseOpsExportPartAck(body)).toBeNull()
		}
	})

	test('a part short of the fixed size is the last one: its answer has no next cursor', () => {
		const ack: OpsExportPartAck = { step: 'part', uploaded, tables: [authors], next: cursor }
		expect(parseOpsExportPartAck(ack)).toEqual(ack)
		expect(parseOpsExportPartAck({ ...ack, next: null })).toEqual({ ...ack, next: null })
		for (const size of [1, OPS_DUMP_PART_SIZE - 1]) {
			const short = { ...ack, uploaded: { ...uploaded, size } }
			expect(parseOpsExportPartAck(short)).toBeNull()
			expect(parseOpsExportPartAck({ ...short, next: null })).toEqual({ ...short, next: null })
		}
		const over = { ...ack, uploaded: { ...uploaded, size: OPS_DUMP_PART_SIZE + 1 } }
		expect(parseOpsExportPartAck(over)).toBeNull()
		expect(parseOpsExportPartAck({ ...over, next: null })).toBeNull()
	})

	test('complete answers the manifest it wrote', () => {
		const ack: OpsExportCompleteAck = { step: 'complete', manifest }
		expect(parseOpsExportCompleteAck(ack)).toEqual(ack)
		for (const body of [...variants(ack, { step: 'begin', manifest: { ...manifest, format: 2 } }), null]) {
			expect(parseOpsExportCompleteAck(body)).toBeNull()
		}
	})
})

describe('the manifest', () => {
	test('round-trips through its JSON text', () => {
		expect(parseOpsDumpManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest)
		expect(readOpsDumpManifest(JSON.stringify(manifest))).toEqual(manifest)
		const diagnostic = { ...manifest, consistent: false }
		expect(readOpsDumpManifest(JSON.stringify(diagnostic))).toEqual(diagnostic)
	})

	test('refuses a text larger than the bound, and a text that is no JSON', () => {
		const view = { type: 'view', name: 'big', table: 'big', sql: 'x'.repeat(OPS_DUMP_MANIFEST_MAX_BYTES) }
		const large = JSON.stringify({ ...manifest, ddl: [...manifest.ddl, view] })
		expect(parseOpsDumpManifest(JSON.parse(large))).toBeNull()
		expect(parseOpsExportCompleteAck({ step: 'complete', manifest: JSON.parse(large) })).toBeNull()
		expect(readOpsDumpManifest(large)).toBeNull()
		expect(readOpsDumpManifest('not json')).toBeNull()
	})

	test('is bounded in UTF-8 bytes at every ingress: exactly the bound passes, one byte more does not', () => {
		/** The manifest with a view whose SQL is padded with two-byte characters until it serializes to `bytes`. */
		const sized = (bytes: number): OpsDumpManifest => {
			const base = { ...manifest, ddl: [...manifest.ddl, { type: 'view' as const, name: 'big', table: 'big', sql: 'x' }] }
			const missing = bytes - new TextEncoder().encode(JSON.stringify(base)).length
			const sql = `${'\u00e9'.repeat(Math.floor(missing / 2))}${'x'.repeat((missing % 2) + 1)}`
			return { ...manifest, ddl: [...manifest.ddl, { type: 'view', name: 'big', table: 'big', sql }] }
		}
		const atBound = sized(OPS_DUMP_MANIFEST_MAX_BYTES)
		const above = sized(OPS_DUMP_MANIFEST_MAX_BYTES + 1)
		expect(new TextEncoder().encode(JSON.stringify(atBound)).length).toBe(OPS_DUMP_MANIFEST_MAX_BYTES)
		expect(new TextEncoder().encode(JSON.stringify(above)).length).toBe(OPS_DUMP_MANIFEST_MAX_BYTES + 1)
		expect(JSON.stringify(atBound).length).toBeLessThan(OPS_DUMP_MANIFEST_MAX_BYTES)
		expect(parseOpsDumpManifest(JSON.parse(JSON.stringify(atBound)))).toEqual(atBound)
		expect(readOpsDumpManifest(JSON.stringify(atBound))).toEqual(atBound)
		expect(parseOpsExportCompleteAck({ step: 'complete', manifest: atBound })).toEqual({ step: 'complete', manifest: atBound })
		expect(parseOpsDumpManifest(JSON.parse(JSON.stringify(above)))).toBeNull()
		expect(readOpsDumpManifest(JSON.stringify(above))).toBeNull()
		expect(parseOpsExportCompleteAck({ step: 'complete', manifest: above })).toBeNull()
	})

	test('refuses an unknown key, a wrong type and a missing field at every level', () => {
		const [table, ...ddl] = manifest.ddl
		const [first, ...tables] = manifest.tables
		const [part, last] = manifest.parts
		if (table === undefined || first === undefined || part === undefined || last === undefined) throw new Error('fixture')
		const bodies = [
			...variants(manifest, {
				format: 2,
				dump: 'latest',
				object: 'Application',
				consistent: 1,
				createdAt: 'now',
				bookmark: '',
				release: 'latest',
				contractDigest: 'd'.repeat(64),
				ddl: {},
				migrations: [{}],
				tables: null,
				parts: [],
			}),
			...variants(table, { type: 'column', name: '', table: 'Authors', sql: '' }).map((entry) => ({ ...manifest, ddl: [entry, ...ddl] })),
			...variants(first, { name: 'Authors', rows: -1, hash: 'x' }).map((entry) => ({ ...manifest, tables: [entry, ...tables] })),
			...variants(part, { part: 2, size: 1, sha256: 'x' }).map((entry) => ({ ...manifest, parts: [entry, last] })),
		]
		for (const body of bodies) {
			expect(parseOpsDumpManifest(body)).toBeNull()
		}
	})

	test('lists a table exactly when its DDL is a table, each once', () => {
		const [authorsDdl, notesDdl, indexDdl, emptyDdl] = manifest.ddl
		if (authorsDdl === undefined || notesDdl === undefined || indexDdl === undefined || emptyDdl === undefined) throw new Error('fixture')
		for (
			const body of [
				{ ...manifest, ddl: [authorsDdl, notesDdl, indexDdl] },
				{ ...manifest, tables: manifest.tables.slice(0, 2) },
				{ ...manifest, tables: [...manifest.tables, authors] },
				{ ...manifest, ddl: [...manifest.ddl, indexDdl] },
				{ ...manifest, ddl: [authorsDdl, notesDdl, { ...emptyDdl, table: 'notes' }, indexDdl] },
			]
		) {
			expect(parseOpsDumpManifest(body)).toBeNull()
		}
	})

	test('holds whole parts: the fixed size but for the last, numbered from 1', () => {
		const [part, last] = manifest.parts
		if (part === undefined || last === undefined) throw new Error('fixture')
		expect(parseOpsDumpManifest({ ...manifest, parts: [{ ...last, part: 1 }] })).not.toBeNull()
		for (const parts of [[{ ...part, size: 12 }, last], [last], [part, { ...last, part: 3 }]]) {
			expect(parseOpsDumpManifest({ ...manifest, parts })).toBeNull()
		}
	})
})

describe('the import request', () => {
	const source: OpsDumpSource = { object: 'application', dump: DUMP }
	const scope = { object: OPS_REHEARSAL_OBJECT, generation: 5, source }
	const begin: OpsImportBegin = { ...scope, step: 'begin' }
	const part: OpsImportPart = { ...scope, step: 'part', part: 1 }
	const link: OpsImportLink = { ...scope, step: 'link', part: 2 }
	const verify: OpsImportVerify = { ...scope, step: 'verify', cursor }
	const complete: OpsImportComplete = { ...scope, step: 'complete' }
	const discard: OpsImportDiscard = { object: OPS_REHEARSAL_OBJECT, generation: 5, step: 'discard' }

	test('loads a backup into a fresh object step by step, every step under a generation', () => {
		for (const request of [begin, part, link, { ...verify, cursor: null }, verify, complete, discard]) {
			expect(parseOpsImportRequest(request)).toEqual(request)
		}
	})

	test('refuses an unknown key, a wrong type and a missing field at every step', () => {
		const bodies = [
			...variants(begin, { object: 'Rehearsal', generation: null, source: 'application', step: 'load' }),
			...variants(source, { object: 'Application', dump: 'latest' }).map((value) => ({ ...begin, source: value })),
			...variants(part, { part: 0 }),
			...variants(link, { part: 1.5 }),
			...variants(verify, { cursor: {} }),
			...variants(complete, {}),
			...variants(discard, { generation: 0 }),
			{ ...discard, source },
			null,
		]
		for (const body of bodies) {
			expect(parseOpsImportRequest(body)).toBeNull()
		}
	})
})

describe('the import answers', () => {
	test('begin answers the number of parts to load', () => {
		const ack: OpsImportBeginAck = { step: 'begin', parts: 2 }
		expect(parseOpsImportBeginAck(ack)).toEqual(ack)
		for (const body of [...variants(ack, { step: 'part', parts: 0 }), { ...ack, parts: OPS_DUMP_MAX_PARTS + 1 }]) {
			expect(parseOpsImportBeginAck(body)).toBeNull()
		}
	})

	test('a part answers the rows it loaded and how many wait for the link pass', () => {
		const ack: OpsImportPartAck = { step: 'part', part: 1, rows: 1000, deferred: 3 }
		expect(parseOpsImportPartAck(ack)).toEqual(ack)
		for (const body of variants(ack, { step: 'link', part: 0, rows: -1, deferred: '3' })) {
			expect(parseOpsImportPartAck(body)).toBeNull()
		}
	})

	test('a link pass answers the rows it set', () => {
		const ack: OpsImportLinkAck = { step: 'link', part: 1, rows: 3 }
		expect(parseOpsImportLinkAck(ack)).toEqual(ack)
		for (const body of variants(ack, { step: 'part', part: OPS_DUMP_MAX_PARTS + 1, rows: null })) {
			expect(parseOpsImportLinkAck(body)).toBeNull()
		}
	})

	test('verify answers the tables it matched and the next cursor', () => {
		const ack: OpsImportVerifyAck = { step: 'verify', tables: [authors], next: cursor }
		expect(parseOpsImportVerifyAck(ack)).toEqual(ack)
		expect(parseOpsImportVerifyAck({ ...ack, next: null })).toEqual({ ...ack, next: null })
		for (
			const body of [
				...variants(ack, { step: 'part', tables: [{}], next: {} }),
				{ ...ack, tables: [authors, authors] },
				{ ...ack, next: { ...cursor, table: 'authors' } },
			]
		) {
			expect(parseOpsImportVerifyAck(body)).toBeNull()
		}
	})

	test('complete names the backup the object now holds; discard answers that it wiped the object', () => {
		const ack: OpsImportCompleteAck = { step: 'complete', source: { object: 'application', dump: DUMP } }
		expect(parseOpsImportCompleteAck(ack)).toEqual(ack)
		for (const body of variants(ack, { step: 'discard', source: { object: 'application' } })) {
			expect(parseOpsImportCompleteAck(body)).toBeNull()
		}
		expect(parseOpsImportDiscardAck({ step: 'discard' })).toEqual({ step: 'discard' })
		for (const body of [{ step: 'discard', extra: 1 }, { step: 'complete' }, {}, null]) {
			expect(parseOpsImportDiscardAck(body)).toBeNull()
		}
	})
})

describe('the restore request', () => {
	const prepare: OpsRestorePrepare = { step: 'prepare', object: 'application', generation: 6, sentinel: SENTINEL, at: AT }
	const arm: OpsRestoreArm = { step: 'arm', object: 'application', generation: 6, sentinel: SENTINEL, target: BOOKMARK }
	const verify: OpsRestoreVerify = { step: 'verify', object: 'application', sentinel: SENTINEL }

	test('prepares under a generation, arms the target bookmark, and verifies the sentinel after the reset', () => {
		for (const request of [prepare, arm, verify]) {
			expect(parseOpsRestoreRequest(request)).toEqual(request)
		}
	})

	test('refuses an unknown key, a wrong type and a missing field at every step', () => {
		const bodies = [
			...variants(prepare, { step: 'peek', object: 'A', generation: 0, sentinel: 'x', at: '2026-10-24' }),
			...variants(arm, { generation: null, target: '' }),
			...variants(verify, { sentinel: SENTINEL.toUpperCase() }),
			{ ...verify, generation: 6 },
			null,
		]
		for (const body of bodies) {
			expect(parseOpsRestoreRequest(body)).toBeNull()
		}
	})
})

describe('the restore answers', () => {
	test('prepare answers the current and the target bookmark', () => {
		const ack: OpsRestorePrepareAck = { step: 'prepare', current: BOOKMARK, target: '0000007a-00000001-00001538-0c3e87bb37b3db5cc52eedb93cd3b96b' }
		expect(parseOpsRestorePrepareAck(ack)).toEqual(ack)
		for (const body of variants(ack, { step: 'arm', current: '', target: 7 })) {
			expect(parseOpsRestorePrepareAck(body)).toBeNull()
		}
	})

	test('arm answers the undo bookmark', () => {
		const ack: OpsRestoreArmAck = { step: 'arm', undo: BOOKMARK }
		expect(parseOpsRestoreArmAck(ack)).toEqual(ack)
		for (const body of variants(ack, { step: 'verify', undo: 'a\nb' })) {
			expect(parseOpsRestoreArmAck(body)).toBeNull()
		}
	})

	test('verify answers whether the sentinel survived, and the bookmark now current', () => {
		for (const sentinel of ['absent', 'present'] as const) {
			expect(parseOpsRestoreVerifyAck({ step: 'verify', sentinel, bookmark: BOOKMARK })).toEqual({ step: 'verify', sentinel, bookmark: BOOKMARK })
		}
		for (const body of variants({ step: 'verify', sentinel: 'absent', bookmark: BOOKMARK }, { step: 'arm', sentinel: true, bookmark: '' })) {
			expect(parseOpsRestoreVerifyAck(body)).toBeNull()
		}
	})
})

describe('the timers view', () => {
	const timeout: OpsTimer = { kind: 'timeout', since: AT, delayMs: 10_000, stack: 'Error\n    at handler (src/notes.ts:3:1)' }
	const pending: OpsTimer = { kind: 'waitUntil', since: AT, delayMs: null, stack: '' }
	const timers: OpsTimersView = { tracking: true, timers: [timeout, pending], omitted: 0 }

	test('is read, or tracking is switched on or off', () => {
		for (const track of [null, true, false]) {
			expect(parseOpsTimersRequest({ object: 'application', track })).toEqual({ object: 'application', track })
		}
		for (
			const body of [...variants({ object: 'application', track: null }, { object: '', track: 'on' }), {
				object: 'application',
				track: null,
				generation: 1,
			}]
		) {
			expect(parseOpsTimersRequest(body)).toBeNull()
		}
	})

	test('lists each live timer with its stack', () => {
		expect(parseOpsTimersView(timers)).toEqual(timers)
		expect(parseOpsTimersView({ tracking: false, timers: [], omitted: 0 })).toEqual({ tracking: false, timers: [], omitted: 0 })
		expect(parseOpsTimersView({ ...timers, timers: [{ ...timeout, kind: 'interval' }], omitted: 12 })).not.toBeNull()
	})

	test('refuses an unknown key and a wrong type, a delay on waitUntil, a timer without one, and more than the cap', () => {
		const bodies = [
			...variants(timers, { tracking: 'yes', timers: {}, omitted: -1 }),
			...variants(timeout, { kind: 'promise', since: 'now', delayMs: -1, stack: null }).map((timer) => ({ ...timers, timers: [timer] })),
			{ ...timers, timers: [{ ...pending, delayMs: 5 }] },
			{ ...timers, timers: [{ ...timeout, delayMs: null }] },
			{ ...timers, timers: Array.from({ length: OPS_TIMERS_CAP + 1 }, () => timeout) },
		]
		for (const body of bodies) {
			expect(parseOpsTimersView(body)).toBeNull()
		}
	})
})

describe('a data refusal', () => {
	test('is a 422 naming its reason and, where one is at fault, the table', () => {
		expect(OPS_DATA_REFUSED_STATUS).toBe(422)
		for (const refused of OPS_DATA_REFUSALS) {
			expect(parseOpsDataRefusal({ refused, table: null })).toEqual({ refused, table: null })
		}
		expect(parseOpsDataRefusal({ refused: 'verify_mismatch', table: 'notes' })).toEqual({ refused: 'verify_mismatch', table: 'notes' })
	})

	test('refuses an unknown reason, a table outside the identifier rule, the stale refusal and an unknown key', () => {
		for (
			const body of [
				...variants({ refused: 'fuzzy_dump', table: null }, { refused: 'nope', table: 'Notes' }),
				{ refused: 'stale_generation', table: null },
				{ refused: 'verify_mismatch', table: 'customer@example.com' },
			]
		) {
			expect(parseOpsDataRefusal(body)).toBeNull()
		}
	})
})
