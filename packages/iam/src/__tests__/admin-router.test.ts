import { describe, expect, test } from 'bun:test'
import { handleAdmin } from '../admin/router'
import type { Env, RequestContext } from '../env'
import { prop } from '../json'
import type { Services } from '../services'
import { createHarness, type Harness, seedGrant, seedRole, seedUser } from './helpers/harness'

// FINDING TEST-2: the admin gate wiring in handleAdmin. Every /admin/* request must
// pass a scope-less can('iam.admin') check — satisfied ONLY by a GLOBAL `admin`
// grant (or bootstrap), NEVER by a project-scoped one. This drives handleAdmin end
// to end with a real propustka-native SSO session (`px_session` cookie → real Db over
// bun:sqlite) and asserts the HTTP status, covering the core security property plus the
// missing/invalid/disabled mapping and the SEC-2 same-origin CSRF guard.

const ORIGIN = 'https://iam.example.com'

// The admin app id every native session is resolved against (see admin/router.ts).
const IAM_APP = 'propustka'

// env slice handleAdmin needs. ENVIRONMENT='stage' keeps the local-dev bypass off, so the
// session/credential paths are exercised for real.
const ADMIN_ENV: Pick<Env, 'FABRIKA_IAM_SIGNING_KEYS' | 'FABRIKA_IAM_PROVISIONING_KEY' | 'ENVIRONMENT'> = {
	FABRIKA_IAM_SIGNING_KEYS: '',
	FABRIKA_IAM_PROVISIONING_KEY: '',
	ENVIRONMENT: 'stage',
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
	/** Origin header to send (defaults to same-origin ORIGIN for state-changing methods). */
	origin?: string | null
}

function adminRequest(path: string, opts: RequestOptions = {}): Request {
	const headers = new Headers()
	if (opts.session) {
		headers.set('Cookie', `px_session=${opts.session}`)
	}
	const method = opts.method ?? 'GET'
	const stateChanging = method === 'POST' || method === 'PATCH' || method === 'DELETE'
	// Default state-changing requests to same-origin so they clear the CSRF guard and
	// reach the gate (unless a test overrides `origin` to probe the guard itself).
	const origin = opts.origin === undefined ? (stateChanging ? ORIGIN : null) : opts.origin
	if (origin !== null) {
		headers.set('Origin', origin)
	}
	return new Request(`${ORIGIN}${path}`, { method, headers })
}

// Services in 'stage' so the local-dev bypass precondition is off (the session path runs for real).
function adminServices(h: Harness): Services {
	return h.makeServices({ environment: 'stage' })
}

async function run(h: Harness, request: Request): Promise<Response> {
	return handleAdmin(request, adminServices(h), ADMIN_ENV, new FakeRequestContext())
}

describe('handleAdmin — admin gate (scope-less iam.admin)', () => {
	test('GLOBAL admin grant → 200 (passes the gate)', async () => {
		const h = createHarness()
		const id = seedUser(h.sqlite, { sub: 'sub-admin', email: 'admin@example.com' })
		seedGrant(h.sqlite, id, 'admin', null) // global

		const session = await h.signSession(id)
		const res = await run(h, adminRequest('/admin/roles', { session }))

		expect(res.status).toBe(200)
	})

	test('SCOPE-BOUND admin grant → 403 (scope-less iam.admin is not satisfied by a scoped entry)', async () => {
		// The core security property: an `admin` grant pinned to one scope value must
		// NOT confer the global admin capability.
		const h = createHarness()
		const id = seedUser(h.sqlite, { sub: 'sub-scoped', email: 'scoped@example.com' })
		seedGrant(h.sqlite, id, 'admin', { type: 'team', value: 'acme' }) // scope-bound

		const session = await h.signSession(id)
		const res = await run(h, adminRequest('/admin/roles', { session }))

		expect(res.status).toBe(403)
	})

	test('only a viewer grant → 403', async () => {
		const h = createHarness()
		seedRole(h.sqlite, IAM_APP, 'viewer', ['project.read'])
		const id = seedUser(h.sqlite, { sub: 'sub-viewer', email: 'viewer@example.com' })
		seedGrant(h.sqlite, id, 'viewer', null, IAM_APP)

		const session = await h.signSession(id)
		const res = await run(h, adminRequest('/admin/roles', { session }))

		expect(res.status).toBe(403)
	})

	test('no session → 401 (missing_token)', async () => {
		const h = createHarness()
		const res = await run(h, adminRequest('/admin/roles'))

		expect(res.status).toBe(401)
	})

	test('invalid (unknown) session → 401', async () => {
		const h = createHarness()
		const res = await run(h, adminRequest('/admin/roles', { session: 'sess-does-not-exist' }))

		expect(res.status).toBe(401)
	})

	test('disabled principal with a global admin grant → 403 (disabled)', async () => {
		const h = createHarness()
		const id = seedUser(h.sqlite, { sub: 'sub-disabled', email: 'disabled@example.com', disabled: true })
		seedGrant(h.sqlite, id, 'admin', null)

		const session = await h.signSession(id)
		const res = await run(h, adminRequest('/admin/roles', { session }))

		expect(res.status).toBe(403)
	})

	test('GET /admin/me with a global admin grant → 200 (gate also fronts /me)', async () => {
		const h = createHarness()
		const id = seedUser(h.sqlite, { sub: 'sub-me', email: 'me@example.com' })
		seedGrant(h.sqlite, id, 'admin', null)

		const session = await h.signSession(id)
		const res = await run(h, adminRequest('/admin/me', { session }))

		expect(res.status).toBe(200)
	})
})

