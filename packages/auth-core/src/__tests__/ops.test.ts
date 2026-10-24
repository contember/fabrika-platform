import { describe, expect, test } from 'bun:test'
import {
	DEFAULT_APPLICATION_OBJECT,
	formatOpsKeyDigests,
	MAX_APPLICATION_OBJECTS,
	OPS_CONTENT_TYPE,
	OPS_METHOD,
	OPS_MODES,
	OPS_PREFIX,
	OPS_REFUSAL_STATUS,
	OPS_ROW_COUNT_CAP,
	OPS_ROW_ID,
	OPS_ROW_PATH,
	OPS_STALE_STATUS,
	OPS_STATE_KEY,
	type OpsBootFailureContent,
	type OpsContentView,
	opsKeyDigest,
	type OpsMigration,
	opsPath,
	type OpsPublishedState,
	opsRefusal,
	type OpsStaleRefusal,
	type OpsStateAck,
	opsTransitionRefused,
	type OpsView,
	parseApplicationObjectName,
	parseApplicationObjects,
	parseOpsContentView,
	parseOpsInspectRequest,
	parseOpsKeyDigests,
	parseOpsMigrateAck,
	parseOpsMigrateRequest,
	parseOpsOperation,
	parseOpsStaleRefusal,
	parseOpsStateAck,
	parseOpsStateRequest,
	parseOpsView,
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
