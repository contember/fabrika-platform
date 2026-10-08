import { unusedDatabase } from '@fabrika/platform/testing'
import { describe, expect, test } from 'bun:test'
import { handleAdmin } from '../admin/router'
import { createIamApp } from '../app'
import type { Env, RequestContext } from '../env'
import { prop } from '../json'
import type { Services } from '../services'
import { getSigner, verifyAccessToken } from '../signing'
import { mintToken } from '../tokens'
import { createHarness, type Harness, seedAppAction, seedGrant, seedRole, seedUser, TEST_SIGNING_ENV, TEST_SIGNING_KEYS } from './helpers/harness'

// FINDING TEST-2: the admin gate wiring in handleAdmin. Every /admin/* request must
// pass a scope-less can('iam.admin') check — satisfied ONLY by a GLOBAL `admin`
// grant (or bootstrap), NEVER by a project-scoped one. This drives handleAdmin end
// to end with the console's bearer (the proxy token Control's gateway forwards → real Db
// over bun:sqlite) and asserts the HTTP status, covering the core security property plus
// the missing/invalid/disabled mapping and the bearer-only admission rule.
//
// The routes it drives are the PROVISIONING ones, because those are the only REST routes left:
// `GET /admin/apps/:app/schema` for the read path and `POST /admin/api-keys` for the write path.
// `/admin/rpc` runs the same `resolveAdmin` code, and `admin-rpc*.test.ts` covers it there.

const ORIGIN = 'https://iam.example.com'
const exec = { waitUntil() {} }
// The admin app id every admin caller is resolved against (see admin/router.ts).
const IAM_APP = 'propustka'

const ADMIN_ENV: Pick<Env, 'FABRIKA_IAM_SIGNING_KEYS' | 'FABRIKA_IAM_PROVISIONING_KEY' | 'ENVIRONMENT'> = {
	...TEST_SIGNING_ENV,
	FABRIKA_IAM_PROVISIONING_KEY: '',
}

function env(h: Harness): Env {
	return {
		DB: unusedDatabase,
		REPOSITORIES: h.repositories,
		HUMAN_EMAIL_DOMAINS: '[]',
		HUMAN_EMAILS: '[]',
		IAM_BOOTSTRAP_ADMINS: '[]',
		ENVIRONMENT: 'stage',
		ISSUER: ORIGIN,
		FABRIKA_IAM_SIGNING_KEYS: TEST_SIGNING_KEYS,
		FABRIKA_IAM_PROVISIONING_KEY: '',
		OIDC_ISSUER: 'https://idp.test',
		OIDC_CLIENT_ID: 'client',
		OIDC_CLIENT_SECRET: 'secret',
		OIDC_SCOPES: '',
		OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
	}
}

// A minimal request context. `handleAdmin` only ever calls ctx.waitUntil; we record
// those promises but never
// need them here, since the gate decisions assert on the response status alone.
class FakeRequestContext implements RequestContext {
	readonly pending: Promise<unknown>[] = []

	waitUntil(promise: Promise<unknown>): void {
		this.pending.push(promise)
	}
}

interface RequestOptions {
	method?: string
	/** Plaintext `px_session` cookie value (a native SSO session). */
	session?: string | null
	/** Signed access token forwarded by a trusted application proxy. */
	bearer?: string | null
	body?: unknown
}

function adminRequest(path: string, opts: RequestOptions = {}): Request {
	const headers = new Headers()
	if (opts.session) {
		headers.set('Cookie', `__Host-px_session=${opts.session}`)
	}
	if (opts.bearer) {
		headers.set('Authorization', `Bearer ${opts.bearer}`)
	}
	const method = opts.method ?? 'GET'
	if (opts.body !== undefined) {
		headers.set('Content-Type', 'application/json')
	}
	return new Request(`${ORIGIN}${path}`, {
		method,
		headers,
		...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
	})
}

// `adminAudiences` defaults to the console gateway; a test passes its own to drive another registry.
function adminServices(h: Harness, adminAudiences?: ReadonlySet<string>): Services {
	return h.makeServices({
		environment: 'stage',
		issuer: ORIGIN,
		...(adminAudiences === undefined ? {} : { adminAudiences }),
	})
}

async function run(h: Harness, request: Request): Promise<Response> {
	return runAs(adminServices(h), request)
}

/** The same call against a services set the caller assembled. */
async function runAs(services: Services, request: Request): Promise<Response> {
	return handleAdmin(request, services, ADMIN_ENV, new FakeRequestContext())
}

/** Mint the proxy-injected access token an app's gateway would forward as a bearer. */
async function proxyToken(h: Harness, app: string, principalId: string): Promise<string> {
	const session = await h.signSession(principalId)
	const minted = await mintToken(adminServices(h), ADMIN_ENV, { app, session, requestId: 'r1' })
	if (!minted.result.ok) throw new Error(`token mint failed: ${minted.result.reason}`)
	return minted.result.token
}

/** The console's bearer for a seeded principal. */
function consoleToken(h: Harness, principalId: string): Promise<string> {
	return h.adminToken(principalId, { issuer: ORIGIN })
}

