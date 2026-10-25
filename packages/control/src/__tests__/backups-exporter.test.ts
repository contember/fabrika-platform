// Control's backup dump against the object's real exporter (ADR-0070 §2): Control's HTTP ops transport, whose requests
// reach the application's `serveOps` over bun:sqlite and Lopata's R2 as the proxy would forward them. The rehearsal
// target does not answer, so each backup stops at `verify` once its dump is complete.

import {
	ENDPOINT_HEADER,
	FABRIKA_APPLICATION_OBJECT,
	FABRIKA_APPLICATION_OBJECTS,
	FABRIKA_OPS_KEY_DIGESTS,
	formatOpsKeyDigests,
	OPS_DUMP_KEY,
	opsKeyDigest,
	type OpsPublishedState,
	parseOpsDumpManifest,
} from '@fabrika/auth-core'
import { SqlDeployLocks } from '@fabrika/platform'
import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { createTestEnv, type TestEnv } from 'lopata/testing'
import { method } from '../../../app/src/cloudflare/bindings'
import { MaintenanceBarrier } from '../../../app/src/cloudflare/maintenance'
import { OPS_ENDPOINT, opsAccess, type OpsTarget as ObjectTarget, serveOps } from '../../../app/src/cloudflare/ops'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { SQLITE_FRAMEWORK_MIGRATIONS } from '../../../db/src/migrations-sqlite'
import { bunSqliteStorage } from '../../../db/src/sqlite-bun'
import { migrateSqlite } from '../../../db/src/sqlite-migrate'
import { advanceDataOperation, type DataOperationDeps, httpOpsTransport, type OpsTarget, startBackup } from '../data-operations'
import { createHarness } from './helpers/harness'
import { providerEnvironment } from './helpers/provider'

const APP = 'crm'
const ENV = 'prod'
const TARGET: OpsTarget = { appId: APP, env: ENV }
const OPS_KEY = 'ops-key-of-the-environment-0123456789abcdef'
const BOOKMARK = '0000000a-00000001-00004f6b-8a4c1f5d0e9b2a37'
const APP_SCHEMA = `
CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
INSERT INTO notes (id, title) VALUES (1, 'first'), (2, 'second');
`

const envs: TestEnv[] = []
afterEach(() => {
	for (const env of envs.splice(0)) env.dispose()
})

/** The environment's object: its SQLite, its bucket and the barrier of `application`, reached as the Worker reaches it. */
async function object() {
	// Workerd's storage has a size and an alarm; the bun:sqlite double has neither.
	const double = bunSqliteStorage(new Database(':memory:'))
	const storage = { ...double, sql: { ...double.sql, databaseSize: 4096 }, getAlarm: () => Promise.resolve(null) }
	const migrations = [
		{ bundle: 'fabrika', migrations: SQLITE_FRAMEWORK_MIGRATIONS },
		{ bundle: 'app', migrations: [{ name: '0001_notes.sql', sql: APP_SCHEMA }] },
	]
	await migrateSqlite(
		{ exec: (query, ...bindings) => storage.sql.exec(query, ...bindings), transactionSync: (fn) => storage.transactionSync(fn) },
		migrations,
	)
	const testEnv = await createTestEnv({ bindings: { FILES: 'r2' } })
	envs.push(testEnv)
	const bucket = testEnv.env.FILES
	let stored: { state: OpsPublishedState; version: string } | null = null
	const barrier = await MaintenanceBarrier.load({
		read: () => Promise.resolve(stored),
		put: (state) => {
			stored = { state, version: `v${state.generation}` }
			return Promise.resolve(stored.version)
		},
	})
	const target: ObjectTarget = {
		storage,
		bucket,
		recovery: {
			getCurrentBookmark: () => Promise.resolve(BOOKMARK),
			getBookmarkForTime: () => Promise.reject(new Error('not called')),
			onNextSessionRestoreBookmark: () => Promise.reject(new Error('not called')),
			abort: () => {
				throw new Error('not called')
			},
		},
		contractDigest: `sha256:${'c'.repeat(64)}`,
		migrations,
		bootFailure: () => Promise.resolve(null),
		maintenance: () => Promise.resolve(barrier),
		migrate: () => Promise.reject(new Error('not called')),
	}
	const access = opsAccess({
		[FABRIKA_OPS_KEY_DIGESTS]: formatOpsKeyDigests([opsKeyDigest(OPS_KEY)]),
		[FABRIKA_APPLICATION_OBJECT]: 'application',
		[FABRIKA_APPLICATION_OBJECTS]: 'application,rehearsal',
	})
	const sent: string[] = []
	/** The proxy's hop: it adds the ops row's endpoint id; `rehearsal` answers nothing. */
	const fetch = async (input: string, init: RequestInit): Promise<Response> => {
		const body: unknown = JSON.parse(typeof init.body === 'string' ? init.body : '{}')
		const named = typeof body === 'object' && body !== null ? Reflect.get(body, 'object') : undefined
		const step = typeof body === 'object' && body !== null ? Reflect.get(body, 'step') : undefined
		const generation = typeof body === 'object' && body !== null ? Reflect.get(body, 'generation') : undefined
		sent.push(`${new URL(input).pathname.split('/').at(-1)} ${String(named)}${typeof step === 'string' ? ` ${step}` : ''} @${String(generation)}`)
		if (named === 'rehearsal') return new Response('', { status: 503 })
		const headers = new Headers(init.headers)
		headers.set(ENDPOINT_HEADER, OPS_ENDPOINT)
		return await serveOps(new Request(input, { method: init.method ?? 'POST', headers, body: init.body ?? null }), access, target)
	}
	return { bucket, fetch, sent }
}

