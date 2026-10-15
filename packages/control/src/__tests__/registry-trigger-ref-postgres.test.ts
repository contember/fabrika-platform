// The trigger-ref uniqueness of an app's environments against a REAL Postgres: a failed batch rolls back a whole
// transaction there, and the conflict is read after it. `registry.test.ts` proves the same on SQLite/D1.
//
// Skips cleanly (with a reason) when FABRIKA_TEST_POSTGRES_URL is unset — see helpers/postgres.ts.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { AppEnvTriggerRefConflictError, type ControlRepositories, createControlRepositories } from '../db'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

if (!hasPostgres) {
	console.warn(`registry-trigger-ref-postgres.test.ts ${skipReason}`)
}

let fixture: PostgresFixture | null = null
let db: ControlRepositories

beforeAll(async () => {
	if (!hasPostgres) return
	fixture = await createPostgres('vozka_trigger_ref')
	db = createControlRepositories(fixture.db)
})

afterAll(async () => {
	await fixture?.close()
})

const envelope = (payload: Record<string, string>): string => JSON.stringify({ provider: 'harbor', version: 1, payload })

const environment = (env: string, triggerRef: string) => ({
	appId: 'notes',
	env,
	triggerRef,
	namespaceId: null,
	provider: 'harbor',
	providerTargetJson: envelope({ region: 'eu' }),
	providerArtifactJson: envelope({ image: 'registry.example/notes:v1' }),
})

describe.skipIf(!hasPostgres)('trigger-ref uniqueness on Postgres', () => {
	test('a second environment on the same trigger ref is a typed conflict naming the first, and writes nothing', async () => {
		await db.registry.createApp({ id: 'notes', repoUrl: 'github.com/acme/notes' })
		await db.registry.upsertAppEnv(environment('prod', 'refs/heads/main'))

		const write = db.registry.upsertAppEnv(environment('stage', 'refs/heads/main'), { absent: true })

		await expect(write).rejects.toBeInstanceOf(AppEnvTriggerRefConflictError)
		await expect(write).rejects.toMatchObject({ env: 'stage', triggerRef: 'refs/heads/main', otherEnv: 'prod' })
		expect(await db.registry.getAppEnv('notes', 'stage')).toBeNull()
	})

	test('an existing environment moved onto a held trigger ref is the same conflict and keeps its own ref', async () => {
		const stage = await db.registry.upsertAppEnv(environment('stage', 'refs/heads/next'))

		const write = db.registry.upsertAppEnv(environment('stage', 'refs/heads/main'), { generation: stage.generation })

		await expect(write).rejects.toMatchObject({ name: 'AppEnvTriggerRefConflictError', otherEnv: 'prod' })
		expect((await db.registry.getAppEnv('notes', 'stage'))?.trigger_ref).toBe('refs/heads/next')
	})
})
