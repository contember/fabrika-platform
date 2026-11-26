// What Operations' security alerts read of `auth_log`, on SQLite and (with FABRIKA_TEST_POSTGRES_URL) on Postgres:
// which refusals count, per account and installation-wide, and which allowed sign-ins are privileged.

import type { SqlDatabase } from '@fabrika/platform'
import { afterAll, describe, expect, test } from 'bun:test'
import { createPostgresIamRepositories, type IamRepositories } from '../db'
import { COUNTED_KEY_REFUSAL, COUNTED_LOGIN_REFUSALS, signInSignals } from '../sign-in-signals'
import { createHarness, makeServicesFor, TestSqlDatabase } from './helpers/harness'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

if (!hasPostgres) {
	console.warn(`sign-in-signals.test.ts Postgres half ${skipReason}`)
}

const T = 1_800_000_000
const WINDOW = 15 * 60

interface Row {
	app: string
	kind?: 'authenticate' | 'logout'
	principalId: string | null
	decision: 'allow' | 'deny'
	reason: string
	privileged?: number
	at: number
}

async function seed(db: SqlDatabase, rows: Row[]): Promise<void> {
	for (const id of ['account-a', 'account-b']) {
		await db
			.prepare('INSERT INTO principals (id, type, external_id, email, label, disabled_at, activated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
			.bind(id, 'user', `sub-${id}`, `${id}@example.test`, `${id}@example.test`, null, T, T)
			.run()
	}
	for (const [index, row] of rows.entries()) {
		await db
			.prepare(`INSERT INTO auth_log (request_id, app, kind, principal_id, credential_id, decision, reason, privileged, created_at)
				VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`)
			.bind(`request-${index}`, row.app, row.kind ?? 'authenticate', row.principalId, row.decision, row.reason, row.privileged ?? 0, row.at)
			.run()
	}
}

const deny = (reason: string, principalId: string | null, app = 'propustka', at = T): Row => ({ app, principalId, decision: 'deny', reason, at })

const ROWS: Row[] = [
	...Array.from({ length: 3 }, () => deny('password_invalid', 'account-a')),
	deny('password_throttled', 'account-a'),
	deny('second_factor_invalid', 'account-b'),
	deny('password_invalid', null),
	deny('password_invalid', null),
	deny('invalid_key', null, 'notes@prod'),
	// Not a credential guess at IAM, or not at IAM at all: counted nowhere.
	deny('login_cross_origin', null),
	deny('password_malformed', null),
	deny('handoff_refused', null),
	deny('second_factor_expired', 'account-a'),
	deny('terminal_assertion_not_allowed', 'account-a'),
	deny('invalid_session', 'account-a', 'notes@prod'),
	deny('invalid_code', 'account-a', 'notes@prod'),
	deny('password_invalid', 'account-a', 'notes@prod'),
	// Outside the window.
	deny('password_invalid', 'account-a', 'propustka', T - WINDOW - 1),
	deny('password_invalid', 'account-a', 'propustka', T + 1),
	{ app: 'propustka', principalId: 'account-a', decision: 'allow', reason: 'password_login', privileged: 1, at: T - 10 },
	{ app: 'propustka', principalId: 'account-b', decision: 'allow', reason: 'password_login', privileged: 0, at: T - 5 },
	{ app: 'propustka', kind: 'logout', principalId: 'account-a', decision: 'allow', reason: 'logout', privileged: 1, at: T - 4 },
	{ app: 'notes@prod', principalId: 'account-a', decision: 'allow', reason: 'mint', privileged: 1, at: T - 3 },
	{ app: 'propustka', principalId: 'account-a', decision: 'allow', reason: 'password_login', privileged: 1, at: T - WINDOW - 1 },
]

function contract(name: string, setup: () => Promise<{ db: SqlDatabase; repositories: IamRepositories }>): void {
	test(`${name}: counts only credential guesses, per known account and installation-wide, and lists privileged sign-ins`, async () => {
		const { db, repositories } = await setup()
		await seed(db, ROWS)
		const result = await signInSignals(makeServicesFor(repositories), { since: T - WINDOW, until: T })
		if (!result.ok) throw new Error('expected an answer')
		expect(result.accounts).toEqual([{ principalId: 'account-a', refusals: 4 }])
		expect(result.refusals).toBe(8)
		expect(result.reasons).toEqual([
			{ reason: 'invalid_key', refusals: 1 },
			{ reason: 'password_invalid', refusals: 5 },
			{ reason: 'password_throttled', refusals: 1 },
			{ reason: 'second_factor_invalid', refusals: 1 },
		])
		expect(result.privileged).toEqual([{ id: expect.any(String), principalId: 'account-a', reason: 'password_login', at: T - 10 }])
		expect(result.truncated).toBe(false)
	})

	test(`${name}: refuses a reversed, fractional or longer-than-a-day window`, async () => {
		const { repositories } = await setup()
		const services = makeServicesFor(repositories)
		for (const window of [{ since: T, until: T - 1 }, { since: T - 0.5, until: T }, { since: T - 24 * 60 * 60 - 1, until: T }]) {
			expect(await signInSignals(services, window)).toEqual({ ok: false, reason: 'invalid_window' })
		}
	})
}

describe('sign-in signals', () => {
	// The allow-list itself: a new `LoginRefusal` fails the typecheck of COUNTED_LOGIN_REFUSALS until it is decided here.
	test('counts password guesses per account, second-factor guesses and refused keys installation-wide, nothing else', () => {
		expect(Object.entries(COUNTED_LOGIN_REFUSALS).filter(([, bucket]) => bucket !== null)).toEqual([
			['password_invalid', 'account'],
			['password_throttled', 'account'],
			['second_factor_invalid', 'installation'],
			['second_factor_throttled', 'installation'],
		])
		expect(COUNTED_KEY_REFUSAL).toBe('invalid_key')
	})

	contract('SQLite', () => {
		const harness = createHarness()
		return Promise.resolve({ db: new TestSqlDatabase(harness.sqlite), repositories: harness.repositories })
	})
})

describe.skipIf(!hasPostgres)('sign-in signals on Postgres', () => {
	const fixtures: PostgresFixture[] = []
	afterAll(async () => {
		await Promise.all(fixtures.map((fixture) => fixture.close()))
	})
	contract('Postgres', async () => {
		const fixture = await createPostgres('iam_signals')
		fixtures.push(fixture)
		return { db: fixture.db, repositories: createPostgresIamRepositories(fixture.db) }
	})
})
