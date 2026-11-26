// The installation-wide domain uniqueness against a REAL Postgres: `idx_app_envs_domain` refuses the write that lost a
// race to the registry check, and the conflict is read after the rolled-back transaction. `domain-ownership.test.ts`
// proves the same on SQLite/D1.
//
// Skips cleanly (with a reason) when FABRIKA_TEST_POSTGRES_URL is unset — see helpers/postgres.ts.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { AppEnvDomainConflictError, type ControlRepositories, createControlRepositories } from '../db'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

if (!hasPostgres) {
	console.warn(`registry-domain-postgres.test.ts ${skipReason}`)
}

let fixture: PostgresFixture | null = null
let db: ControlRepositories

beforeAll(async () => {
	if (!hasPostgres) return
	fixture = await createPostgres('control_domain')
	db = createControlRepositories(fixture.db)
})

afterAll(async () => {
	await fixture?.close()
})

const envelope = (payload: Record<string, string>): string => JSON.stringify({ provider: 'harbor', version: 1, payload })

const environment = (appId: string, env: string, domain: string | null, kind?: 'dev') => ({
	appId,
	env,
	domain,
	...(kind === undefined ? {} : { kind }),
	namespaceId: null,
	provider: 'harbor',
	providerTargetJson: envelope({ region: 'eu' }),
	providerArtifactJson: envelope({ image: `registry.example/${appId}:v1` }),
})

describe.skipIf(!hasPostgres)('domain uniqueness on Postgres', () => {
	test('a second environment on a held domain, in any case, is a typed conflict and writes nothing', async () => {
		await db.registry.createApp({ id: 'shop', repoUrl: 'github.com/acme/shop' })
		await db.registry.createApp({ id: 'other', repoUrl: 'github.com/acme/other' })
		await db.registry.upsertAppEnv(environment('shop', 'prod', 'shop.example.com'))

		const write = db.registry.upsertAppEnv(environment('other', 'prod', 'SHOP.example.com'), { absent: true })

		await expect(write).rejects.toBeInstanceOf(AppEnvDomainConflictError)
		expect(await db.registry.getAppEnv('other', 'prod')).toBeNull()
	})

	test('an existing environment moved onto a held domain keeps its own', async () => {
		const other = await db.registry.upsertAppEnv(environment('other', 'stage', 'other.example.com'))

		const write = db.registry.upsertAppEnv(environment('other', 'stage', 'shop.example.com'), { generation: other.generation })

		await expect(write).rejects.toMatchObject({ name: 'AppEnvDomainConflictError', domain: 'shop.example.com' })
		expect((await db.registry.getAppEnv('other', 'stage'))?.domain).toBe('other.example.com')
	})

	test('environments without a domain, and the dev environments of two applications on one base, do not conflict', async () => {
		await db.registry.upsertAppEnv(environment('shop', 'qa', null))
		await db.registry.upsertAppEnv(environment('other', 'qa', null))
		await db.registry.upsertAppEnv(environment('shop', 'dev', 'dev.example.com', 'dev'))
		await db.registry.upsertAppEnv(environment('other', 'dev', 'dev.example.com', 'dev'))
		expect((await db.registry.getAppEnv('other', 'dev'))?.domain).toBe('dev.example.com')
	})
})
