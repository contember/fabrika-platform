// The ops key of an application environment (ADR-0069): issued by Control on the first gated deploy, sealed in the
// vault, handed to the object as digests only, rotated by a gated deploy once it is 15 days old, and the previous key
// kept until a deploy that carries the new one succeeds.

import { opsKeyDigest, parseOpsKeyDigests } from '@fabrika/auth-core'
import { uuidv7 } from '@fabrika/platform'
import { afterEach, describe, expect, test } from 'bun:test'
import { createControlRepositories } from '../db'
import { OPS_KEY_ROTATE_AFTER_SECONDS, opsKeyPurpose, reconcileOpsKey, VaultOpsKeys } from '../ops-key'
import { Vault } from '../vault'
import { createHarness, queryRows } from './helpers/harness'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))
const T0 = 1_800_000_000
const DAY = 86_400

async function setup() {
	const harness = createHarness()
	const { registry, runs, opsKeys } = harness.repositories
	await registry.createApp({ id: 'notes', repoUrl: 'github.com/acme/notes' })
	await registry.upsertAppEnv({
		appId: 'notes',
		env: 'prod',
		namespaceId: null,
		provider: 'test',
		providerTargetJson: '{}',
		providerArtifactJson: '{}',
	})
	const vault = await Vault.create(harness.d1, KEY)
	const clock = { now: T0 }
	const keys = new VaultOpsKeys(opsKeys, () => Promise.resolve(vault), () => clock.now)
	/** A deploy run of `notes/prod`, which a test settles with `settle`. */
	const run = async (): Promise<string> => {
		const id = uuidv7()
		await runs.createRun({ id, appId: 'notes', env: 'prod', ref: 'refs/heads/main', trigger: 'manual', actor: 'user:test' })
		return id
	}
	const settle = (id: string, status: 'succeeded' | 'failed'): void => {
		harness.sqlite.query('UPDATE runs SET status = ? WHERE id = ?').run(status, id)
	}
	/** One gated deploy: reconcile under a new run, then settle it. */
	const deploy = async (status: 'succeeded' | 'failed'): Promise<readonly string[]> => {
		const id = await run()
		const digests = parseOpsKeyDigests(await keys.reconcile('notes', 'prod', id))
		if (digests === null) throw new Error('reconcile handed an invalid digest list')
		settle(id, status)
		return digests
	}
	return { harness, clock, keys, vault, run, settle, deploy }
}

