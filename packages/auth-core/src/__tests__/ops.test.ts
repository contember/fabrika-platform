import { describe, expect, test } from 'bun:test'
import {
	formatOpsKeyDigests,
	OPS_CONTENT_TYPE,
	OPS_METHOD,
	OPS_MODES,
	OPS_PREFIX,
	OPS_REFUSAL_STATUS,
	OPS_ROW_COUNT_CAP,
	OPS_ROW_ID,
	OPS_ROW_PATH,
	type OpsBootFailureContent,
	type OpsContentView,
	opsKeyDigest,
	type OpsMigration,
	opsPath,
	opsRefusal,
	type OpsStateAck,
	type OpsView,
	parseOpsContentView,
	parseOpsInspectRequest,
	parseOpsKeyDigests,
	parseOpsMigrateAck,
	parseOpsMigrateRequest,
	parseOpsOperation,
	parseOpsStateAck,
	parseOpsStateRequest,
	parseOpsView,
} from '../ops'

const AT = '2026-10-24T12:00:00.000Z'
const failure: OpsBootFailureContent = { at: AT, message: 'boot failed', stack: 'Error: boot failed\n    at boot' }
const migration: OpsMigration = { bundle: 'framework', name: '0001_framework.sql', checksum: 'ab12', appliedAt: AT }
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
		expect(parseOpsInspectRequest({ content: false })).toEqual({ content: false })
		expect(parseOpsInspectRequest({ content: true })).toEqual({ content: true })
	})

	test('refuses an unknown key, a wrong type and a missing field', () => {
		for (const body of [...variants({ content: false }, { content: 'yes' }), null, [], 'content']) {
			expect(parseOpsInspectRequest(body)).toBeNull()
		}
	})
})

describe('the state transition', () => {
	test('carries a generation and one of the four modes', () => {
		expect(OPS_MODES).toEqual(['open', 'read-only', 'closed', 'inspect'])
		for (const mode of OPS_MODES) {
			expect(parseOpsStateRequest({ generation: 3, mode })).toEqual({ generation: 3, mode })
		}
	})

	test('refuses an unknown mode, an unknown key and a wrong type', () => {
		for (const body of [...variants({ generation: 3, mode: 'closed' }, { generation: '3', mode: 'frozen' }), { generation: 3, mode: 'Open' }]) {
			expect(parseOpsStateRequest(body)).toBeNull()
		}
	})

	test('refuses a generation that is not a positive safe integer', () => {
		for (const generation of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, null]) {
			expect(parseOpsStateRequest({ generation, mode: 'closed' })).toBeNull()
		}
		expect(parseOpsStateRequest({ generation: Number.MAX_SAFE_INTEGER, mode: 'closed' })).not.toBeNull()
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
		expect(parseOpsMigrateRequest({ generation: 9 })).toEqual({ generation: 9 })
		for (const body of [...variants({ generation: 9 }, { generation: '9' }), { generation: 0 }, { generation: 9, mode: 'open' }]) {
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
