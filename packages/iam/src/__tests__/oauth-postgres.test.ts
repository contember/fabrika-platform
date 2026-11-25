import { parseAccessClaims } from '@fabrika/auth-core'
import { PostgresDatabase } from '@fabrika/platform-node'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { decodeJwt } from 'jose'
import { createPostgresIamRepositories, type IamRepositories } from '../db'
import { hashToken } from '../secret'
import { oauthFixture, tokenBody } from './helpers/oauth'
import { createPostgres, hasPostgres, type PostgresFixture, postgresUrl, skipReason } from './helpers/postgres'

if (!hasPostgres) console.warn(`oauth-postgres.test.ts ${skipReason}`)
let database: PostgresFixture | null = null
let pool: PostgresDatabase | null = null
let repositories: IamRepositories
let active: Awaited<ReturnType<typeof oauthFixture>> | null = null

beforeAll(async () => {
	if (postgresUrl === null) return
	database = await createPostgres('iam_oauth')
	pool = PostgresDatabase.connect(postgresUrl, { connection: { search_path: database.schema }, max: 4 })
	repositories = createPostgresIamRepositories(pool)
})
afterEach(() => {
	active?.restoreFetch()
	active = null
})
afterAll(async () => {
	await pool?.close()
	await database?.close()
})

describe.skipIf(!hasPostgres)('OAuth on real Postgres', () => {
	test('code → token → refresh, with narrowed permissions', async () => {
		active = await oauthFixture(repositories)
		const first = await tokenBody(await active.exchange(await active.approve()))
		const claims = parseAccessClaims(decodeJwt(first.access_token))
		expect(claims?.perms.map((entry) => entry.action).sort()).toEqual(['source.workspace.read', 'source.workspace.write'])
		const second = await tokenBody(await active.refresh(first.refresh_token ?? ''))
		expect(second.refresh_token).not.toBe(first.refresh_token)
	})

	test('concurrent redemptions of one code spend it once, and the replays revoke its grant', async () => {
		active = await oauthFixture(repositories)
		const code = await active.approve()
		const fixture = active
		const statuses = await Promise.all(Array.from({ length: 8 }, () => fixture.exchange(code).then((response) => response.status)))
		// The replays revoke the grant, and the mint re-checks it, so the one consumer may also lose.
		expect(statuses.filter((status) => status === 200).length).toBeLessThanOrEqual(1)
		const spent = await repositories.oauth.code(await hashToken(code))
		expect(spent?.used_at).not.toBeNull()
		const grant = await repositories.oauth.grant(spent?.grant_id ?? '')
		expect(grant?.revoked_at).not.toBeNull()
	})

	test('refresh reuse revokes the family', async () => {
		active = await oauthFixture(repositories)
		const first = await tokenBody(await active.exchange(await active.approve()))
		const second = await tokenBody(await active.refresh(first.refresh_token ?? ''))
		expect((await active.refresh(first.refresh_token ?? '')).status).toBe(400)
		expect((await active.refresh(second.refresh_token ?? '')).status).toBe(400)
	})

	test('concurrent presentations of one client assertion jti record it once', async () => {
		const expiresAt = Math.floor(Date.now() / 1000) + 60
		const recorded = await Promise.all(
			Array.from({ length: 8 }, () => repositories.oauth.recordClientAssertion('https://chatgpt.example.test/cimd', 'jti-concurrent', expiresAt)),
		)
		expect(recorded.filter(Boolean)).toHaveLength(1)
		expect(await repositories.oauth.recordClientAssertion('https://other.example.test/cimd', 'jti-concurrent', expiresAt)).toBe(true)
	})
})

describe.skipIf(!hasPostgres)('OAuth from the registry on real Postgres', () => {
	test("an external application's client signs a role holder in and refreshes, served from the registry alone", async () => {
		// Its own schema: the import mark makes the registry the only source for every client of the database.
		const registry = await createPostgres('iam_oauth_registry')
		try {
			const own = createPostgresIamRepositories(registry.db)
			const identity = { app: 'ops-tool', resource: 'https://ops.example.test', roles: [{ key: 'viewer', name: 'Viewer' }] }
			active = await oauthFixture(own, { provider: 'external', identity, registry: true })
			expect(active.config.clients).toEqual([])
			await own.grants.createGrant({ principalId: active.principal.id, app: identity.app, roleKey: 'viewer' })
			const location = (await active.decide('approve', { resource: identity.resource, scope: 'identity' })).headers.get('location')
			const code = location === null ? null : new URL(location).searchParams.get('code')
			const first = await tokenBody(await active.exchange(code ?? '', { resource: identity.resource }))
			expect(parseAccessClaims(decodeJwt(first.access_token))?.oauth?.roles).toEqual(['viewer'])
			const second = await tokenBody(await active.refresh(first.refresh_token ?? '', { resource: identity.resource }))
			expect(parseAccessClaims(decodeJwt(second.access_token))?.perms).toEqual([])
		} finally {
			active?.restoreFetch()
			active = null
			await registry.close()
		}
	})
})
