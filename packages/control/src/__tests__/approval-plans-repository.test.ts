// The publication's compare-and-swap with approval plan entries (ADR-0050 §5), against SQLite always and Postgres when
// FABRIKA_TEST_POSTGRES_URL is set: the swap needs each named entry active, unexpired and of the run's environment, and
// consumes them in the same batch, so an entry revoked, expired, of another environment or used once fails it.

import { type SqlDatabase, uuidv7 } from '@fabrika/platform'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { type ControlRepositories, createControlRepositories } from '../db'
import { createHarness, type Harness } from './helpers/harness'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

const T0 = 1_800_000_000
const DAY = 86_400
const HASH = `sha256:${'0'.repeat(64)}`
const ADA = { id: 'p-ada', label: 'ada@example.test', stepUp: null }

function publicationContract(database: () => SqlDatabase): void {
	let clock = T0
	let repositories: ControlRepositories
	let appId: string

	beforeEach(async () => {
		clock = T0
		repositories = createControlRepositories(database(), { now: () => clock })
		appId = `app${uuidv7().replaceAll('-', '').slice(-12)}`
		await repositories.registry.createApp({ id: appId, repoUrl: `github.com/acme/${appId}` })
		for (const env of ['prod', 'stage']) {
			await repositories.registry.upsertAppEnv({
				appId,
				env,
				namespaceId: null,
				provider: 'test',
				providerTargetJson: '{}',
				providerArtifactJson: '{}',
			})
		}
	})

	/** An approved plan on `env` with one entry, active until `days` from now; its entry's id. */
	async function approvedEntry(env: string, days = 30): Promise<{ plan: string; entry: string }> {
		const plan = uuidv7()
		const entry = uuidv7()
		await repositories.approvalPlans.create({
			id: plan,
			appId,
			env,
			commitSha: 'a'.repeat(40),
			requester: { id: 'p-ada', type: 'user', label: 'ada', credential: 'console', clientId: null, grantId: null },
			outcome: 'widening',
			changesJson: '[]',
			candidateDigest: HASH,
			baselineDigest: HASH,
			baselineRunId: null,
			ttlSeconds: DAY,
			entries: [{ id: entry, subject: 'role:editor', beforeHash: HASH, afterHash: HASH, lines: [HASH] }],
		})
		expect(await repositories.approvalPlans.approve(plan, ADA, null, clock + days * DAY)).toBe(true)
		return { plan, entry }
	}

	/** A running run of `prod` with a snapshot, holding the environment's lease; its id and fence. */
	async function runningRun(): Promise<{ id: string; fence: { holder: string; nowMs: number } }> {
		const id = uuidv7()
		await repositories.runs.createRun({ id, appId, env: 'prod', ref: 'refs/heads/main', trigger: 'manual', actor: 'user:p-ada' })
		await database().prepare(`UPDATE runs SET status = 'running', snapshot_json = '{}' WHERE id = ?`).bind(id).run()
		const holder = `holder-${id}`
		const nowMs = clock * 1000
		await database().prepare('DELETE FROM deploy_locks WHERE lock_key = ?').bind(`${appId}:prod`).run()
		await database().prepare('INSERT INTO deploy_locks (lock_key, holder, expires_at) VALUES (?, ?, ?)').bind(`${appId}:prod`, holder, nowMs + 90_000)
			.run()
		return { id, fence: { holder, nowMs } }
	}

	async function expected(): Promise<{ generation: number; protectionRevision: number }> {
		const row = await repositories.registry.getAppEnv(appId, 'prod')
		if (row === null) throw new Error('prod exists')
		return { generation: row.generation, protectionRevision: row.protection_revision }
	}

	async function publish(entries: readonly string[]): Promise<{ published: boolean; run: string }> {
		const run = await runningRun()
		return { published: await repositories.runs.publishRunSnapshot(run.id, await expected(), '{"published":true}', run.fence, entries), run: run.id }
	}

	async function entryState(plan: string): Promise<{ state: string; consumed_by_run: string | null }[]> {
		return (await repositories.approvalPlans.entries(plan)).map((entry) => ({ state: entry.state, consumed_by_run: entry.consumed_by_run }))
	}

	test('without entries it publishes as before', async () => {
		const { published, run } = await publish([])
		expect(published).toBe(true)
		expect((await repositories.registry.getAppEnv(appId, 'prod'))?.published_run_id).toBe(run)
	})

	test('an active entry of the environment publishes and is consumed by the run; a second publication with it loses', async () => {
		const { plan, entry } = await approvedEntry('prod')
		const first = await publish([entry])
		expect(first.published).toBe(true)
		expect(await entryState(plan)).toEqual([{ state: 'consumed', consumed_by_run: first.run }])
		const second = await publish([entry])
		expect(second.published).toBe(false)
		expect((await repositories.registry.getAppEnv(appId, 'prod'))?.published_run_id).toBe(first.run)
	})

	test('a revoked, an expired, or another environment’s entry fails the swap and changes nothing', async () => {
		const revoked = await approvedEntry('prod')
		expect(await repositories.approvalPlans.revoke(revoked.plan, ADA)).toBe(true)
		const expiring = await approvedEntry('prod', 1)
		const stage = await approvedEntry('stage')
		const before = await expected()
		clock += 2 * DAY
		for (const entry of [revoked.entry, expiring.entry, stage.entry]) {
			expect((await publish([entry])).published).toBe(false)
		}
		expect(await expected()).toEqual(before)
		expect((await repositories.registry.getAppEnv(appId, 'prod'))?.published_run_id).toBeNull()
		expect(await entryState(revoked.plan)).toEqual([{ state: 'revoked', consumed_by_run: null }])
		expect(await entryState(expiring.plan)).toEqual([{ state: 'active', consumed_by_run: null }])
		expect(await entryState(stage.plan)).toEqual([{ state: 'active', consumed_by_run: null }])
	})

	test('the open plans page newest first, older than the cursor', async () => {
		const plans = [await approvedEntry('prod'), await approvedEntry('stage'), await approvedEntry('prod')].map((p) => p.plan)
		const newest = [...plans].reverse()
		const first = await repositories.approvalPlans.listOpen(2)
		expect(first.map((row) => row.id)).toEqual(newest.slice(0, 2))
		// On Postgres the earlier tests' plans are older and still open, so the second page may hold one of them.
		const rest = await repositories.approvalPlans.listOpen(2, first[1]?.id ?? null)
		expect(rest.map((row) => row.id).filter((id) => plans.includes(id))).toEqual(newest.slice(2))
	})

	test('one entry that fails fails the swap for all: the good one stays active', async () => {
		const good = await approvedEntry('prod')
		const revoked = await approvedEntry('prod')
		expect(await repositories.approvalPlans.revoke(revoked.plan, ADA)).toBe(true)
		expect((await publish([good.entry, revoked.entry])).published).toBe(false)
		expect(await entryState(good.plan)).toEqual([{ state: 'active', consumed_by_run: null }])
	})
}

describe('the publication with plan entries on SQLite', () => {
	let harness: Harness
	beforeEach(() => {
		harness = createHarness()
	})
	afterEach(() => harness.sqlite.close())

	publicationContract(() => harness.d1)
})

if (!hasPostgres) console.warn(`approval-plans-repository.test.ts ${skipReason}`)

let fixture: PostgresFixture
beforeAll(async () => {
	if (hasPostgres) fixture = await createPostgres('approval_plans')
})
afterAll(async () => {
	if (hasPostgres) await fixture.close()
})

describe.skipIf(!hasPostgres)('the publication with plan entries on Postgres', () => {
	publicationContract(() => fixture.db)
})
