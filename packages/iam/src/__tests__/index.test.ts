import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { PROVISIONING_ADMIN_ID } from '../auth'
import { createIamRepositories } from '../db'
import type { Env, RequestContext } from '../env'
import { pkceChallenge, randomToken } from '../oidc'
import { createIamRpc } from '../rpc'
import { buildServices } from '../services'
import { signAccessToken } from '../tokens'
import { seedUser } from './helpers/harness'
import { allMigrations } from './helpers/migrations'

// TEST-4: the RPC entrypoint (`Propustka` in src/index.ts) wires several spec-mandated
// behaviors that nothing else exercises:
//   1. mintFromKey writes EXACTLY ONE auth_log row with the right app, decision
//      (allow/deny) and reason;
//   2. issueKey/revokeKey resolve the caller server-side (`resolveCaller`) and their
//      `iam.credential.*` audit events carry the grants but NEVER the plaintext token.
//
// We drive the real class against a real `Db(env.DB)` backed by an in-memory bun:sqlite
// (the schema.test.ts pattern). The caller presents the seeded provisioning key, which resolves
// to the migration-seeded `provisioning-admin` global admin with the SDK-passed app as its
// verified app, so auth-log / audit FK lookups resolve.

// `Propustka` extends `WorkerEntrypoint` from 'cloudflare:workers', which bun's test
// runtime cannot resolve. Stub it with a base class that just assigns ctx/env — exactly
// what the real WorkerEntrypoint does for our purposes. This is test infrastructure, not
// a source change: it must run BEFORE importing the class under test.
mock.module('cloudflare:workers', () => ({
	WorkerEntrypoint: class<E> {
		constructor(public readonly ctx: RequestContext, public readonly env: E) {}
	},
}))

const { Propustka, iamEnv } = await import('../index')

const migration = allMigrations()

// ── bun:sqlite → minimal D1Database adapter ───────────────────────────────────
// The `Db` class only uses prepare().bind().{first,all,run} and db.batch(...). We wrap
// a bun:sqlite Database in just enough of the D1 surface to satisfy that, with no casts.

class SqliteStatement implements D1PreparedStatement {
	constructor(private readonly db: Database, private readonly sql: string, private readonly args: unknown[] = []) {}

	bind(...values: unknown[]): D1PreparedStatement {
		return new SqliteStatement(this.db, this.sql, values)
	}

	first<T = unknown>(colName?: string): Promise<T | null> {
		const row = this.db.query(this.sql).get(...this.bindArgs())
		if (row === null) {
			return Promise.resolve(null)
		}
		if (colName !== undefined) {
			const value = (row as Record<string, unknown>)[colName]
			return Promise.resolve((value ?? null) as T | null)
		}
		return Promise.resolve(row as T)
	}

	run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
		const res = this.db.query(this.sql).run(...this.bindArgs())
		return Promise.resolve(this.result<T>([], res.changes, res.lastInsertRowid))
	}

	all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
		const rows = this.db.query(this.sql).all(...this.bindArgs()) as T[]
		return Promise.resolve(this.result<T>(rows))
	}

	// `Db` never calls raw(); declared only to satisfy the D1PreparedStatement contract.
	raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>
	raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>
	raw(): Promise<unknown[]> {
		throw new Error('raw() not supported in the test D1 adapter')
	}

	private bindArgs(): (string | number | bigint | boolean | null)[] {
		return this.args.map((a) => {
			if (a === null || typeof a === 'string' || typeof a === 'number' || typeof a === 'bigint' || typeof a === 'boolean') {
				return a
			}
			throw new Error(`unsupported bind value: ${String(a)}`)
		})
	}

	private result<T>(results: T[], changes = 0, lastRowId: number | bigint = 0): D1Result<T> {
		return {
			results,
			success: true,
			meta: {
				duration: 0,
				size_after: 0,
				rows_read: results.length,
				rows_written: changes,
				last_row_id: Number(lastRowId),
				changed_db: changes > 0,
				changes,
			},
		}
	}
}

class SqliteD1 implements D1Database {
	constructor(private readonly db: Database) {}

	prepare(query: string): D1PreparedStatement {
		return new SqliteStatement(this.db, query)
	}

	async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
		const out: D1Result<T>[] = []
		for (const s of statements) {
			out.push(await s.run<T>())
		}
		return out
	}

	async exec(query: string): Promise<D1ExecResult> {
		this.db.exec(query)
		return { count: 0, duration: 0 }
	}

	dump(): Promise<ArrayBuffer> {
		throw new Error('dump() not supported in the test D1 adapter')
	}

	withSession(): D1DatabaseSession {
		throw new Error('withSession() not supported in the test D1 adapter')
	}
}

// ── Test fixtures ──────────────────────────────────────────────────────────────

