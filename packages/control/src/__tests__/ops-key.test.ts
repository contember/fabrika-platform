// The ops key of an application environment (ADR-0069): issued by Control on the first gated deploy, sealed in the
// vault, handed to the object as digests only, rotated by a gated deploy once it is 15 days old, and the previous key
// kept until a deploy that carries the new one succeeds. Every record write is fenced on the deploy's lease.

import { opsKeyDigest, parseOpsKeyDigests } from '@fabrika/auth-core'
import { type SqlDatabase, SqlDeployLocks, uuidv7 } from '@fabrika/platform'
import { afterEach, describe, expect, test } from 'bun:test'
import { type ControlRepositories, createControlRepositories, type OpsKeyRepository } from '../db'
import { OPS_KEY_ROTATE_AFTER_SECONDS, opsKeyPurpose, type OpsKeyWrites, reconcileOpsKey, VaultOpsKeys } from '../ops-key'
import { Vault } from '../vault'
import { createHarness, queryRows } from './helpers/harness'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))
const T0 = 1_800_000_000
const DAY = 86_400
const LEASE = 'notes:prod'

/** The ops keys of `notes/prod` over `db`, and gated deploys that reconcile them under the environment's lease. */
async function environment(db: SqlDatabase, repositories: ControlRepositories) {
	const { registry, runs, opsKeys } = repositories
	await registry.createApp({ id: 'notes', repoUrl: 'github.com/acme/notes' })
	await registry.upsertAppEnv({
		appId: 'notes',
		env: 'prod',
		namespaceId: null,
		provider: 'test',
		providerTargetJson: '{}',
		providerArtifactJson: '{}',
	})
	const vault = await Vault.create(db, KEY)
	const clock = { now: T0 }
	const locks = new SqlDeployLocks(db)
	const keys = new VaultOpsKeys(opsKeys, () => Promise.resolve(vault), () => clock.now)
	/** A deploy run of `notes/prod`, which a test settles with `settle`. */
	const run = async (): Promise<string> => {
		const id = uuidv7()
		await runs.createRun({ id, appId: 'notes', env: 'prod', ref: 'refs/heads/main', trigger: 'manual', actor: 'user:test' })
		return id
	}
	const settle = async (id: string, status: 'succeeded' | 'failed'): Promise<void> => {
		await db.prepare('UPDATE runs SET status = ? WHERE id = ?').bind(status, id).run()
	}
	/** Takes the environment's lease as `holder`; its writes are fenced on it and a refused one throws. */
	const holding = async (holder: string): Promise<OpsKeyWrites> => {
		expect(await locks.acquire(LEASE, holder, 60_000)).toBe(true)
		return {
			write: async (mutation) => {
				if (!(await mutation({ holder, nowMs: Date.now() }))) throw new Error('lease_lost')
			},
		}
	}
	/** One gated deploy: reconcile under a new run and its lease, then settle it. */
	const deploy = async (status: 'succeeded' | 'failed', using: VaultOpsKeys = keys): Promise<readonly string[]> => {
		const id = await run()
		const digests = parseOpsKeyDigests(await using.reconcile('notes', 'prod', id, await holding(id)))
		await locks.release(LEASE, id)
		if (digests === null) throw new Error('reconcile handed an invalid digest list')
		await settle(id, status)
		return digests
	}
	return { clock, keys, vault, locks, run, settle, holding, deploy, opsKeys }
}

async function setup() {
	const harness = createHarness()
	return { harness, ...(await environment(harness.d1, harness.repositories)) }
}

