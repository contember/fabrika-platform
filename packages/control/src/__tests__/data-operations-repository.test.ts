// Control's data operation record (ADR-0069): the operation row, its lease-fenced progress and the per-environment
// generation counter, against SQLite always and Postgres when FABRIKA_TEST_POSTGRES_URL is set.

import { type SqlDatabase, SqlDeployLocks, uuidv7 } from '@fabrika/platform'
import { PostgresDatabase } from '@fabrika/platform-node'
import { afterEach, describe, expect, test } from 'bun:test'
import { type ControlRepositories, createControlRepositories } from '../db'
import type { DataOperationFields, DataOperationInput, DataOperationRepository, DataOperationResolution, DataOperationRow } from '../db'
import { LEASE_TTL_MS, type LeaseFence, runLeaseKey } from '../lease'
import { createHarness } from './helpers/harness'
import { createPostgres, hasPostgres, postgresUrl, skipReason } from './helpers/postgres'

if (!hasPostgres) console.warn(`data-operations-repository.test.ts Postgres half ${skipReason}`)

interface Backend {
	repositories: ControlRepositories
	db: SqlDatabase
	/** A second handle on the same schema whose pool runs statements concurrently, where the backend can. */
	concurrent(): SqlDatabase
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
				concurrent: () => harness.d1,
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
			const fixture = await createPostgres('control_data_ops')
			const pools: PostgresDatabase[] = []
			return {
				repositories: createControlRepositories(fixture.db, { now }),
				db: fixture.db,
				concurrent: () => {
					if (postgresUrl === null) throw new Error('postgres is not configured')
					const pool = PostgresDatabase.connect(postgresUrl, { connection: { search_path: fixture.schema }, max: 8 })
					pools.push(pool)
					return pool
				},
				close: async () => {
					for (const pool of pools) await pool.close()
					await fixture.close()
				},
			}
		},
	},
]

const T0 = 1_800_000_000
const T0_MS = T0 * 1000