describe('VaultOpsKeys', () => {
	test('the first gated deploy issues one key, sealed in the vault, and hands only its digest', async () => {
		const { harness, keys, run } = await setup()
		const runId = await run()
		const handed = await keys.reconcile('notes', 'prod', runId)
		const [row] = queryRows(harness.sqlite, 'SELECT * FROM app_env_ops_keys')
		expect(row?.['handed_by']).toBe(runId)
		expect(handed).toBe(String(row?.['digest']))
		expect(queryRows(harness.sqlite, 'SELECT label FROM vault').map((entry) => entry['label'])).toEqual([
			opsKeyPurpose('notes', 'prod', String(row?.['key_id'])).label,
		])
	})

	test('no running version accepts a key before the deploy that handed it succeeds', async () => {
		const { harness, keys, run, settle } = await setup()
		const runId = await run()
		const digest = await keys.reconcile('notes', 'prod', runId)
		expect(await keys.opsKeyFor('notes', 'prod')).toBeNull()
		settle(runId, 'succeeded')
		const key = await keys.opsKeyFor('notes', 'prod')
		expect(key).not.toBeNull()
		expect(opsKeyDigest(key ?? '')).toBe(digest)
		expect(key).toMatch(/^ok_[A-Za-z0-9_-]{43}$/)
		// The plaintext is sealed: no table holds a copy of it.
		const tables = [...queryRows(harness.sqlite, 'SELECT * FROM vault'), ...queryRows(harness.sqlite, 'SELECT * FROM app_env_ops_keys')]
		expect(JSON.stringify(tables)).not.toContain((key ?? '').slice(3))
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
		const oldKey = await keys.opsKeyFor('notes', 'prod')
		clock.now = T0 + 15 * DAY
		const rotated = await deploy('succeeded')
		expect(rotated).toHaveLength(2)
		expect(rotated[0]).toBe(old)
		const fresh = rotated[1]
		// The rotating deploy succeeded, so Control now calls with the new key, which its running version accepts.
		const newKey = await keys.opsKeyFor('notes', 'prod')
		expect(newKey).not.toBe(oldKey)
		expect(opsKeyDigest(newKey ?? '')).toBe(fresh)
		clock.now = T0 + 16 * DAY
		expect(await deploy('succeeded')).toEqual([fresh])
	})

	test('a failed rotating deploy keeps the old key usable, and the next deploy hands both again', async () => {
		const { clock, keys, deploy } = await setup()
		const [old] = await deploy('succeeded')
		const oldKey = await keys.opsKeyFor('notes', 'prod')
		clock.now = T0 + 20 * DAY
		const rotated = await deploy('failed')
		expect(rotated).toHaveLength(2)
		// The running version holds only the old digest, so Control keeps calling with the old key.
		expect(await keys.opsKeyFor('notes', 'prod')).toBe(oldKey)
		// Another failure keeps both again and rotates no further.
		expect(await deploy('failed')).toEqual(rotated)
		expect(await keys.opsKeyFor('notes', 'prod')).toBe(oldKey)
		expect(await deploy('succeeded')).toEqual(rotated)
		expect(opsKeyDigest((await keys.opsKeyFor('notes', 'prod')) ?? '')).toBe(rotated[1])
		expect(await deploy('succeeded')).toEqual([rotated[1]])
		expect(rotated[0]).toBe(old)
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
		const { clock, keys, deploy } = await setup()
		const first = await deploy('failed')
		clock.now = T0 + 40 * DAY
		expect(await deploy('failed')).toEqual(first)
		expect(await keys.opsKeyFor('notes', 'prod')).toBeNull()
		expect(await deploy('succeeded')).toEqual(first)
		expect(opsKeyDigest((await keys.opsKeyFor('notes', 'prod')) ?? '')).toBe(first[0])
	})

	test('a dry or other run that succeeds after the handing run failed accepts nothing', async () => {
		const { clock, keys, deploy, run, settle } = await setup()
		await deploy('succeeded')
		const oldKey = await keys.opsKeyFor('notes', 'prod')
		clock.now = T0 + 15 * DAY
		await deploy('failed')
		// A dry run issues nothing, so its success says nothing about the keys.
		settle(await run(), 'succeeded')
		expect(await keys.opsKeyFor('notes', 'prod')).toBe(oldKey)
	})
})

describe('reconcileOpsKey', () => {
	test('an installation without a vault cannot keep an ops key, so a gated deploy fails', async () => {
		await expect(reconcileOpsKey({}, 'notes', 'prod', uuidv7())).rejects.toThrow('FABRIKA_CONTROL_VAULT_KEY')
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
		const db = fixture.db
		const { registry, runs, opsKeys } = createControlRepositories(db)
		await registry.createApp({ id: 'notes', repoUrl: 'github.com/acme/notes' })
		await registry.upsertAppEnv({
			appId: 'notes',
			env: 'prod',
			namespaceId: null,
			provider: 'test',
			providerTargetJson: '{}',
			providerArtifactJson: '{}',
		})
		const clock = { now: T0 }
		const vault = await Vault.create(db, KEY)
		const keys = new VaultOpsKeys(opsKeys, () => Promise.resolve(vault), () => clock.now)
		const deploy = async (status: 'succeeded' | 'failed'): Promise<string> => {
			const id = uuidv7()
			await runs.createRun({ id, appId: 'notes', env: 'prod', ref: 'refs/heads/main', trigger: 'manual', actor: 'user:test' })
			const digests = await keys.reconcile('notes', 'prod', id)
			await db.prepare('UPDATE runs SET status = ? WHERE id = ?').bind(status, id).run()
			return digests
		}
		const old = await deploy('succeeded')
		const oldKey = await keys.opsKeyFor('notes', 'prod')
		clock.now = T0 + 15 * DAY
		const rotated = await deploy('failed')
		expect(rotated.startsWith(`${old},`)).toBe(true)
		expect(await keys.opsKeyFor('notes', 'prod')).toBe(oldKey)
		expect(await deploy('succeeded')).toBe(rotated)
		const fresh = rotated.slice(old.length + 1)
		expect(opsKeyDigest((await keys.opsKeyFor('notes', 'prod')) ?? '')).toBe(fresh)
		expect(await deploy('succeeded')).toBe(fresh)
	})
})