function freshDb(): Database {
	const db = new Database(':memory:')
	db.exec('PRAGMA foreign_keys = ON')
	db.exec(migration)
	return db
}

const PROVISIONING_KEY = 'px_index-test-provisioning'

function makeEnv(db: Database, overrides: Partial<Pick<Env, 'ENVIRONMENT'>> = {}): Env {
	const sql = new SqliteD1(db)
	return {
		DB: sql,
		REPOSITORIES: createIamRepositories(sql),
		HUMAN_EMAIL_DOMAINS: '["contember.com"]',
		HUMAN_EMAILS: '[]',
		IAM_BOOTSTRAP_ADMINS: '[]',
		ENVIRONMENT: overrides.ENVIRONMENT ?? 'local',
		ISSUER: 'http://localhost:18191',
		FABRIKA_IAM_SIGNING_KEYS: '',
		FABRIKA_IAM_PROVISIONING_KEY: PROVISIONING_KEY,
		OIDC_ENABLED: 'true',
		PASSWORD_ENABLED: 'false',
		OIDC_ISSUER: 'https://idp.test',
		OIDC_CLIENT_ID: 'client',
		OIDC_CLIENT_SECRET: 'dummy-oidc-secret',
		OIDC_SCOPES: '',
		OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
		EMAIL_PROVIDER: 'none',
		EMAIL_FROM: '',
		EMAIL_API_KEY: '',
	}
}

function workerBindings(db: Database) {
	return {
		DB: new SqliteD1(db),
		HUMAN_EMAIL_DOMAINS: '[]',
		HUMAN_EMAILS: '[]',
		IAM_BOOTSTRAP_ADMINS: '[]',
		ENVIRONMENT: 'local',
		ISSUER: 'http://localhost:18191',
		OIDC_ENABLED: 'true',
		PASSWORD_ENABLED: 'false',
		OIDC_ISSUER: 'https://idp.test',
		OIDC_CLIENT_ID: 'client',
		OIDC_CLIENT_SECRET: 'secret',
		OIDC_SCOPES: '',
		OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
		EMAIL_PROVIDER: 'none',
		EMAIL_FROM: '',
	}
}

// A fake request context that records the fire-and-forget promises so we can await
// them before querying the DB (all of Propustka's DB writes go through this.ctx.waitUntil).
interface FakeCtx extends RequestContext {
	promises: Promise<unknown>[]
}

function makeCtx(): FakeCtx {
	const promises: Promise<unknown>[] = []
	return {
		promises,
		waitUntil(p: Promise<unknown>): void {
			promises.push(p)
		},
	}
}

function makeEntrypoint(ctx: FakeCtx, env: Env): InstanceType<typeof Propustka> {
	const worker: unknown = Reflect.construct(Propustka, [ctx, env])
	if (!(worker instanceof Propustka)) {
		throw new Error('failed to construct the mocked Worker entrypoint')
	}
	return worker
}

async function settle(ctx: FakeCtx): Promise<void> {
	await Promise.all(ctx.promises)
}

interface AuthLogRow {
	request_id: string
	app: string
	kind: string
	principal_id: string | null
	credential_id: string | null
	decision: string
	reason: string | null
}

function authLogRows(db: Database): AuthLogRow[] {
	return db.query<AuthLogRow, []>('SELECT * FROM auth_log').all()
}

interface AuditRow {
	id: string
	request_id: string
	principal_id: string | null
	principal_label: string
	app: string
	action: string
	resource_type: string
	resource_id: string | null
	diff: string | null
	metadata: string | null
}