for (const backend of backends) {
	describe.skipIf(backend.skip)(`data operation record (${backend.name})`, () => {
		let opened: Backend | null = null
		let clockMs = T0_MS

		afterEach(async () => {
			await opened?.close()
			opened = null
			clockMs = T0_MS
		})

		async function open(): Promise<{ operations: DataOperationRepository; locks: SqlDeployLocks; backend: Backend }> {
			opened = await backend.open(() => Math.floor(clockMs / 1000))
			await opened.repositories.registry.createApp({ id: 'crm', repoUrl: 'github.com/acme/crm' })
			const operations = opened.repositories.dataOperations
			const locks = new SqlDeployLocks(opened.db, { now: () => clockMs })
			return { operations, locks, backend: opened }
		}

		async function lease(locks: SqlDeployLocks, env = 'prod'): Promise<LeaseFence> {
			const holder = uuidv7()
			expect(await locks.acquire(runLeaseKey('crm', env), holder, LEASE_TTL_MS)).toBe(true)
			return { holder, nowMs: clockMs }
		}

		const fields = (overrides: Partial<DataOperationFields> = {}): DataOperationFields => ({
			id: uuidv7(),
			appId: 'crm',
			env: 'prod',
			step: 'restrict',
			targetMode: 'read-only',
			generation: 1,
			actor: 'user:ada',
			...overrides,
		})
		const input = (overrides: Partial<DataOperationFields> = {}): DataOperationInput => ({ ...fields(overrides), kind: 'maintenance' })
		const recovery = (operationId: string, resolution: DataOperationResolution, overrides: Partial<DataOperationFields> = {}): DataOperationInput => ({
			...fields({ step: 'reconcile', targetMode: 'closed', ...overrides }),
			kind: 'recovery',
			recovers: { operationId, resolution },
		})

		test('an operation is created only under the environment lease', async () => {
			const { operations, locks } = await open()
			const stranger: LeaseFence = { holder: uuidv7(), nowMs: clockMs }
			const refused = input()
			expect(await operations.create(refused, stranger)).toBeNull()
			expect(await operations.get(refused.id)).toBeNull()

			// The lease of another environment of the same application does not cover it either.
			const stage = await lease(locks, 'stage')
			expect(await operations.create(refused, stage)).toBeNull()

			const fence = await lease(locks)
			const created = await operations.create(input({ id: refused.id }), fence)
			expect(created).toEqual({
				id: refused.id,
				app_id: 'crm',
				env: 'prod',
				kind: 'maintenance',
				step: 'restrict',
				target_mode: 'read-only',
				generation: 1,
				state: 'running',
				error_code: null,
				actor: 'user:ada',
				created_at: T0,
				updated_at: T0,
				finished_at: null,
				recovers_operation_id: null,
				resolution: null,
				run_id: null,
			})
			expect(await operations.get(refused.id)).toEqual(created)
		})

		test('generations are strictly increasing under concurrent allocation, per environment', async () => {
			const { backend: opened } = await open()
			const concurrent = createControlRepositories(opened.concurrent()).dataOperations
			const prod = await Promise.all(Array.from({ length: 24 }, () => concurrent.allocateGeneration('crm', 'prod')))
			const stage = await Promise.all(Array.from({ length: 6 }, () => concurrent.allocateGeneration('crm', 'stage')))
			expect([...prod].sort((a, b) => a - b)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1))
			expect([...stage].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6])

			const operations = opened.repositories.dataOperations
			expect(await operations.allocateGeneration('crm', 'prod')).toBe(25)
			expect(await operations.allocateGeneration('crm', 'prod')).toBe(26)
		})

		test('the counter outlives its application, so a recreated environment never reuses a generation', async () => {
			const { operations, backend: opened } = await open()
			await operations.allocateGeneration('crm', 'prod')
			await operations.allocateGeneration('crm', 'prod')
			expect(await opened.repositories.registry.deleteApp('crm')).toBe(true)
			await opened.repositories.registry.createApp({ id: 'crm', repoUrl: 'github.com/acme/crm' })
			expect(await operations.allocateGeneration('crm', 'prod')).toBe(3)
		})

		test('a step advances only for the lease holder and from the expected step', async () => {
			const { operations, locks } = await open()
			const fence = await lease(locks)
			const created = await operations.create(input(), fence)
			if (created === null) throw new Error('not created')

			expect(await operations.advance(created.id, { expectedStep: 'backup', step: 'verify' }, fence)).toBe(false)
			expect(await operations.advance(created.id, { expectedStep: 'restrict', step: 'backup' }, { holder: uuidv7(), nowMs: clockMs })).toBe(false)
			expect(await operations.get(created.id)).toEqual(created)

			clockMs += 5_000
			const advanced = { holder: fence.holder, nowMs: clockMs }
			expect(await operations.advance(created.id, { expectedStep: 'restrict', step: 'backup' }, advanced)).toBe(true)
			expect(await operations.get(created.id)).toEqual({ ...created, step: 'backup', updated_at: T0 + 5 })
			// The same step again is a lost race, not a retry.
			expect(await operations.advance(created.id, { expectedStep: 'restrict', step: 'backup' }, advanced)).toBe(false)
		})

		test('a former holder changes nothing once its lease expired, and its successor carries on', async () => {
			const { operations, locks } = await open()
			const former = await lease(locks)
			const created = await operations.create(input(), former)
			if (created === null) throw new Error('not created')

			clockMs += LEASE_TTL_MS
			const late = { holder: former.holder, nowMs: clockMs }
			expect(await operations.advance(created.id, { expectedStep: 'restrict', step: 'backup' }, late)).toBe(false)

			const successor = await lease(locks)
			expect(await operations.advance(created.id, { expectedStep: 'restrict', step: 'backup' }, late)).toBe(false)
			expect(await operations.finish(created.id, late)).toBe(false)
			expect(await operations.fail(created.id, 'lease_lost', late)).toBe(false)
			expect(await operations.get(created.id)).toEqual(created)

			// The successor fences with a fresh generation in the mode the record requires, from the recorded step.
			expect(await operations.advance(created.id, { expectedStep: 'restrict', step: 'restrict', generation: 2 }, successor)).toBe(true)
			expect(await operations.get(created.id)).toMatchObject({ step: 'restrict', target_mode: 'read-only', generation: 2 })
		})

		for (const resolution of ['resume', 'open'] as const) {
			test(`a recovery to ${resolution} keeps its intent through the closed fence, for a successor to read`, async () => {
				const { operations, locks, backend: opened } = await open()
				const fence = await lease(locks)
				const stuck = await operations.create(input({ step: 'backup' }), fence)
				if (stuck === null) throw new Error('not created')
				const created = await operations.create(recovery(stuck.id, resolution, { generation: 2 }), fence)
				if (created === null) throw new Error('not created')
				expect(await operations.advance(created.id, { expectedStep: 'reconcile', step: 'restrict', generation: 3 }, fence)).toBe(true)

				// The recovering instance dies here; a successor composes its own repositories over the same database.
				const successor: DataOperationRepository = createControlRepositories(opened.db).dataOperations
				const found = await successor.get(created.id)
				expect(found).toMatchObject({
					kind: 'recovery',
					step: 'restrict',
					target_mode: 'closed',
					generation: 3,
					recovers_operation_id: stuck.id,
					resolution,
				})
				const listed = await successor.listForEnvironment('crm', 'prod', { limit: 10 })
				expect(listed.map((row) => [row.id, row.recovers_operation_id, row.resolution])).toEqual([
					[created.id, stuck.id, resolution],
					[stuck.id, null, null],
				])
			})
		}

		test('a recovery names an operation of its own environment', async () => {
			const { operations, locks } = await open()
			const stage = await lease(locks, 'stage')
			const prod = await lease(locks)
			const elsewhere = await operations.create(input({ env: 'stage' }), stage)
			if (elsewhere === null) throw new Error('not created')

			for (const target of [elsewhere.id, uuidv7()]) {
				const refused = recovery(target, 'open')
				await expect(operations.create(refused, prod)).rejects.toThrow()
				expect(await operations.get(refused.id)).toBeNull()
			}
		})

		test('deleting the application removes its operations, recoveries included', async () => {
			const { operations, locks, backend: opened } = await open()
			const fence = await lease(locks)
			const stuck = await operations.create(input(), fence)
			if (stuck === null) throw new Error('not created')
			const created = await operations.create(recovery(stuck.id, 'resume'), fence)
			if (created === null) throw new Error('not created')
			expect(await opened.repositories.registry.deleteApp('crm')).toBe(true)
			expect(await operations.get(stuck.id)).toBeNull()
			expect(await operations.get(created.id)).toBeNull()
		})

		test('a recorded generation only rises', async () => {
			const { operations, locks } = await open()
			const fence = await lease(locks)
			const created = await operations.create(input({ generation: 4 }), fence)
			if (created === null) throw new Error('not created')

			for (const generation of [3, 4]) {
				expect(await operations.advance(created.id, { expectedStep: 'restrict', step: 'open', targetMode: 'open', generation }, fence)).toBe(false)
			}
			expect(await operations.get(created.id)).toEqual(created)
			expect(await operations.advance(created.id, { expectedStep: 'restrict', step: 'open', targetMode: 'open', generation: 5 }, fence)).toBe(true)
			expect(await operations.get(created.id)).toMatchObject({ step: 'open', target_mode: 'open', generation: 5 })
		})

		test('finish is terminal', async () => {
			const { operations, locks } = await open()
			const fence = await lease(locks)
			const created = await operations.create(input(), fence)
			if (created === null) throw new Error('not created')

			clockMs += 3_000
			const later = { holder: fence.holder, nowMs: clockMs }
			expect(await operations.finish(created.id, later)).toBe(true)
			const finished: DataOperationRow = { ...created, state: 'succeeded', updated_at: T0 + 3, finished_at: T0 + 3 }
			expect(await operations.get(created.id)).toEqual(finished)

			expect(await operations.finish(created.id, later)).toBe(false)
			expect(await operations.fail(created.id, 'object_refused', later)).toBe(false)
			expect(await operations.advance(created.id, { expectedStep: 'restrict', step: 'open' }, later)).toBe(false)
			expect(await operations.get(created.id)).toEqual(finished)
		})

		test('fail is terminal and records a code, never free text', async () => {
			const { operations, locks } = await open()
			const fence = await lease(locks)
			const created = await operations.create(input(), fence)
			if (created === null) throw new Error('not created')

			for (const text of ['Error: ENOSPC writing /data/app.sqlite', 'Object_Refused', '', 'x'.repeat(65)]) {
				await expect(operations.fail(created.id, text, fence)).rejects.toThrow('error code')
			}
			expect(await operations.get(created.id)).toEqual(created)

			expect(await operations.fail(created.id, 'object_refused', fence)).toBe(true)
			const failed: DataOperationRow = { ...created, state: 'failed', error_code: 'object_refused', finished_at: T0 }
			expect(await operations.get(created.id)).toEqual(failed)

			expect(await operations.fail(created.id, 'lease_lost', fence)).toBe(false)
			expect(await operations.finish(created.id, fence)).toBe(false)
			expect(await operations.advance(created.id, { expectedStep: 'restrict', step: 'open' }, fence)).toBe(false)
			expect(await operations.get(created.id)).toEqual(failed)
		})

		test('a list holds one environment, newest first, a page at a time', async () => {
			const { operations, locks } = await open()
			const prod = await lease(locks)
			const stage = await lease(locks, 'stage')
			const ids = [uuidv7(), uuidv7(), uuidv7()]
			for (const id of ids) await operations.create(input({ id }), prod)
			await operations.create(input({ id: uuidv7(), env: 'stage' }), stage)

			const first = await operations.listForEnvironment('crm', 'prod', { limit: 2 })
			expect(first.map((row) => row.id)).toEqual([ids[2], ids[1]])
			const second = await operations.listForEnvironment('crm', 'prod', { limit: 2, before: ids[1] })
			expect(second.map((row) => row.id)).toEqual([ids[0]])
			expect(await operations.listForEnvironment('billing', 'prod', { limit: 2 })).toEqual([])
		})
	})
}
