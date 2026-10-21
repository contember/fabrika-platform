import { type SqlDatabase, uuidv7 } from '@fabrika/platform'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createPostgresIamRepositories, type IamRepositories } from '../db'
import { randomToken } from '../oidc'
import { hashToken } from '../secret'
import { createHarness, TestSqlDatabase } from './helpers/harness'
import { migrationFile, migrationsBefore } from './helpers/migrations'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

if (!hasPostgres) {
	console.warn(`terminals.test.ts ${skipReason}`)
}

interface Backend {
	readonly repositories: IamRepositories
	readonly db: SqlDatabase
}

const APP = 'attendance'

function now(): number {
	return Math.floor(Date.now() / 1000)
}

async function person(b: Backend): Promise<string> {
	return (await b.repositories.principals.createUser(uuidv7(), `${uuidv7()}@example.test`)).id
}

/** Enrol a terminal the way enrolment composes it: its service principal and its row, in one batch. */
async function enrol(b: Backend, enrolledBy: string): Promise<{ terminalId: string; tokenHash: string }> {
	const terminalId = uuidv7()
	const tokenHash = await hashToken(randomToken())
	await b.repositories.audit.commit([
		b.repositories.principals.createServiceStatement(terminalId, 'Entrance'),
		b.repositories.terminals.enrolStatement({ principalId: terminalId, label: 'Entrance', enrolledBy, tokenHash, sessionTtl: 300 }),
	])
	return { terminalId, tokenHash }
}

/** A person's login on a terminal, as an assertion writes it, and the child session its handoff redeems into. */
async function terminalSessions(b: Backend, terminalId: string, principalId: string) {
	const terminal = { terminalId, assertedBy: APP }
	const parentHash = await hashToken(randomToken())
	const parentId = await b.repositories.sessions.createSession({
		tokenHash: parentHash,
		principalId,
		authenticationMethod: 'terminal_assertion',
		terminal,
		expiresAt: now() + 300,
	})
	const childHash = await hashToken(randomToken())
	const childId = await b.repositories.sessions.createSession({
		tokenHash: childHash,
		principalId,
		authenticationMethod: 'terminal_assertion',
		terminal,
		app: APP,
		parentSessionId: parentId,
		expiresAt: now() + 300,
	})
	return { parentHash, parentId, childHash, childId }
}