describe('VaultOpsKeys', () => {
	test('the first gated deploy issues one key, sealed in the vault, and hands only its digest', async () => {
		const { harness, keys, run, holding } = await setup()
		const runId = await run()
		const handed = await keys.reconcile('notes', 'prod', runId, await holding(runId))
		const [row] = queryRows(harness.sqlite, 'SELECT * FROM app_env_ops_keys')
		expect(row?.['handed_by']).toBe(runId)
		expect(handed).toBe(String(row?.['digest']))
		expect(queryRows(harness.sqlite, 'SELECT label FROM vault').map((entry) => entry['label'])).toEqual([
			opsKeyPurpose('notes', 'prod', String(row?.['key_id'])).label,
		])
	})

	test('a first deploy that fails after activating still yields its key as the one candidate', async () => {
		const { harness, keys, deploy } = await setup()
		const [digest] = await deploy('failed')
		const candidates = await keys.opsKeysFor('notes', 'prod')
		expect(candidates.map(opsKeyDigest)).toEqual([digest])
		expect(candidates[0]).toMatch(/^ok_[A-Za-z0-9_-]{43}$/)
		// The plaintext is sealed: no table holds a copy of it.
		const tables = [...queryRows(harness.sqlite, 'SELECT * FROM vault'), ...queryRows(harness.sqlite, 'SELECT * FROM app_env_ops_keys')]
		expect(JSON.stringify(tables)).not.toContain((candidates[0] ?? '').slice(3))
	})

	test('later gated deploys hand the same key until it is 15 days old', async () => {
		const { clock, deploy } = await setup()
		const first = await deploy('succeeded')
		clock.now = T0 + 14 * DAY
		expect(await deploy('succeeded')).toEqual(first)
		clock.now = T0 + OPS_KEY_ROTATE_AFTER_SECONDS - 1
		expect(await deploy('succeeded')).toEqual(first)
	})

	test('a key 15 days old rotates on a gated deploy, and a rotation keeps both digests until the next deploy', async () => {
		const { clock, keys, deploy } = await setup()
		const [old] = await deploy('succeeded')
		clock.now = T0 + 15 * DAY
		const rotated = await deploy('succeeded')
		expect(rotated).toEqual([old ?? '', rotated[1] ?? ''])
		const fresh = rotated[1]
		expect(fresh).not.toBe(old)
		clock.now = T0 + 16 * DAY
		expect(await deploy('succeeded')).toEqual([fresh ?? ''])
		expect((await keys.opsKeysFor('notes', 'prod')).map(opsKeyDigest)).toEqual([fresh])
	})

	test('a rotation yields the candidates [new, old]', async () => {
		const { clock, keys, deploy } = await setup()
		const [old] = await deploy('succeeded')
		clock.now = T0 + 20 * DAY
		const [, fresh] = await deploy('failed')
		expect((await keys.opsKeysFor('notes', 'prod')).map(opsKeyDigest)).toEqual([fresh, old])
	})

	test('a failed rotating deploy keeps the old key, and the next deploy hands both again without rotating further', async () => {
		const { clock, keys, deploy } = await setup()
		const [old] = await deploy('succeeded')
		clock.now = T0 + 20 * DAY
		const rotated = await deploy('failed')
		expect(rotated[0]).toBe(old)
		expect(await deploy('failed')).toEqual(rotated)
		expect((await keys.opsKeysFor('notes', 'prod')).map(opsKeyDigest)).toEqual([rotated[1], old])
		expect(await deploy('succeeded')).toEqual(rotated)
		expect(await deploy('succeeded')).toEqual([rotated[1] ?? ''])
	})

	test("a dropped key's vault row goes with its record", async () => {
		const { harness, clock, deploy } = await setup()
		await deploy('succeeded')
		clock.now = T0 + 15 * DAY
		await deploy('succeeded')
		expect(queryRows(harness.sqlite, 'SELECT * FROM vault')).toHaveLength(2)
		await deploy('succeeded')
		const rows = queryRows(harness.sqlite, 'SELECT key_id FROM app_env_ops_keys')
		expect(rows).toHaveLength(1)
		expect(queryRows(harness.sqlite, 'SELECT label FROM vault').map((entry) => entry['label'])).toEqual([
			opsKeyPurpose('notes', 'prod', String(rows[0]?.['key_id'])).label,
		])
	})

	test('a first key whose deploy failed is handed again and not rotated, however old', async () => {
		const { clock, deploy } = await setup()
		const first = await deploy('failed')
		clock.now = T0 + 40 * DAY
		expect(await deploy('failed')).toEqual(first)
		expect(await deploy('succeeded')).toEqual(first)
	})

	test('a dry or other run that succeeds after the handing run failed accepts nothing', async () => {
		const { clock, keys, deploy, run, settle } = await setup()
		const [old] = await deploy('succeeded')
		clock.now = T0 + 15 * DAY
		const [, fresh] = await deploy('failed')
		// A dry run issues nothing, so its success says nothing about the keys.
		await settle(await run(), 'succeeded')
		expect((await keys.opsKeysFor('notes', 'prod')).map(opsKeyDigest)).toEqual([fresh, old])
		expect(await deploy('failed')).toEqual([old ?? '', fresh ?? ''])
	})

	test('a substituted vault ref is never deleted, and its record is kept', async () => {
		const { harness, clock, vault, deploy } = await setup()
		const other = await vault.putSecret('platform', 'platform:proxy-secret:notes@stage', 'another credential')
		await deploy('succeeded')
		clock.now = T0 + 15 * DAY
		const [old] = await deploy('succeeded')
		harness.sqlite.query('UPDATE app_env_ops_keys SET value_ref = ? WHERE digest = ?').run(other, old ?? '')
		await deploy('succeeded')
		expect(await vault.getSecret(other)).toBe('another credential')
		expect(queryRows(harness.sqlite, 'SELECT value_ref FROM app_env_ops_keys WHERE digest = ?', old ?? '')).toEqual([{ value_ref: other }])
	})

	test('a reconcile whose lease was taken over writes nothing after it resumes', async () => {
		const { harness, clock, keys, vault, run, settle, holding, deploy, opsKeys } = await setup()
		const [old] = await deploy('succeeded')
		clock.now = T0 + 15 * DAY
		const [, fresh] = await deploy('failed')
		// Holder A reads the pending rotation, then pauses before it hands the pending key again.
		const read = Promise.withResolvers<void>()
		const resume = Promise.withResolvers<void>()
		const pausing: Pick<OpsKeyRepository, 'list' | 'insert' | 'handTo' | 'delete'> = {
			list: async (appId, env) => {
				const rows = await opsKeys.list(appId, env)
				read.resolve()
				await resume.promise
				return rows
			},
			insert: (row, fence) => opsKeys.insert(row, fence),
			handTo: (appId, env, keyId, runId, fence) => opsKeys.handTo(appId, env, keyId, runId, fence),
			delete: (appId, env, keyId, fence) => opsKeys.delete(appId, env, keyId, fence),
		}
		const runA = await run()
		const reconcileA = new VaultOpsKeys(pausing, () => Promise.resolve(vault), () => clock.now).reconcile('notes', 'prod', runA, await holding(runA))
		await read.promise
		// A loses its lease and is failed; B hands the pending key and succeeds; C drops the old key.
		harness.sqlite.query('UPDATE deploy_locks SET expires_at = 0 WHERE lock_key = ?').run(LEASE)
		await settle(runA, 'failed')
		expect(await deploy('succeeded')).toEqual([old ?? '', fresh ?? ''])
		const [handedByB] = queryRows(harness.sqlite, 'SELECT handed_by FROM app_env_ops_keys WHERE digest = ?', fresh ?? '')
		expect(await deploy('succeeded')).toEqual([fresh ?? ''])
		resume.resolve()
		await expect(reconcileA).rejects.toThrow('lease_lost')
		// The key the running version accepts still names the run that succeeded with it, not failed A.
		expect(queryRows(harness.sqlite, 'SELECT handed_by FROM app_env_ops_keys')).toEqual([handedByB ?? {}])
		expect((await keys.opsKeysFor('notes', 'prod')).map(opsKeyDigest)).toEqual([fresh])
	})
})

