// A Cloudflare application on Postgres in Lopata (ADR-0065, Hyperdrive): the Worker serves ctx.db over the
// `FABRIKA_DATABASE` binding, as the runtime role whose default search_path is the application's schema; a request's kick
// runs in the job object's alarm, not in the Worker; a file goes to the R2 bucket; the repair tick arms the alarm; the
// ops prefix is refused. Lopata's createTestEnv reads no `hyperdrive` from a wrangler config, so the test sets the binding
// as the local one is: its `connectionString` the local runtime-role URL. Skips cleanly when FABRIKA_TEST_POSTGRES_URL is
// unset.

import { FRAMEWORK_MIGRATION_BUNDLE, FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations'
import { applicationRuntimeUrl, definePostgresApplicationMigrations, dropApplicationDatabase } from '@fabrika/platform-node'
import { SQL } from 'bun'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createTestEnv, TestClock, type TestEnv } from 'lopata/testing'
import { join } from 'node:path'
import {
	applicationMigrations,
	CLOUDFLARE_APPLICATION_BINDING,
	CLOUDFLARE_APPLICATION_CLASS,
	CLOUDFLARE_DATABASE_BINDING,
	CLOUDFLARE_FILES_BINDING,
} from '../build'
import { createPostgresContractWorker, FabrikaJobObject, POSTGRES_ALARM_REFRESH_MS } from '../cloudflare-postgres'
import { type CfpgApp, cfpgApp } from './cloudflare-postgres-fixture/src/app'
import type { CfpgWorld } from './cloudflare-postgres-fixture/src/world'
import {
	endpointHeaderFor,
	frameworkEnvFor,
	grant,
	ISSUER,
	keepingProcessEnvironment,
	keySource,
	ORIGIN,
	PROXY_SECRET,
	token,
	workloadTokensFor,
} from './fixtures/implement/harness'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
const hasPostgres = url !== ''

if (!hasPostgres) {
	console.warn(`cloudflare-postgres-runtime.test.ts skipped: set ${URL_VAR} to run it (the Worker serves the application from Postgres)`)
}

const FIXTURE_ROOT = join(import.meta.dir, 'cloudflare-postgres-fixture')
/** The fixture vocabulary's application id. */
const APP = 'cfpg'
const APP_ENV = `${APP}@prod`
const SCHEMA = `app_${APP}`
const WORKSPACE = { type: 'workspace', value: 'w1' }

async function admin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

beforeAll(async () => {
	if (!hasPostgres) return
	await dropApplicationDatabase(url, APP)
	const framework = { bundle: FRAMEWORK_MIGRATION_BUNDLE, migrations: FRAMEWORK_MIGRATIONS }
	await definePostgresApplicationMigrations({ appId: APP, directory: '/unused', framework }).migrate(url, [
		...(await applicationMigrations(FIXTURE_ROOT)),
	])
	// What the deploy's provisioning sets: the runtime role resolves every name in the application's schema.
	await admin((sql) => sql.unsafe(`alter role run_${APP} set search_path to ${SCHEMA}`))
})

afterAll(async () => {
	if (!hasPostgres) return
	await dropApplicationDatabase(url, APP)
})

beforeEach(async () => {
	if (!hasPostgres) return
	await admin((sql) =>
		sql.unsafe(
			`truncate ${SCHEMA}.notes; delete from ${SCHEMA}.fabrika_job_leases; delete from ${SCHEMA}.fabrika_job_kicks; delete from ${SCHEMA}.fabrika_wakes`,
		)
	)
})

const deployed: TestEnv[] = []
afterEach(() => {
	for (const testEnv of deployed.splice(0)) {
		testEnv.dispose()
	}
})

interface Deployed {
	readonly testEnv: TestEnv
	readonly served: CfpgApp
	readonly world: CfpgWorld
}

/** The fixture as the provider deploys it: the Worker, its job object class and binding, the bucket and the database. */
async function deploy(): Promise<Deployed> {
	const world: CfpgWorld = { runs: [] }
	const served = cfpgApp(world)
	const worker = createPostgresContractWorker(() => Promise.resolve({ default: served.implementation }))
	const testEnv = await createTestEnv({
		// Lopata's own clock, which only its alarm timers read, an hour behind: no alarm fires by itself while a test runs;
		// a test fires one with `triggerAlarm`.
		clock: new TestClock(Date.now() - 60 * 60_000),
		worker: { default: worker, [CLOUDFLARE_APPLICATION_CLASS]: FabrikaJobObject },
		bindings: {
			[CLOUDFLARE_APPLICATION_BINDING]: { type: 'durable-object', className: CLOUDFLARE_APPLICATION_CLASS },
			[CLOUDFLARE_FILES_BINDING]: 'r2',
		},
		vars: { ...frameworkEnvFor(served.implementation), FABRIKA_IAM_APP_ID: APP_ENV, ...served.variables, FABRIKA_PROXY_SECRET: PROXY_SECRET },
	})
	deployed.push(testEnv)
	const tokens = workloadTokensFor(served.implementation, undefined, ISSUER, APP_ENV)
	testEnv.env['IAM'] = { getJwks: () => keySource.getJwks(), mintFromKey: (input: { app: string; key: string }) => tokens.exchange(input) }
	testEnv.env[CLOUDFLARE_DATABASE_BINDING] = { connectionString: applicationRuntimeUrl(url, APP) }
	return { testEnv, served, world }
}

