// The device authorization statements on both engines: a start refused on a taken code, a poll admitted once per
// interval, a decision and a redemption that each happen once, a grant without a code, and the prune. Postgres runs
// when FABRIKA_TEST_POSTGRES_URL is set and skips cleanly otherwise.

import { uuidv7 } from '@fabrika/platform'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createPostgresIamRepositories, type IamRepositories } from '../db'
import { unixNow } from '../repositories/sql'
import { createHarness } from './helpers/harness'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

if (!hasPostgres) {
	console.warn(`oauth-device-repository.test.ts ${skipReason}`)
}

let postgres: PostgresFixture | null = null

beforeAll(async () => {
	if (hasPostgres) postgres = await createPostgres('iam_oauth_device')
})

afterAll(async () => {
	await postgres?.close()
})

const engines: { name: string; repositories: () => IamRepositories; skip: boolean }[] = [
	{ name: 'SQLite', repositories: () => createHarness().repositories, skip: false },
	{
		name: 'Postgres',
		repositories: () => {
			if (postgres === null) throw new Error('postgres')
			return createPostgresIamRepositories(postgres.db)
		},
		skip: !hasPostgres,
	},
]

function attempt(now: number) {
	const id = uuidv7()
	return {
		device_code_hash: `device-${id}`,
		user_code_hash: `user-${id}`,
		client_id: 'fabrika-cli',
		app: 'control',
		resources: '["https://control.example.test/api/rpc"]',
		scopes: '["deploy:alpha"]',
		interval_seconds: 5,
		created_at: now,
		expires_at: now + 300,
	}
}

for (const engine of engines) {
	describe.skipIf(engine.skip)(`device authorizations (${engine.name})`, () => {
		test('a taken code is refused, a poll is admitted once per interval, and each refused poll adds five seconds', async () => {
			const repositories = engine.repositories()
			const now = unixNow()
			const row = attempt(now)
			expect(await repositories.oauth.startDeviceAuthorization(row)).toBe(true)
			expect(await repositories.oauth.startDeviceAuthorization({ ...attempt(now), user_code_hash: row.user_code_hash })).toBe(false)
			expect(await repositories.oauth.startDeviceAuthorization({ ...attempt(now), device_code_hash: row.device_code_hash })).toBe(false)

			expect(await repositories.oauth.admitDevicePoll(row.device_code_hash, now)).toBe(true)
			expect(await repositories.oauth.admitDevicePoll(row.device_code_hash, now + 1)).toBe(false)
			expect((await repositories.oauth.deviceAuthorization(row.device_code_hash))?.interval_seconds).toBe(10)
			// The next poll is due a lengthened interval after the refused one, less a second of tolerance.
			expect(await repositories.oauth.admitDevicePoll(row.device_code_hash, now + 9)).toBe(false)
			expect(await repositories.oauth.admitDevicePoll(row.device_code_hash, now + 9 + 14)).toBe(true)
		})

		test('an attempt is decided once and redeemed once, and the grant it gives is written without a code', async () => {
			const repositories = engine.repositories()
			const principal = await repositories.principals.createUser(uuidv7(), `${uuidv7()}@example.test`)
			const now = unixNow()
			const sessionId = await repositories.sessions.createSession({
				tokenHash: uuidv7(),
				principalId: principal.id,
				authenticationMethod: 'password',
				expiresAt: now + 3600,
			})
			const row = attempt(now)
			await repositories.oauth.startDeviceAuthorization(row)
			expect(await repositories.oauth.pendingDeviceAuthorization(row.user_code_hash, now)).not.toBeNull()
			const approval = { principalId: principal.id, sessionId, grantExpiresAt: now + 3600 }
			expect(await repositories.oauth.approveDeviceAuthorization(row.user_code_hash, approval, now)).toBe(true)
			expect(await repositories.oauth.approveDeviceAuthorization(row.user_code_hash, approval, now)).toBe(false)
			expect(await repositories.oauth.denyDeviceAuthorization(row.user_code_hash, now)).toBe(false)
			expect(await repositories.oauth.pendingDeviceAuthorization(row.user_code_hash, now)).toBeNull()

			const grantId = uuidv7()
			const claimed = await repositories.oauth.claimDeviceAuthorization(row.device_code_hash, grantId, now)
			expect(claimed?.principal_id).toBe(principal.id)
			expect(claimed?.grant_id).toBe(grantId)
			expect(await repositories.oauth.claimDeviceAuthorization(row.device_code_hash, uuidv7(), now)).toBeNull()

			await repositories.oauth.createGrant(
				{
					id: grantId,
					principal_id: principal.id,
					session_id: sessionId,
					client_id: 'fabrika-cli',
					app: 'control',
					resource: 'https://control.example.test/api/rpc',
					resources: '["https://control.example.test/api/rpc"]',
					scopes: '["deploy:alpha"]',
					created_at: now,
					expires_at: now + 3600,
					revoked_at: null,
				},
				null,
				{
					requestId: 'request-device',
					principalId: principal.id,
					principalLabel: principal.id,
					app: 'propustka',
					action: 'iam.oauth.grant.create',
					resourceType: 'oauth_grant',
					resourceId: grantId,
				},
			)
			expect((await repositories.oauth.grant(grantId))?.session_id).toBe(sessionId)
			const events = await repositories.audit.listAuditEvents({ principalId: principal.id, limit: 10 })
			expect(events.map((event) => event.action)).toEqual(['iam.oauth.grant.create'])
		})

		test('a denial ends a pending attempt, an expired one is decided by nobody, and the prune removes it', async () => {
			const repositories = engine.repositories()
			const now = unixNow()
			const denied = attempt(now)
			await repositories.oauth.startDeviceAuthorization(denied)
			expect(await repositories.oauth.denyDeviceAuthorization(denied.user_code_hash, now)).toBe(true)
			expect((await repositories.oauth.deviceAuthorization(denied.device_code_hash))?.status).toBe('denied')

			const late = attempt(now - 600)
			await repositories.oauth.startDeviceAuthorization(late)
			expect(await repositories.oauth.pendingDeviceAuthorization(late.user_code_hash, now)).toBeNull()
			expect(await repositories.oauth.denyDeviceAuthorization(late.user_code_hash, now)).toBe(false)
			await repositories.oauth.prune(now)
			expect(await repositories.oauth.deviceAuthorization(late.device_code_hash)).toBeNull()
			expect(await repositories.oauth.deviceAuthorization(denied.device_code_hash)).not.toBeNull()
		})
	})
}
