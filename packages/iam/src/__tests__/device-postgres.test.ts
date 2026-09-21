import { type DeviceAuthorizationConsent, uuidv7 } from '@fabrika/auth-core'
import { PostgresDatabase } from '@fabrika/platform-node'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createIamRepositories, type IamRepositories } from '../db'
import { pkceChallenge, randomToken } from '../oidc'
import { hashToken } from '../secret'
import { createPostgres, hasPostgres, type PostgresFixture, postgresUrl, skipReason } from './helpers/postgres'

if (!hasPostgres) console.warn(`device-postgres.test.ts ${skipReason}`)
let fixture: PostgresFixture | null = null
let pool: PostgresDatabase | null = null
let repositories: IamRepositories

beforeAll(async () => {
	if (postgresUrl === null) return
	fixture = await createPostgres('iam_device')
	pool = PostgresDatabase.connect(postgresUrl, { connection: { search_path: fixture.schema }, max: 4 })
	repositories = createIamRepositories(pool)
})
afterAll(async () => {
	await pool?.close()
	await fixture?.close()
})

async function approved() {
	const principal = await repositories.principals.createUser(uuidv7(), `${uuidv7()}@example.test`)
	const input = {
		app: 'vozka',
		label: 'Postgres pairing',
		permissions: ['app.manage'],
		keyLifetimeSeconds: 2592000,
		approvalChallenge: await pkceChallenge(randomToken(32)),
		redemptionChallenge: await pkceChallenge(randomToken(32)),
	}
	const started = await repositories.device.start(input)
	const consent: DeviceAuthorizationConsent = {
		app: input.app,
		label: input.label,
		permissions: input.permissions,
		scope: { type: 'app', value: uuidv7() },
		consentId: uuidv7(),
		keyExpiresAt: Math.floor(Date.now() / 1000) + input.keyLifetimeSeconds,
	}
	await repositories.device.approve(started.attemptId, principal.id, consent)
	return {
		attemptId: started.attemptId,
		consentId: consent.consentId,
		tokenHash: await hashToken(randomToken()),
		requestId: uuidv7(),
		approverLabel: principal.label,
	}
}

describe.skipIf(!hasPostgres)('device repository on real Postgres', () => {
	test('independent pooled transactions elect one RETURNING winner and retain one complete receipt', async () => {
		const input = await approved()
		const results = await Promise.all(Array.from({ length: 16 }, () => repositories.device.issue(input)))
		const winners = results.filter((result) => result !== null)
		expect(winners).toHaveLength(1)
		const receipt = await repositories.device.get(input.attemptId)
		expect(receipt?.status).toBe('issued')
		expect(typeof receipt?.issued_at).toBe('number')
		expect(typeof receipt?.key_expires_at).toBe('number')
		const credential = receipt?.credential_id ? await repositories.credentials.getCredentialById(receipt.credential_id) : null
		expect(credential?.token_hash).toBe(input.tokenHash)
		expect(await repositories.device.issue(input)).toBeNull()
	})

	test('a late audit constraint failure rolls back all prior writes and permits a clean retry', async () => {
		if (!pool) throw new Error('fixture missing')
		const input = await approved()
		const before = await pool.prepare('SELECT COUNT(*)::integer AS n FROM principals').first<{ n: number }>()
		await pool.prepare("ALTER TABLE audit_events ADD CONSTRAINT device_test_failure CHECK (action <> 'iam.credential.create') NOT VALID").run()
		try {
			await expect(repositories.device.issue(input)).rejects.toThrow()
			expect((await repositories.device.get(input.attemptId))?.claim_id).toBeNull()
			expect(await pool.prepare('SELECT COUNT(*)::integer AS n FROM principals').first<{ n: number }>()).toEqual(before)
			expect(await pool.prepare('SELECT id FROM credentials WHERE token_hash = ?').bind(input.tokenHash).first()).toBeNull()
		} finally {
			await pool.prepare('ALTER TABLE audit_events DROP CONSTRAINT device_test_failure').run()
		}
		expect((await repositories.device.issue(input))?.status).toBe('issued')
	})
})