function terminalSuite(backend: () => Backend): void {
	describe('terminals', () => {
		test('an enrolled terminal is found by its cookie hash and its id, and listed', async () => {
			const b = backend()
			const admin = await person(b)
			const { terminalId, tokenHash } = await enrol(b, admin)

			const byHash = await b.repositories.terminals.getActiveByTokenHash(tokenHash)
			expect(byHash).toMatchObject({ principal_id: terminalId, label: 'Entrance', enrolled_by: admin, session_ttl: 300, revoked_at: null })
			expect((await b.repositories.terminals.getById(terminalId))?.token_hash).toBe(tokenHash)
			expect((await b.repositories.principals.getPrincipalById(terminalId))?.type).toBe('service')

			const page = await b.repositories.terminals.list({ limit: 500 })
			expect(page.map((row) => row.principal_id)).toContain(terminalId)
			const before = await b.repositories.terminals.list({ before: terminalId, limit: 500 })
			expect(before.map((row) => row.principal_id)).not.toContain(terminalId)
		})

		test('a profile replaces the session TTL and the whole set of asserters', async () => {
			const b = backend()
			const { terminalId } = await enrol(b, await person(b))
			expect(await b.repositories.terminals.listAsserters(terminalId)).toEqual([])

			expect(
				await b.repositories.terminals.setProfile(terminalId, {
					label: 'Entrance',
					sessionTtl: 600,
					asserters: [{ app: APP, ceiling: ['attendance.*'] }, { app: 'canteen', ceiling: [] }],
				}),
			).toBe(true)
			expect((await b.repositories.terminals.getById(terminalId))?.session_ttl).toBe(600)
			expect(await b.repositories.terminals.getAsserter(terminalId, APP)).toEqual({ app: APP, ceiling: ['attendance.*'] })

			await b.repositories.terminals.setProfile(terminalId, {
				label: 'Entrance',
				sessionTtl: 300,
				asserters: [{ app: 'canteen', ceiling: ['meal.order'] }],
			})
			expect(await b.repositories.terminals.listAsserters(terminalId)).toEqual([{ app: 'canteen', ceiling: ['meal.order'] }])
			expect(await b.repositories.terminals.getAsserter(terminalId, APP)).toBeNull()
		})

		test('a session TTL over one hour is refused by the schema', async () => {
			const b = backend()
			const { terminalId } = await enrol(b, await person(b))
			await expect(b.repositories.terminals.setProfile(terminalId, { label: 'Entrance', sessionTtl: 3601, asserters: [] })).rejects.toThrow()
			expect((await b.repositories.terminals.getById(terminalId))?.session_ttl).toBe(300)
		})

		test('revoking a terminal ends its sessions and their children, once, with one audit record', async () => {
			const b = backend()
			const admin = await person(b)
			const someone = await person(b)
			const { terminalId, tokenHash } = await enrol(b, admin)
			const sessions = await terminalSessions(b, terminalId, someone)
			// A child that does not carry the terminal itself still ends with its parent's terminal.
			const plainChildHash = await hashToken(randomToken())
			await b.repositories.sessions.createSession({
				tokenHash: plainChildHash,
				principalId: someone,
				authenticationMethod: 'password',
				app: 'other',
				parentSessionId: sessions.parentId,
				expiresAt: now() + 300,
			})
			const personalHash = await hashToken(randomToken())
			await b.repositories.sessions.createSession({ tokenHash: personalHash, principalId: someone, idpSub: uuidv7(), expiresAt: now() + 3600 })

			expect((await b.repositories.sessions.getActiveSessionByHash(sessions.parentHash))?.terminal_id).toBe(terminalId)
			expect(await b.repositories.sessions.getActiveSessionByHash(sessions.childHash)).toMatchObject({ terminal_id: terminalId, asserted_by: APP })
			expect(await b.repositories.sessions.getActiveSessionByHash(plainChildHash)).not.toBeNull()

			const requestId = uuidv7()
			const audit = {
				requestId,
				principalId: admin,
				principalLabel: admin,
				app: 'fabrika-iam',
				action: 'iam.terminal.revoke',
				resourceType: 'terminal',
				resourceId: terminalId,
			}
			expect(await b.repositories.terminals.revoke(terminalId, audit)).toBe(true)
			expect(await b.repositories.terminals.revoke(terminalId, { ...audit, requestId: uuidv7() })).toBe(false)

			for (const hash of [sessions.parentHash, sessions.childHash, plainChildHash]) {
				expect(await b.repositories.sessions.getActiveSessionByHash(hash)).toBeNull()
			}
			expect(await b.repositories.sessions.getActiveSessionById(sessions.childId)).toBeNull()
			expect((await b.repositories.sessions.getSessionById(sessions.parentId))?.revoked_at).not.toBeNull()
			expect(await b.repositories.sessions.getActiveSessionByHash(personalHash)).not.toBeNull()
			expect(await b.repositories.terminals.getActiveByTokenHash(tokenHash)).toBeNull()
			expect(await b.repositories.terminals.setProfile(terminalId, { label: 'Entrance', sessionTtl: 600, asserters: [{ app: APP, ceiling: [] }] })).toBe(
				false,
			)
			expect(await b.repositories.terminals.listAsserters(terminalId)).toEqual([])

			const { results } = await b.db
				.prepare('SELECT action FROM audit_events WHERE resource_id = ?')
				.bind(terminalId)
				.all<{ action: string }>()
			expect(results).toEqual([{ action: 'iam.terminal.revoke' }])
		})

		test('the validity join alone refuses a session whose terminal is revoked', async () => {
			const b = backend()
			const { terminalId } = await enrol(b, await person(b))
			const sessions = await terminalSessions(b, terminalId, await person(b))
			await b.db.prepare('UPDATE terminals SET revoked_at = ? WHERE principal_id = ?').bind(now(), terminalId).run()

			expect(await b.repositories.sessions.getActiveSessionByHash(sessions.parentHash)).toBeNull()
			expect(await b.repositories.sessions.getActiveSessionByHash(sessions.childHash)).toBeNull()
			expect(await b.repositories.sessions.getActiveSessionById(sessions.parentId)).toBeNull()
		})

		test('releasing a terminal revokes only its live sessions', async () => {
			const b = backend()
			const someone = await person(b)
			const { terminalId } = await enrol(b, await person(b))
			const other = await enrol(b, await person(b))
			const sessions = await terminalSessions(b, terminalId, someone)
			const elsewhere = await terminalSessions(b, other.terminalId, someone)

			expect(await b.repositories.terminals.revokeSessions(terminalId)).toBe(2)
			expect(await b.repositories.terminals.revokeSessions(terminalId)).toBe(0)
			expect(await b.repositories.sessions.getActiveSessionByHash(sessions.childHash)).toBeNull()
			expect(await b.repositories.sessions.getActiveSessionByHash(elsewhere.childHash)).not.toBeNull()
		})

		test('a terminal is named by exactly the terminal_assertion sessions', async () => {
			const b = backend()
			const someone = await person(b)
			const { terminalId } = await enrol(b, await person(b))
			const base = { principalId: someone, expiresAt: now() + 300 }
			await expect(
				b.repositories.sessions.createSession({ ...base, tokenHash: uuidv7(), authenticationMethod: 'terminal_assertion' }),
			).rejects.toThrow()
			await expect(
				b.repositories.sessions.createSession({
					...base,
					tokenHash: uuidv7(),
					authenticationMethod: 'password',
					terminal: { terminalId, assertedBy: APP },
				}),
			).rejects.toThrow()

			// Async, so the in-process SQLite's synchronous throw arrives as a rejection, as Postgres's does.
			const insert = async (method: string, terminal: string | null, assertedBy: string | null) => {
				await b.db
					.prepare(`INSERT INTO sessions (id, token_hash, principal_id, authentication_method, created_at, expires_at, terminal_id, asserted_by)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
					.bind(uuidv7(), uuidv7(), someone, method, now(), now() + 300, terminal, assertedBy)
					.run()
			}
			await expect(insert('terminal_assertion', terminalId, null)).rejects.toThrow()
			await expect(insert('terminal_assertion', null, APP)).rejects.toThrow()
			await expect(insert('password', terminalId, APP)).rejects.toThrow()
			await expect(insert('password', null, APP)).rejects.toThrow()
			await insert('terminal_assertion', terminalId, APP)
		})

		test('auth_log rows carry the session terminal: a written one and a logout', async () => {
			const b = backend()
			const someone = await person(b)
			const { terminalId } = await enrol(b, await person(b))
			const sessions = await terminalSessions(b, terminalId, someone)
			const assertion = uuidv7()
			await b.repositories.audit.writeAuthLog({
				requestId: assertion,
				app: APP,
				kind: 'authenticate',
				principalId: someone,
				decision: 'allow',
				terminal: { terminalId, assertedBy: APP },
			})
			const logout = uuidv7()
			expect(await b.repositories.sessions.revokeSessionByHash(sessions.childHash, { requestId: logout, app: APP })).toBe(true)

			for (const requestId of [assertion, logout]) {
				const [row] = await b.repositories.audit.listAuthLog({ requestId, limit: 10 })
				expect(row).toMatchObject({ principal_id: someone, terminal_id: terminalId, asserted_by: APP })
			}
			const plain = uuidv7()
			await b.repositories.audit.writeAuthLog({ requestId: plain, app: APP, kind: 'authenticate', principalId: someone, decision: 'deny' })
			expect((await b.repositories.audit.listAuthLog({ requestId: plain, limit: 10 }))[0]).toMatchObject({ terminal_id: null, asserted_by: null })
		})
	})

	describe('identifications', () => {
		async function open(b: Backend, terminalId: string, expiresAt = now() + 120): Promise<string> {
			const idHash = await hashToken(randomToken())
			await b.repositories.terminals.createIdentification({
				idHash,
				terminalId,
				app: APP,
				returnUrl: 'https://attendance.example.test/',
				handoffState: 'state',
				handoffChallenge: 'challenge',
				expiresAt,
			})
			return idHash
		}

		test('is consumed at most once, and the consumption answers the handoff it carries', async () => {
			const b = backend()
			const { terminalId } = await enrol(b, await person(b))
			const idHash = await open(b, terminalId)
			expect(await b.repositories.terminals.getIdentification(idHash)).toMatchObject({ terminal_id: terminalId, app: APP, consumed_at: null })

			const consumed = await Promise.all([
				b.repositories.terminals.consumeIdentification(idHash, now()),
				b.repositories.terminals.consumeIdentification(idHash, now()),
			])
			const winners = consumed.filter((row) => row !== null)
			expect(winners).toHaveLength(1)
			expect(winners[0]).toMatchObject({
				terminal_id: terminalId,
				app: APP,
				return_url: 'https://attendance.example.test/',
				handoff_state: 'state',
				handoff_challenge: 'challenge',
			})
			expect(await b.repositories.terminals.consumeIdentification(idHash, now())).toBeNull()
		})

		test('an expired identification cannot be consumed', async () => {
			const b = backend()
			const { terminalId } = await enrol(b, await person(b))
			const idHash = await open(b, terminalId, now() - 1)
			expect(await b.repositories.terminals.consumeIdentification(idHash, now())).toBeNull()
			expect(await b.repositories.terminals.consumeIdentification(await hashToken(randomToken()), now())).toBeNull()
		})

		test('is cancelled only by its own application, and a cancelled one cannot be consumed', async () => {
			const b = backend()
			const { terminalId } = await enrol(b, await person(b))
			const idHash = await open(b, terminalId)
			expect(await b.repositories.terminals.cancelIdentification(idHash, 'canteen')).toBe(false)
			expect(await b.repositories.terminals.cancelIdentification(idHash, APP)).toBe(true)
			expect(await b.repositories.terminals.cancelIdentification(idHash, APP)).toBe(false)
			expect(await b.repositories.terminals.consumeIdentification(idHash, now())).toBeNull()
		})

		test('pruning removes ended and expired identifications and keeps open ones', async () => {
			const b = backend()
			const { terminalId } = await enrol(b, await person(b))
			const live = await open(b, terminalId)
			const expired = await open(b, terminalId, now() - 10)
			const consumed = await open(b, terminalId)
			await b.repositories.terminals.consumeIdentification(consumed, now())

			await b.repositories.terminals.pruneIdentifications(now())
			expect(await b.repositories.terminals.getIdentification(live)).not.toBeNull()
			expect(await b.repositories.terminals.getIdentification(expired)).toBeNull()
			expect(await b.repositories.terminals.getIdentification(consumed)).toBeNull()
		})
	})
}

describe('terminals — SQLite', () => {
	terminalSuite(() => {
		const h = createHarness()
		return { repositories: h.repositories, db: new TestSqlDatabase(h.sqlite) }
	})
})

let fixture: PostgresFixture | null = null
let postgres: Backend | null = null

beforeAll(async () => {
	if (!hasPostgres) return
	fixture = await createPostgres('iam_terminals', { max: 4 })
	postgres = { repositories: createPostgresIamRepositories(fixture.db), db: fixture.db }
})

afterAll(async () => {
	await fixture?.close()
})

describe.skipIf(!hasPostgres)('terminals — Postgres', () => {
	terminalSuite(() => {
		if (postgres === null) throw new Error('postgres backend not ready')
		return postgres
	})
})

describe('0023_terminals on an existing SQLite installation', () => {
	test('keeps every session, handoff code and OAuth row, with their references', () => {
		const h = createHarness(migrationsBefore('0023_terminals.sql'))
		const t = now()
		h.sqlite.run(`INSERT INTO principals (id, type, external_id, email, label, activated_at, created_at)
			VALUES ('p1', 'user', 'sub-1', 'a@example.test', 'a@example.test', ${t}, ${t})`)
		// The child is inserted first, so a copy in rowid order would meet it before its parent.
		h.sqlite.run('PRAGMA foreign_keys = OFF')
		h.sqlite.run(`INSERT INTO sessions (id, token_hash, principal_id, idp_sub, authentication_method, created_at, expires_at, app, parent_session_id)
			VALUES ('s-child', 'h-child', 'p1', 'sub-1', 'oidc', ${t}, ${t + 3600}, 'crm', 's-root')`)
		h.sqlite.run('PRAGMA foreign_keys = ON')
		h.sqlite.run(`INSERT INTO sessions (id, token_hash, principal_id, idp_sub, authentication_method, created_at, expires_at, revoked_at)
			VALUES ('s-root', 'h-root', 'p1', 'sub-1', 'oidc', ${t}, ${t + 3600}, ${t})`)
		h.sqlite.run(`INSERT INTO sessions (id, token_hash, principal_id, idp_sub, authentication_method, created_at, expires_at)
			VALUES ('s-password', 'h-password', 'p1', NULL, 'password', ${t}, ${t + 3600})`)
		h.sqlite.run(`INSERT INTO auth_codes (id, code_hash, app, parent_session_id, return_url, expires_at, created_at)
			VALUES ('c1', 'code-hash', 'crm', 's-root', 'https://crm.example.test/', ${t + 60}, ${t})`)
		h.sqlite.run(`INSERT INTO oauth_grants (id, principal_id, session_id, client_id, app, resource, scopes, created_at, expires_at)
			VALUES ('g1', 'p1', 's-password', 'client', 'crm', 'https://crm.example.test/mcp', 'read', ${t}, ${t + 3600})`)
		h.sqlite.run(`INSERT INTO oauth_codes (token_hash, grant_id, redirect_uri, challenge, expires_at)
			VALUES ('oc1', 'g1', 'http://127.0.0.1/cb', 'challenge', ${t + 60})`)
		h.sqlite.run(`INSERT INTO oauth_refresh_tokens (token_hash, grant_id, expires_at) VALUES ('rt1', 'g1', ${t + 3600})`)
		const count = (table: string) => h.sqlite.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n
		const before = ['sessions', 'auth_codes', 'oauth_grants', 'oauth_codes', 'oauth_refresh_tokens'].map(count)

		h.sqlite.exec(migrationFile('0023_terminals.sql'))

		expect(['sessions', 'auth_codes', 'oauth_grants', 'oauth_codes', 'oauth_refresh_tokens'].map(count)).toEqual(before)
		expect(h.sqlite.query('SELECT id, revoked_at, parent_session_id, terminal_id, asserted_by FROM sessions ORDER BY id').all()).toEqual([
			{ id: 's-child', revoked_at: null, parent_session_id: 's-root', terminal_id: null, asserted_by: null },
			{ id: 's-password', revoked_at: null, parent_session_id: null, terminal_id: null, asserted_by: null },
			{ id: 's-root', revoked_at: t, parent_session_id: null, terminal_id: null, asserted_by: null },
		])
		expect(h.sqlite.query('PRAGMA foreign_key_check').all()).toEqual([])
		expect(h.sqlite.query("SELECT name FROM sqlite_master WHERE name LIKE '%_kept' OR name LIKE '%_rebuilt'").all()).toEqual([])

		// The references still cascade: ending the root ends its child and its code; ending the OAuth session ends the grant.
		h.sqlite.run("DELETE FROM sessions WHERE id = 's-root'")
		expect(count('sessions')).toBe(1)
		expect(count('auth_codes')).toBe(0)
		h.sqlite.run("DELETE FROM sessions WHERE id = 's-password'")
		expect(['oauth_grants', 'oauth_codes', 'oauth_refresh_tokens'].map(count)).toEqual([0, 0, 0])
	})
})