describe('handleAdmin — same-origin CSRF guard (SEC-2)', () => {
	test('cross-origin state-changing POST → 403 BEFORE the gate (even for a global admin)', async () => {
		// The CSRF check runs before the caller is resolved, so a valid admin session does not
		// rescue a cross-origin write.
		const h = createHarness()
		const id = seedUser(h.sqlite, { sub: 'sub-admin2', email: 'admin2@example.com' })
		seedGrant(h.sqlite, id, 'admin', null)

		const session = await h.signSession(id)
		const res = await run(
			h,
			adminRequest('/admin/grants', { method: 'POST', session, origin: 'https://evil.example.com' }),
		)

		expect(res.status).toBe(403)
		const body: unknown = await res.json()
		expect(body).toEqual({ error: 'cross-origin request rejected' })
	})

	test('same-origin state-changing POST is NOT blocked by the CSRF guard (reaches the gate)', async () => {
		// A same-origin POST from a non-admin clears the CSRF guard and is rejected by
		// the gate instead (403 'admin permission required'), proving the guard let it
		// through rather than blocking on origin.
		const h = createHarness()
		seedRole(h.sqlite, IAM_APP, 'viewer', ['project.read'])
		const id = seedUser(h.sqlite, { sub: 'sub-v2', email: 'v2@example.com' })
		seedGrant(h.sqlite, id, 'viewer', null, IAM_APP)

		const session = await h.signSession(id)
		const res = await run(h, adminRequest('/admin/grants', { method: 'POST', session, origin: ORIGIN }))

		expect(res.status).toBe(403)
		const body: unknown = await res.json()
		expect(body).toEqual({ error: 'admin permission required' })
	})
})

describe('handleAdmin — audit read path tolerates malformed JSON columns', () => {
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

		const session = await h.signSession(id)
		const res = await run(h, adminRequest('/admin/audit', { session }))

		expect(res.status).toBe(200)
		const body: unknown = await res.json()
		const items = prop(body, 'items')
		expect(Array.isArray(items)).toBe(true)
		const first = Array.isArray(items) ? items[0] : undefined
		expect(prop(first, 'id')).toBe('aud-junk')
		expect(prop(first, 'diff')).toBeNull()
		expect(prop(first, 'metadata')).toBeNull()
	})
})

describe('handleAdmin — principal filters', () => {
	test('an invalid status preserves the legacy empty-list response', async () => {
		const h = createHarness()
		const id = seedUser(h.sqlite, { sub: 'sub-filter-admin', email: 'filter-admin@example.com' })
		seedGrant(h.sqlite, id, 'admin', null)
		seedUser(h.sqlite, { sub: 'sub-filter-user', email: 'filter-user@example.com' })

		const response = await run(h, adminRequest('/admin/principals?status=unknown', { session: await h.signSession(id) }))
		const body: unknown = await response.json()

		expect(response.status).toBe(200)
		expect(prop(body, 'items')).toEqual([])
	})
})
