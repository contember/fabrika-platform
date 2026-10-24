// The installation's minimum password length (ADR-0020): an installation administrator sets it through `/admin/rpc`,
// IAM holds it to the runtime's floor, each change writes `iam.password_policy.update` in its own statement group, and
// the set-password pages state it and apply it at the next enrollment or reset. Every suite runs on SQLite and, with
// FABRIKA_TEST_POSTGRES_URL, on Postgres.

import { IAM_APP_ID, IAM_APP_SCHEMA, PASSWORD_DEFAULT_MIN_LENGTH, USER_ADMIN_ROLE } from '@fabrika/iam-contract'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { INSTALLATION_PRESENTATION } from '../app-presentation'
import { handleAuth } from '../auth/routes'
import { createPostgresIamRepositories, type IamRepositories, PasswordPolicyRepository, type PasswordPolicyRow } from '../db'
import { prop } from '../json'
import { type PasswordHasher, type StoredPasswordHash, WORKERS_PBKDF2_COST } from '../password-crypto'
import { issuePasswordAction } from '../password-service'
import { hashToken } from '../secret'
import { consoleRpc, errorType, result } from './helpers/app-people'
import { createHarness, TestSqlDatabase } from './helpers/harness'
import { CALLER_ENV, type MembershipFixture, membershipFixture, ORIGIN, PendingWork } from './helpers/membership'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

class PlainHasher implements PasswordHasher {
	async hash(password: string): Promise<StoredPasswordHash> {
		return { algorithm: 'test', parameters: '{}', salt: 'salt', passwordHash: `hash:${password}` }
	}

	async verify(password: string, stored: StoredPasswordHash) {
		return { valid: stored.passwordHash === `hash:${password}`, needsRehash: false }
	}
}

const SERVICES = { authentication: { oidc: false, password: true }, passwordHasher: new PlainHasher() }
/** `adminRpc` builds its own IAM from variables: a Bun one with password sign-in, like the pages' `SERVICES`. */
const ADMIN_ENV = { PASSWORD_ENABLED: 'true' }
/** The same on a Worker, whose verifiers are cheaper (backlog 201), so its floor is the default. */
const WORKER = {
	services: { ...SERVICES, passwordMinLengthFloor: PASSWORD_DEFAULT_MIN_LENGTH },
	adminEnv: { ...ADMIN_ENV, PASSWORD_COST: WORKERS_PBKDF2_COST },
}

async function call(f: MembershipFixture, method: string, input: unknown): Promise<{ status: number; body: unknown }> {
	const response = await f.adminRpc(method, input)
	return { status: response.status, body: await response.json() }
}

async function policyEvents(repositories: IamRepositories) {
	return repositories.audit.listAuditEvents({ action: 'iam.password_policy.update', limit: 20 })
}