describe('reconcileOpsKey', () => {
	test('an installation without a vault cannot keep an ops key, so a gated deploy fails', async () => {
		const writes: OpsKeyWrites = { write: () => Promise.reject(new Error('no write expected')) }
		await expect(reconcileOpsKey({}, 'notes', 'prod', uuidv7(), writes)).rejects.toThrow('FABRIKA_CONTROL_VAULT_KEY')
	})
})

if (!hasPostgres) console.warn(`ops-key.test.ts ${skipReason}`)

describe.skipIf(!hasPostgres)('VaultOpsKeys on Postgres', () => {
	let fixture: PostgresFixture | null = null
	afterEach(async () => {
		await fixture?.close()
		fixture = null
	})

	test('a failed rotating deploy keeps both digests and the old key, and the deploy after a succeeded one drops it', async () => {
		fixture = await createPostgres('vozka_ops_keys')
		const { clock, keys, deploy } = await environment(fixture.db, createControlRepositories(fixture.db))
		const [old] = await deploy('succeeded')
		clock.now = T0 + 15 * DAY
		const rotated = await deploy('failed')
		expect(rotated[0]).toBe(old)
		expect((await keys.opsKeysFor('notes', 'prod')).map(opsKeyDigest)).toEqual([rotated[1], old])
		expect(await deploy('succeeded')).toEqual(rotated)
		expect(await deploy('succeeded')).toEqual([rotated[1] ?? ''])
	})
})