async function call(target: Deployed, procedure: string, input: unknown): Promise<Response> {
	const path = `/api/notes.${procedure}`
	return await target.testEnv.fetch(
		new Request(`${ORIGIN}${path}`, {
			method: 'POST',
			headers: {
				'X-Fabrika-Token': await token('user', [grant('notes.read', WORKSPACE), grant('notes.write', WORKSPACE)], APP_ENV),
				'X-Fabrika-Endpoint': endpointHeaderFor(target.served.implementation, 'POST', path) ?? '',
				'Content-Type': 'application/json',
				'Sec-Fetch-Site': 'same-origin',
			},
			body: JSON.stringify(input),
		}),
	)
}

const objectOf = (target: Deployed) => target.testEnv.durableObject(CLOUDFLARE_APPLICATION_BINDING).get('application')

/** Polls `read` until `done` holds, at most 4 s. */
async function eventually<T>(read: () => Promise<T> | T, done: (value: T) => boolean): Promise<T> {
	const deadline = Date.now() + 4_000
	for (;;) {
		const value = await read()
		if (done(value) || Date.now() > deadline) {
			return value
		}
		await Bun.sleep(20)
	}
}

describe.skipIf(!hasPostgres)('an application on Postgres in Lopata', () => {
	test('the Worker serves ctx.db over the Hyperdrive binding, and a kick runs in the job object, not in the Worker', async () => {
		await keepingProcessEnvironment(async () => {
			const target = await deploy()
			const before = Date.now()
			expect((await call(target, 'create', { workspaceId: 'w1', title: 'first' })).status).toBe(200)
			expect(await (await call(target, 'titles', { workspaceId: 'w1' })).json()).toEqual({ result: { titles: ['first'] } })
			const object = objectOf(target)
			// The wake notice lowered the object's alarm to the kick, due now; nothing ran yet.
			const alarm = await eventually(() => object.getAlarm(), (at) => at !== null)
			expect(alarm ?? 0).toBeGreaterThanOrEqual(before)
			expect(alarm ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(Date.now())
			expect(target.world.runs).toEqual([])
			await object.triggerAlarm()
			expect(await eventually(() => target.world.runs, (runs) => runs.length > 0)).toEqual([{ job: 'tally', notes: 1 }])
			// The run finished under its lease.
			const finished = () => admin((sql) => sql.unsafe(`select last_status from ${SCHEMA}.fabrika_job_leases where job = 'tally'`))
			expect(await eventually(finished, (rows) => rows[0]?.last_status === 'succeeded')).toEqual([{ last_status: 'succeeded' }])
			// The alarm is armed again, within the refresh.
			const next = await eventually(() => object.getAlarm(), (at) => at !== null && at > Date.now())
			expect(next ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(Date.now() + POSTGRES_ALARM_REFRESH_MS)
		})
	})

	test("a mutation's file goes to the environment's bucket", async () => {
		await keepingProcessEnvironment(async () => {
			const target = await deploy()
			expect((await call(target, 'attach', { workspaceId: 'w1', title: 'with a file' })).status).toBe(200)
			const bucket = target.testEnv.env[CLOUDFLARE_FILES_BINDING]
			const list: unknown = typeof bucket === 'object' && bucket !== null ? Reflect.get(bucket, 'list') : undefined
			if (typeof list !== 'function') {
				throw new Error('the bucket lists nothing')
			}
			const listed: unknown = await Reflect.apply(list, bucket, [])
			const objects: unknown = typeof listed === 'object' && listed !== null ? Reflect.get(listed, 'objects') : undefined
			expect(Array.isArray(objects) ? objects.length : 0).toBe(1)
			expect(await admin((sql) => sql.unsafe(`select title from ${SCHEMA}.notes`))).toEqual([{ title: 'with a file' }])
		})
	})

	test('the repair tick arms the alarm of an environment nobody called; the ops prefix is refused', async () => {
		await keepingProcessEnvironment(async () => {
			const target = await deploy()
			await target.testEnv.scheduled({ scheduledTime: Date.now() })
			const alarm = await objectOf(target).getAlarm()
			expect(alarm ?? 0).toBeGreaterThan(Date.now())
			expect(alarm ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(Date.now() + POSTGRES_ALARM_REFRESH_MS)
			expect(await admin((sql) => sql.unsafe(`select reason from ${SCHEMA}.fabrika_wakes where job = 'tally'`))).toEqual([{ reason: 'cron' }])
			const ops = await target.testEnv.fetch(new Request(`${ORIGIN}/__fabrika/ops/state`, { method: 'POST', body: '{}' }))
			expect(ops.status).toBe(404)
		})
	})
})