/** One `/admin/rpc` call as the bearer's admin. */
function rpc(h: Harness, bearer: string, method: string, input: unknown): Promise<Response> {
	return createIamApp().fetch(
		new Request(`${ORIGIN}/admin/rpc`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
			body: JSON.stringify({ method, input }),
		}),
		env(h),
		exec,
	)
}

/** A registered app, so the schema read the gate tests drive resolves to 200 rather than 404. */
const READ_PATH = '/admin/apps/opice/schema'
function registerOpice(h: Harness): void {
	seedAppAction(h.sqlite, 'opice', 'report.read')
}

describe('handleAdmin — admin gate (scope-less iam.admin)', () => {
	test('GLOBAL admin grant → 200 (passes the gate)', async () => {
		const h = createHarness()
		registerOpice(h)
		const id = seedUser(h.sqlite, { sub: 'sub-admin', email: 'admin@example.com' })
		seedGrant(h.sqlite, id, 'admin', null) // global

		const res = await run(h, adminRequest(READ_PATH, { bearer: await consoleToken(h, id) }))

		expect(res.status).toBe(200)
	})

	test('a proxy JWT from the REGISTERED gateway audience resolves IAM permissions live → 200', async () => {
		const h = createHarness()
		registerOpice(h)
		const id = seedUser(h.sqlite, { sub: 'sub-proxy-admin', email: 'proxy-admin@example.com' })
		seedGrant(h.sqlite, id, 'admin', null)

		const res = await run(h, adminRequest(READ_PATH, { bearer: await proxyToken(h, 'vozka', id) }))

		expect(res.status).toBe(200)
	})

	test('SCOPE-BOUND admin grant → 403 (scope-less iam.admin is not satisfied by a scoped entry)', async () => {
		// The core security property: an `admin` grant pinned to one scope value must
		// NOT confer the global admin capability.
		const h = createHarness()
		const id = seedUser(h.sqlite, { sub: 'sub-scoped', email: 'scoped@example.com' })
		seedGrant(h.sqlite, id, 'admin', { type: 'team', value: 'acme' }) // scope-bound

		const res = await run(h, adminRequest(READ_PATH, { bearer: await consoleToken(h, id) }))

		expect(res.status).toBe(403)
	})

	test('only a viewer grant → 403', async () => {
		const h = createHarness()
		seedRole(h.sqlite, IAM_APP, 'viewer', ['project.read'])
		const id = seedUser(h.sqlite, { sub: 'sub-viewer', email: 'viewer@example.com' })
		seedGrant(h.sqlite, id, 'viewer', null, IAM_APP)

		const res = await run(h, adminRequest(READ_PATH, { bearer: await consoleToken(h, id) }))

		expect(res.status).toBe(403)
	})

	test('no bearer → 401 (missing_token)', async () => {
		const h = createHarness()
		const res = await run(h, adminRequest(READ_PATH))

		expect(res.status).toBe(401)
	})

	test('invalid bearer → 401', async () => {
		const h = createHarness()
		const res = await run(h, adminRequest(READ_PATH, { bearer: 'not-a-token' }))

		expect(res.status).toBe(401)
	})

	test('disabled principal with a global admin grant → 403 (disabled)', async () => {
		const h = createHarness()
		const id = seedUser(h.sqlite, { sub: 'sub-disabled', email: 'disabled@example.com', disabled: true })
		seedGrant(h.sqlite, id, 'admin', null)

		const res = await run(h, adminRequest(READ_PATH, { bearer: await consoleToken(h, id) }))

		expect(res.status).toBe(403)
	})
})

describe('handleAdmin — the proxy JWT audience registry (SEC-A3-1)', () => {
	test('a token minted for ANOTHER app → 403, even for a global admin', async () => {
		// Every application receives the proxy-injected token in cleartext, so an unpinned `aud` let any
		// of them replay an administrator's token here. `aud` must name a registered admin gateway.
		const h = createHarness()
		registerOpice(h)
		const id = seedUser(h.sqlite, { sub: 'sub-other-app', email: 'other-app@example.com' })
		seedGrant(h.sqlite, id, 'admin', null)

		const res = await run(h, adminRequest(READ_PATH, { bearer: await proxyToken(h, 'some-other-app', id) }))

		expect(res.status).toBe(403)
	})

	test('an installation registering NO gateway audience refuses even the console token', async () => {
		const h = createHarness()
		registerOpice(h)
		const id = seedUser(h.sqlite, { sub: 'sub-closed', email: 'closed@example.com' })
		seedGrant(h.sqlite, id, 'admin', null)
		const bearer = await proxyToken(h, 'vozka', id)

		const res = await runAs(adminServices(h, new Set()), adminRequest(READ_PATH, { bearer }))

		expect(res.status).toBe(403)
	})

	test('a REGISTERED non-default audience is admitted → 200', async () => {
		const h = createHarness()
		registerOpice(h)
		const id = seedUser(h.sqlite, { sub: 'sub-second-gw', email: 'second-gw@example.com' })
		seedGrant(h.sqlite, id, 'admin', null)
		const bearer = await proxyToken(h, 'second-gateway', id)

		const services = adminServices(h, new Set(['second-gateway']))
		const res = await runAs(services, adminRequest(READ_PATH, { bearer }))

		expect(res.status).toBe(200)
	})

	test("the token's `perms` snapshot is never authority: `*` at the gateway, nothing at propustka → 403", async () => {
		// The grant is scoped to the gateway's own app, so the minted token carries `*` while the caller
		// holds nothing at propustka. IAM re-resolves live, so the snapshot buys the caller nothing.
		const h = createHarness()
		registerOpice(h)
		const id = seedUser(h.sqlite, { sub: 'sub-vozka-only', email: 'vozka-only@example.com' })
		seedGrant(h.sqlite, id, 'admin', null, 'vozka')
		const bearer = await proxyToken(h, 'vozka', id)

		const claims = await verifyAccessToken(await getSigner(ADMIN_ENV), bearer, { issuer: ORIGIN })
		expect(claims?.perms.map((entry) => entry.action)).toContain('*')

		const res = await run(h, adminRequest(READ_PATH, { bearer }))

		expect(res.status).toBe(403)
	})
})