function post(path: string, fields: Record<string, string>): Request {
	return new Request(`${ORIGIN}${path}`, {
		method: 'POST',
		headers: { Origin: 'null', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(fields),
	})
}

/** A person with a pending action of `purpose`, and the token its link carries. */
async function pendingAction(f: MembershipFixture, purpose: 'enrollment' | 'reset'): Promise<{ principalId: string; token: string }> {
	const tag = crypto.randomUUID()
	const created = await f.repositories.principals.inviteUser(`person-${tag}@example.test`, `person-${tag}@example.test`)
	await f.repositories.passwords.enableEnrollment(created.id)
	const principal = await f.repositories.principals.getPrincipalById(created.id)
	if (principal === null) throw new Error('missing principal')
	const action = await issuePasswordAction(f.services, { principal, purpose, presentation: INSTALLATION_PRESENTATION }, {
		audit: { requestId: 'seed', principalId: null, principalLabel: 'seed', app: 'propustka', action: 'seed.issue', resourceType: 'principal' },
		enableEnrollment: false,
	})
	const token = new URLSearchParams(new URL(action.url).hash.slice(1)).get('token')
	if (token === null) throw new Error('missing action token')
	return { principalId: principal.id, token }
}

async function send(f: MembershipFixture, request: Request): Promise<Response> {
	return handleAuth(request, f.services, CALLER_ENV, new PendingWork())
}

function minimumSuite(label: string, engine: () => Promise<IamRepositories>) {
	describe(`the installation's minimum password length (${label})`, () => {
		test('round trip: the default, set, read back; a change writes iam.password_policy.update, a repeat writes nothing', async () => {
			const repositories = await engine()
			const f = await membershipFixture(repositories, { services: SERVICES, adminEnv: ADMIN_ENV })

			expect(result((await call(f, 'passwordPolicy.get', null)).body)).toEqual({
				minLength: PASSWORD_DEFAULT_MIN_LENGTH,
				defaultMinLength: PASSWORD_DEFAULT_MIN_LENGTH,
				minLengthFloor: 4,
				maxLength: 256,
				passwordEnabled: true,
				updatedAt: null,
			})

			const set = await call(f, 'passwordPolicy.set', { minLength: 10 })
			expect(set.status).toBe(200)
			expect(field(set.body, 'minLength')).toBe(10)
			expect(typeof field(set.body, 'updatedAt')).toBe('number')
			expect(result((await call(f, 'passwordPolicy.get', null)).body)).toEqual(result(set.body))

			expect(field((await call(f, 'passwordPolicy.set', { minLength: 10 })).body, 'minLength')).toBe(10)
			expect(field((await call(f, 'passwordPolicy.set', { minLength: 5 })).body, 'minLength')).toBe(5)

			const events = await policyEvents(repositories)
			expect(events.map((event) => [event.resource_type, event.metadata])).toEqual([
				['password_policy', JSON.stringify({ minLength: 5 })],
				['password_policy', JSON.stringify({ minLength: 10 })],
			])
		})

		test('a value outside 4 to 256, not a whole number, or with another field is refused, and nothing is stored', async () => {
			const repositories = await engine()
			const f = await membershipFixture(repositories, { services: SERVICES, adminEnv: ADMIN_ENV })
			for (const input of [{ minLength: 3 }, { minLength: 257 }, { minLength: 7.5 }, { minLength: '8' }, { minLength: 8, extra: true }, {}]) {
				const refused = await call(f, 'passwordPolicy.set', input)
				expect([JSON.stringify(input), refused.status, errorType(refused.body)]).toEqual([JSON.stringify(input), 400, 'validation'])
			}
			expect(field((await call(f, 'passwordPolicy.get', null)).body, 'updatedAt')).toBeNull()
			expect(await policyEvents(repositories)).toEqual([])
		})

		test('a user administrator is refused both, and the minimum stays as it was', async () => {
			const repositories = await engine()
			const f = await membershipFixture(repositories, { services: SERVICES, adminEnv: ADMIN_ENV })
			expect((await f.putSchema(IAM_APP_SCHEMA, IAM_APP_ID)).status).toBe(200)
			await call(f, 'passwordPolicy.set', { minLength: 9 })
			const userAdmin = await repositories.principals.createUser(`sub-policy-${crypto.randomUUID()}`, `policy-${crypto.randomUUID()}@example.test`)
			await repositories.grants.createRoleGrantUnlessHeld({ principalId: userAdmin.id, app: IAM_APP_ID, roleKey: USER_ADMIN_ROLE })
			expect((await consoleRpc(f, userAdmin.id, 'me', null)).status).toBe(200)

			for (const [method, input] of [['passwordPolicy.get', null], ['passwordPolicy.set', { minLength: 4 }]] as const) {
				const refused = await consoleRpc(f, userAdmin.id, method, input)
				expect([method, refused.status, errorType(refused.body)]).toEqual([method, 403, 'forbidden'])
			}
			expect(field((await call(f, 'passwordPolicy.get', null)).body, 'minLength')).toBe(9)
			expect((await policyEvents(repositories)).length).toBe(1)
		})

		for (const purpose of ['enrollment', 'reset'] as const) {
			test(`the ${purpose} page states the installation's minimum and applies it at submission`, async () => {
				const repositories = await engine()
				const f = await membershipFixture(repositories, { services: SERVICES, adminEnv: ADMIN_ENV })
				const path = purpose === 'enrollment' ? '/auth/password/enroll' : '/auth/password/reset'

				// The default first: a 10-character password is too short for it.
				const before = await pendingAction(f, purpose)
				expect(await (await send(f, new Request(`${ORIGIN}${path}`))).text()).toContain('Use 15–256 characters.')
				const tooShortForDefault = await send(f, post(path, { token: before.token, password: 'tulip-42xy' }))
				expect(tooShortForDefault.status).toBe(400)
				expect(await tooShortForDefault.text()).toContain('Use at least 15 characters.')

				await call(f, 'passwordPolicy.set', { minLength: 10 })
				expect(await (await send(f, new Request(`${ORIGIN}${path}`))).text()).toContain('Use 10–256 characters.')
				const nine = await send(f, post(path, { token: before.token, password: 'tulip-42x' }))
				expect(nine.status).toBe(400)
				expect(await nine.text()).toContain('Use at least 10 characters.')
				// A common password of the length is refused as guessable, whatever the minimum.
				const common = await send(f, post(path, { token: before.token, password: 'basketball' }))
				expect(common.status).toBe(400)
				expect(await common.text()).toContain('not based on your account details or a common password')

				const ten = await send(f, post(path, { token: before.token, password: 'tulip-42xy' }))
				expect(ten.status).toBe(302)
				expect((await repositories.passwords.getAccount(before.principalId))?.state).toBe('enabled')
			})
		}
	})
}

/** A field of an RPC answer's result. */
function field(body: unknown, key: string): unknown {
	return prop(result(body), key)
}

describe('the minimum on a runtime with cheaper verifiers', () => {
	test('a Worker keeps the default as its floor: below it is refused with the reason, above it is stored', async () => {
		const h = createHarness()
		const f = await membershipFixture(h.repositories, WORKER)
		expect(field((await call(f, 'passwordPolicy.get', null)).body, 'minLengthFloor')).toBe(PASSWORD_DEFAULT_MIN_LENGTH)
		const refused = await call(f, 'passwordPolicy.set', { minLength: 8 })
		expect(refused.status).toBe(400)
		expect(JSON.stringify(refused.body)).toContain('cannot be below 15 on this installation')
		expect(field((await call(f, 'passwordPolicy.set', { minLength: 20 })).body, 'minLength')).toBe(20)
	})

	test('a stored minimum below the floor applies the default on the page, never the stored value', async () => {
		const h = createHarness()
		const f = await membershipFixture(h.repositories, WORKER)
		await new TestSqlDatabase(h.sqlite).prepare('INSERT INTO password_policy (id, min_length, updated_at) VALUES (1, 6, 1700000000)').run()
		expect(await (await send(f, new Request(`${ORIGIN}/auth/password/enroll`))).text()).toContain('Use 15–256 characters.')
		expect(field((await call(f, 'passwordPolicy.get', null)).body, 'minLength')).toBe(PASSWORD_DEFAULT_MIN_LENGTH)
	})
})

describe('a minimum that cannot be read', () => {
	test('fails the request instead of applying a default: no password is stored and the link stays unspent', async () => {
		const h = createHarness()
		class Unreadable extends PasswordPolicyRepository {
			override get(): Promise<PasswordPolicyRow | null> {
				return Promise.reject(new Error('injected fault'))
			}
		}
		const repositories = { ...h.repositories, passwordPolicy: new Unreadable(new TestSqlDatabase(h.sqlite)) }
		const f = await membershipFixture(repositories, { services: SERVICES, adminEnv: ADMIN_ENV })
		const { principalId, token } = await pendingAction(f, 'enrollment')
		// An installation that raised the minimum to 20 must not get a 15-character password because one read failed.
		await expect(send(f, post('/auth/password/enroll', { token, password: 'tulip-42xy-tulip' }))).rejects.toThrow('injected fault')
		expect((await repositories.passwords.getAccount(principalId))?.state).not.toBe('enabled')
		expect(await repositories.passwords.inspectActionToken(await hashToken(token), 'enrollment')).not.toBeNull()
	})
})

minimumSuite('SQLite', async () => createHarness().repositories)

if (!hasPostgres) {
	console.warn(`password-minimum.test.ts ${skipReason}`)
}

describe.skipIf(!hasPostgres)('on Postgres', () => {
	let fixture: PostgresFixture | null = null
	beforeAll(async () => {
		fixture = await createPostgres('iam_password_minimum')
	})
	afterAll(async () => {
		await fixture?.close()
	})
	// The minimum is one row of the installation, so each test starts from none on the shared schema.
	minimumSuite('Postgres', async () => {
		if (fixture === null) throw new Error('fixture')
		await fixture.db.prepare('DELETE FROM password_policy').run()
		await fixture.db.prepare(`DELETE FROM audit_events WHERE action = 'iam.password_policy.update'`).run()
		return createPostgresIamRepositories(fixture.db)
	})
})