function auditRows(db: Database): AuditRow[] {
	return db.query<AuditRow, []>('SELECT * FROM audit_events').all()
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Propustka RPC entrypoint (TEST-4)', () => {
	let db: Database

	beforeEach(() => {
		db = freshDb()
	})

	test('device management on the Worker binding matches the shared RPC implementation', async () => {
		const ctx = makeCtx()
		const env = makeEnv(db)
		const worker = makeEntrypoint(ctx, env)
		const rpc = createIamRpc(env, ctx)
		const principalId = seedUser(db, { sub: 'device-human', email: 'device@example.test' })
		await env.REPOSITORIES.grants.createGrant({ principalId, app: 'vozka', permissions: ['deploy.read'], grantedBy: principalId })
		const now = Math.floor(Date.now() / 1000)
		const credential = await signAccessToken(buildServices(env), env, {
			app: 'vozka',
			subject: principalId,
			type: 'user',
			label: 'Device human',
			permissions: [],
			issuedAt: now,
			expiresAt: now + 300,
		})
		const approvalVerifier = randomToken(32)
		const started = await env.REPOSITORIES.device.start({
			app: 'vozka',
			label: 'Worker pairing',
			permissions: ['deploy.read'],
			keyLifetimeSeconds: 600,
			approvalChallenge: await pkceChallenge(approvalVerifier),
			redemptionChallenge: await pkceChallenge(randomToken(32)),
		})
		const input = { app: 'vozka', credential, requestId: 'worker-device', attemptId: started.attemptId, approvalVerifier }
		const inspected = await worker.inspectDeviceAuthorization(input)
		expect(inspected.ok).toBe(true)
		expect(inspected).toEqual(await rpc.inspectDeviceAuthorization(input))
		const approval = { ...input, scope: { type: 'app', value: 'delivery-id' } }
		const approved = await worker.approveDeviceAuthorization(approval)
		expect(approved.ok).toBe(true)
		expect(approved).toEqual(await rpc.approveDeviceAuthorization(approval))
		expect(await worker.denyDeviceAuthorization(input)).toEqual(await rpc.denyDeviceAuthorization(input))
		expect(await worker.listOwnDeviceAuthorizations(input)).toEqual(await rpc.listOwnDeviceAuthorizations(input))
	})

	test('mintFromKey DENY (unknown key) writes one authenticate auth_log row, credential_id null', async () => {
		const ctx = makeCtx()
		const worker = makeEntrypoint(ctx, makeEnv(db))

		const result = await worker.mintFromKey({ app: 'reports', key: 'px_does-not-exist', requestId: 'req-mint' })
		expect(result).toEqual({ ok: false, reason: 'invalid_key' })

		await settle(ctx)

		const rows = authLogRows(db)
		expect(rows).toHaveLength(1)
		const row = rows[0]
		expect(row?.kind).toBe('authenticate')
		expect(row?.decision).toBe('deny')
		expect(row?.reason).toBe('invalid_key')
		expect(row?.credential_id).toBeNull()
		expect(row?.principal_id).toBeNull()
		expect(row?.app).toBe('reports')
	})

	test('issueKey happy path (anonymous share link): one iam.credential.create audit row carrying grants, never the plaintext token', async () => {
		// The provisioning key resolves the issuer to a global admin (permissions: [{ action: '*' }]),
		// so the requested grant is fully covered and a credential is issued.
		const ctx = makeCtx()
		const worker = makeEntrypoint(ctx, makeEnv(db))

		const permissions = [{ action: 'report.read', scope: null }]
		const result = await worker.issueKey({
			app: 'reports',
			credential: PROVISIONING_KEY,
			requestId: 'req-issue',
			permissions,
		})

		expect(result.ok).toBe(true)
		if (!result.ok) {
			throw new Error('expected issueKey to succeed')
		}
		expect(result.token.startsWith('px_')).toBe(true)
		expect(typeof result.id).toBe('string')

		await settle(ctx)

		const rows = auditRows(db)
		expect(rows).toHaveLength(1)
		const row = rows[0]
		expect(row?.action).toBe('iam.credential.create')
		expect(row?.resource_type).toBe('credential')
		expect(row?.resource_id).toBe(result.id)
		expect(row?.principal_id).toBe(PROVISIONING_ADMIN_ID)

		// metadata.grants must equal the requested grants (action + scope).
		const metadata: unknown = JSON.parse(row?.metadata ?? 'null')
		expect(metadata).toMatchObject({ grants: [{ action: 'report.read', scope: null }] })

		// The plaintext token must NEVER be persisted anywhere on the audit row.
		const serializedRow = JSON.stringify(row)
		expect(serializedRow).not.toContain(result.token)
	})

	test('revokeKey: issueKey → revokeKey flips the credential, audits the revoke, and the credential no longer mints', async () => {
		const ctx = makeCtx()
		const worker = makeEntrypoint(ctx, makeEnv(db))

		// Issue an anonymous share link under the provisioning admin so the grant is covered.
		const issued = await worker.issueKey({
			app: 'reports',
			credential: PROVISIONING_KEY,
			requestId: 'req-issue',
			permissions: [{ action: 'report.read', scope: null }],
		})
		if (!issued.ok) {
			throw new Error('expected issueKey to succeed')
		}

		// Before revoke the key mints fine.
		const before = await worker.mintFromKey({ app: 'reports', key: issued.token, requestId: 'req-mint-before' })
		expect(before.ok).toBe(true)

		const revoked = await worker.revokeKey({
			app: 'reports',
			credential: PROVISIONING_KEY,
			requestId: 'req-revoke',
			id: issued.id,
		})
		expect(revoked).toEqual({ ok: true, revoked: true })

		// Minting from the revoked key now fails with reason 'invalid_key'.
		const after = await worker.mintFromKey({ app: 'reports', key: issued.token, requestId: 'req-mint-after' })
		expect(after).toEqual({ ok: false, reason: 'invalid_key' })

		// A second revoke is idempotent.
		const again = await worker.revokeKey({
			app: 'reports',
			credential: PROVISIONING_KEY,
			requestId: 'req-revoke-2',
			id: issued.id,
		})
		expect(again).toEqual({ ok: true, revoked: false })

		await settle(ctx)

		// Exactly one iam.credential.revoke audit row (the no-op second revoke writes none).
		const revokeRows = auditRows(db).filter((r) => r.action === 'iam.credential.revoke')
		expect(revokeRows).toHaveLength(1)
		expect(revokeRows[0]?.resource_id).toBe(issued.id)
		expect(revokeRows[0]?.principal_id).toBe(PROVISIONING_ADMIN_ID)
	})

	test('revokeKey: unknown id → not_found', async () => {
		const ctx = makeCtx()
		const worker = makeEntrypoint(ctx, makeEnv(db))
		const result = await worker.revokeKey({
			app: 'reports',
			credential: PROVISIONING_KEY,
			requestId: 'req-revoke-missing',
			id: 'does-not-exist',
		})
		expect(result).toEqual({ ok: false, reason: 'not_found' })
	})

	test('listPrincipals: the provisioning caller is scoped to the SDK-passed app', async () => {
		const ctx = makeCtx()
		const worker = makeEntrypoint(ctx, makeEnv(db))
		// The provisioning key resolves a global-admin caller whose verified app IS the SDK-passed
		// `app`. So the read succeeds and is scoped to that app — here an empty roster (no users are
		// seeded for 'poplach').
		const result = await worker.listPrincipals({ app: 'poplach', credential: PROVISIONING_KEY, requestId: 'req-list-local' })
		expect(result).toEqual({ ok: true, principals: [] })
	})
})