describe('handleAdmin — bearer-only admission', () => {
	test("a GLOBAL admin's valid session cookie alone → 401: no browser cookie is read", async () => {
		const h = createHarness()
		registerOpice(h)
		const id = seedUser(h.sqlite, { sub: 'sub-cookie-admin', email: 'cookie-admin@example.com' })
		seedGrant(h.sqlite, id, 'admin', null)
		const session = await h.signSession(id)

		const read = await run(h, adminRequest(READ_PATH, { session }))
		const write = await run(h, adminRequest('/admin/api-keys', { method: 'POST', session, body: {} }))

		expect(read.status).toBe(401)
		expect(write.status).toBe(401)
	})

	test('the same admin with the console bearer → 200', async () => {
		const h = createHarness()
		registerOpice(h)
		const id = seedUser(h.sqlite, { sub: 'sub-bearer-admin', email: 'bearer-admin@example.com' })
		seedGrant(h.sqlite, id, 'admin', null)
		const session = await h.signSession(id)

		const res = await run(h, adminRequest(READ_PATH, { session, bearer: await consoleToken(h, id) }))

		expect(res.status).toBe(200)
	})

	test('/admin/rpc with only a session cookie → 401', async () => {
		const h = createHarness()
		const id = seedUser(h.sqlite, { sub: 'sub-rpc-cookie', email: 'rpc-cookie@example.com' })
		seedGrant(h.sqlite, id, 'admin', null)
		const session = await h.signSession(id)

		const res = await createIamApp().fetch(
			new Request(`${ORIGIN}/admin/rpc`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: `__Host-px_session=${session}` },
				body: JSON.stringify({ method: 'me', input: null }),
			}),
			env(h),
			exec,
		)

		expect(res.status).toBe(401)
	})
})

describe('audit.list read path tolerates malformed JSON columns', () => {
	test('a row whose diff/metadata is not JSON reads as null instead of 500-ing', async () => {
		// `audit_events.diff`/`metadata` used to carry `CHECK (json_valid(...))`, which let the DTO
		// mapper JSON-parse with no guard. That CHECK is SQLite-only, so it is gone from the
		// migrations and a hand-written / out-of-band row can now hold anything. The read path
		// must degrade to null, not throw.
		const h = createHarness()
		const id = seedUser(h.sqlite, { sub: 'sub-audit', email: 'audit@example.com' })
		seedGrant(h.sqlite, id, 'admin', null)
		h.sqlite.run(
			`INSERT INTO audit_events (id, request_id, principal_id, principal_label, app, action, resource_type, diff, metadata, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			['aud-junk', 'req-1', id, 'audit@example.com', 'opice', 'x.update', 'x', 'not json', '{"ok":', 1_782_896_400],
		)

		const res = await rpc(h, await consoleToken(h, id), 'audit.list', {})

		expect(res.status).toBe(200)
		const items = prop(prop(await res.json(), 'result'), 'items')
		expect(Array.isArray(items)).toBe(true)
		const first = Array.isArray(items) ? items[0] : undefined
		expect(prop(first, 'id')).toBe('aud-junk')
		expect(prop(first, 'diff')).toBeNull()
		expect(prop(first, 'metadata')).toBeNull()
	})
})

describe('principals.list filters', () => {
	test('an unknown status is a validation error, not a silently empty page', async () => {
		// The REST mirror answered `{ items: [] }` for a status it did not recognize, which reads as
		// "no such users" rather than "no such status". The contract's enum refuses it outright.
		const h = createHarness()
		const id = seedUser(h.sqlite, { sub: 'sub-filter-admin', email: 'filter-admin@example.com' })
		seedGrant(h.sqlite, id, 'admin', null)
		seedUser(h.sqlite, { sub: 'sub-filter-user', email: 'filter-user@example.com' })

		const response = await rpc(h, await consoleToken(h, id), 'principals.list', { status: 'unknown' })

		expect(response.status).toBe(400)
		expect(prop(prop(await response.json(), 'error'), 'type')).toBe('validation')
	})
})