async function setup() {
	const harness = createHarness(() => 1_800_000_000)
	await harness.repositories.registry.createApp({ id: APP, repoUrl: 'github.com/acme/crm' })
	await harness.repositories.registry.upsertAppEnv(providerEnvironment(APP, ENV, { domain: 'prod.crm.example.com' }))
	const snapshot = JSON.stringify({ version: 1, contract: notesArtifact, migrations: [], checker: '0.9.0' })
	await harness.d1.prepare('UPDATE app_envs SET published_run_id = ?, published_snapshot_json = ? WHERE app_id = ? AND env = ?').bind(
		'01920000-0000-7000-8000-0000000000aa',
		snapshot,
		APP,
		ENV,
	).run()
	const env = await object()
	const ops = httpOpsTransport({ registry: harness.repositories.registry, opsKeysFor: () => Promise.resolve([OPS_KEY]), fetch: env.fetch })
	const deps = (passSpent?: () => boolean): DataOperationDeps => ({
		repositories: harness.repositories,
		lock: new SqlDeployLocks(harness.d1),
		ops,
		...(passSpent === undefined ? {} : { passSpent }),
	})
	return { harness, env, ops, deps }
}

test('a successor cannot continue a dump the exporter bound to an earlier generation: it dumps again under a new dump id', async () => {
	const { harness, env, ops, deps } = await setup()
	try {
		// The first holder's pass ends after `begin` and the only part.
		let budget = 2
		const paused = await startBackup(deps(() => budget-- <= 0), { ...TARGET, actor: 'user:test' })
		if (paused.kind !== 'driven') throw new Error('the backup did not start')
		expect(paused).toMatchObject({ result: 'paused', operation: { state: 'running', step: 'backup', generation: 1 } })
		const [first] = await harness.repositories.backups.listForEnvironment(APP, ENV, { limit: 1 })
		if (first === undefined) throw new Error('no backup')
		expect(first).toMatchObject({ dump_id: first.id, dump_generation: 1 })
		expect(env.sent).toEqual(['inspect application @undefined', 'state application @1', 'export application begin @1', 'export application part @1'])

		// What a successor that continued the dump would send: under its own generation the exporter refuses it.
		const signal = new AbortController().signal
		expect(await ops.state(TARGET, { object: 'application', generation: 2, mode: 'read-only' }, signal)).toMatchObject({ kind: 'ok' })
		const continued = await ops.export(
			TARGET,
			{
				step: 'part',
				object: 'application',
				generation: 2,
				consistent: true,
				dump: first.dump_id,
				uploadId: first.upload_id ?? '',
				part: 1,
				cursor: null,
			},
			signal,
		)
		expect(continued).toEqual({ kind: 'refused', refusal: { refused: 'ledger_mismatch', table: null } })

		env.sent.length = 0
		const resumed = await advanceDataOperation(deps(), paused.operation.id)
		expect(resumed).toMatchObject({ result: 'interrupted', operation: { state: 'running', step: 'verify' } })
		expect(env.sent.slice(0, 5)).toEqual([
			'state application @2',
			'export application begin @2',
			'export application part @2',
			'export application complete @2',
			'state application @3',
		])
		const [done] = await harness.repositories.backups.listForEnvironment(APP, ENV, { limit: 1 })
		if (done === undefined) throw new Error('no backup')
		expect(done).toMatchObject({ id: first.id, state: 'running', dump_generation: 2, parts: 1 })
		expect(done.dump_id).not.toBe(first.dump_id)
		expect((await harness.repositories.backups.parts(done.id)).map((part) => part.part)).toEqual([1])

		// The completed dump in the bucket is the new one.
		const stored = await method(env.bucket, 'get')?.(OPS_DUMP_KEY({ object: 'application', consistent: true, dump: done.dump_id }, 'manifest'))
		const text = await method(stored, 'text')?.()
		const manifest = parseOpsDumpManifest(JSON.parse(typeof text === 'string' ? text : 'null'))
		expect(manifest).toMatchObject({ dump: done.dump_id, bookmark: BOOKMARK, consistent: true, parts: [{ part: 1 }] })
	} finally {
		harness.sqlite.close()
	}
})