describe('the IAM Worker environment', () => {
	test('maps the secret bindings onto the runtime-neutral env', () => {
		const env = iamEnv({
			...workerBindings(freshDb()),
			FABRIKA_IAM_SIGNING_KEYS: 'signing-key-material',
			FABRIKA_IAM_PROVISIONING_KEY: 'px_provisioning',
		})

		expect(env.FABRIKA_IAM_SIGNING_KEYS).toBe('signing-key-material')
		expect(env.FABRIKA_IAM_PROVISIONING_KEY).toBe('px_provisioning')
	})

	test('maps the provider-specific email secret to the runtime-neutral binding', () => {
		const env = iamEnv({
			...workerBindings(freshDb()),
			FABRIKA_EMAIL_RESEND_API_KEY: 'private-resend-key',
		})

		expect(env.EMAIL_API_KEY).toBe('private-resend-key')
	})

	// A Worker has no boot, so `local` from a public issuer fails where a Worker fails everything else:
	// on the request. The Bun half of this witness is in fail-closed-boot.test.ts.
	test('REFUSES ENVIRONMENT=local when the issuer it mints for is a public origin', () => {
		const worker = makeEntrypoint(makeCtx(), { ...makeEnv(freshDb()), ISSUER: 'https://iam-abcd-3000.prg1.zerops.app' })

		expect(() => worker.getJwks()).toThrow(/ENVIRONMENT=local is refused/)
	})

	test('still serves a genuinely local Worker — `wrangler dev` issues on localhost', async () => {
		const worker = makeEntrypoint(makeCtx(), { ...makeEnv(freshDb()), ISSUER: 'http://localhost:18191' })

		expect((await worker.getJwks()).keys.length).toBeGreaterThan(0)
	})
})

// Backlog 57: the Worker is edge-routed, so no proxy strips a caller's `X-Request-Id` before it gets here.
describe('the Worker root chooses the audit correlation id', () => {
	async function localLoginRequestIds(headers: Record<string, string>): Promise<string[]> {
		const db = freshDb()
		const ctx = makeCtx()
		const worker = makeEntrypoint(ctx, { ...makeEnv(db), LOCAL_DEV_LOGIN: 'true' })

		const response = await worker.fetch(new Request('http://localhost:18191/auth/login', { headers }))
		await settle(ctx)

		expect(response.status).toBe(302)
		return authLogRows(db).map((row) => row.request_id)
	}

	test('writes the edge-written cf-ray, not a caller-supplied X-Request-Id', async () => {
		const ids = await localLoginRequestIds({ 'X-Request-Id': 'caller-chosen', 'cf-ray': '8f1c2a3b4c5d6e7f-PRG' })

		expect(ids).toEqual(['8f1c2a3b4c5d6e7f-PRG'])
	})

	test('generates an id when only a caller-supplied X-Request-Id is present', async () => {
		const ids = await localLoginRequestIds({ 'X-Request-Id': 'caller-chosen' })

		expect(ids).toHaveLength(1)
		expect(ids[0]).not.toBe('caller-chosen')
		expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
	})
})
