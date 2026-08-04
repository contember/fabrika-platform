import type { SqlDatabase } from '@fabrika/platform'
import { describe, expect, test } from 'bun:test'
import { createIamApp } from '../app'
import type { Env } from '../env'
import { prop } from '../json'
import { createHarness, type Harness, seedAppAction, seedGrant, seedUser } from './helpers/harness'

const ORIGIN = 'https://iam.example.com'
const unusedDatabase: SqlDatabase = {
	prepare() {
		throw new Error('database access was not expected')
	},
	batch() {
		return Promise.reject(new Error('database access was not expected'))
	},
}
const exec = { waitUntil() {} }

interface EnvOptions {
	bootstrapAdmins?: string[]
	provisioningKey?: string
	/** Registered admin origins. Defaults to the console origin these tests drive from. */
	adminOrigins?: string[]
}

function env(h: Harness, options: EnvOptions = {}): Env {
	return {
		DB: unusedDatabase,
		REPOSITORIES: h.repositories,
		HUMAN_EMAIL_DOMAINS: '[]',
		HUMAN_EMAILS: '[]',
		IAM_BOOTSTRAP_ADMINS: JSON.stringify(options.bootstrapAdmins ?? []),
		ADMIN_ORIGINS: JSON.stringify(options.adminOrigins ?? [ORIGIN]),
		ENVIRONMENT: 'stage',
		ISSUER: ORIGIN,
		FABRIKA_IAM_SIGNING_KEYS: '',
		FABRIKA_IAM_PROVISIONING_KEY: options.provisioningKey ?? '',
		SESSION_COOKIE_DOMAIN: '',
		OIDC_ISSUER: 'https://idp.test',
		OIDC_CLIENT_ID: 'client',
		OIDC_CLIENT_SECRET: 'secret',
		OIDC_SCOPES: '',
		OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
	}
}

interface CallOptions {
	session?: string
	bearer?: string
	origin?: string | null
	requestId?: string
	env?: EnvOptions
}

function rpcRequest(method: string, input: unknown, options: CallOptions = {}): Request {
	const headers = new Headers({ 'content-type': 'application/json' })
	if (options.session !== undefined) headers.set('cookie', `px_session=${options.session}`)
	if (options.bearer !== undefined) headers.set('authorization', `Bearer ${options.bearer}`)
	if (options.requestId !== undefined) headers.set('x-request-id', options.requestId)
	const origin = options.origin === undefined ? ORIGIN : options.origin
	if (origin !== null) headers.set('origin', origin)
	return new Request(`${ORIGIN}/admin/rpc`, { method: 'POST', headers, body: JSON.stringify({ method, input }) })
}

function fetchRpc(h: Harness, request: Request, options: EnvOptions = {}): Promise<Response> {
	return createIamApp().fetch(
		request,
		env(h, options),
		exec,
	)
}

function call(h: Harness, method: string, input: unknown, options: CallOptions = {}): Promise<Response> {
	return fetchRpc(h, rpcRequest(method, input, options), options.env)
}

async function admin(h: Harness, scoped = false): Promise<string> {
	const id = seedUser(h.sqlite, { sub: `sub-${scoped ? 'scoped' : 'admin'}`, email: `${scoped ? 'scoped' : 'admin'}@example.com` })
	seedGrant(h.sqlite, id, 'admin', scoped ? { type: 'team', value: 'acme' } : null)
	return h.signSession(id)
}

describe('POST /admin/rpc authentication', () => {
	test('missing human session returns a structural auth error with loginUrl', async () => {
		const response = await call(createHarness(), 'me', null)
		const body: unknown = await response.json()

		expect(response.status).toBe(401)
		expect(prop(prop(body, 'error'), 'type')).toBe('auth')
		expect(prop(prop(body, 'error'), 'loginUrl')).toBe(`${ORIGIN}/auth/login?redirect=${encodeURIComponent(ORIGIN)}`)
	})

	test('a scope-bound admin grant does not satisfy the global admin gate', async () => {
		const h = createHarness()
		const response = await call(h, 'me', null, { session: await admin(h, true) })

		expect(response.status).toBe(403)
		expect(prop(prop(await response.json(), 'error'), 'type')).toBe('forbidden')
	})

	test('cross-origin RPC is rejected before authentication', async () => {
		const h = createHarness()
		const response = await call(h, 'me', null, { session: await admin(h), origin: 'https://evil.example' })

		expect(response.status).toBe(403)
		expect(prop(prop(await response.json(), 'error'), 'message')).toBe('cross-origin request rejected')
	})

	test('accepts the seeded provisioning bearer', async () => {
		const h = createHarness()
		const key = 'px_provisioning-test-key'
		const response = await call(h, 'me', null, { bearer: key, env: { provisioningKey: key } })
		const me = prop(await response.json(), 'result')

		expect(response.status).toBe(200)
		expect(prop(me, 'id')).toBe('provisioning-admin')
		expect(prop(me, 'type')).toBe('service')
	})

	test('accepts a configured bootstrap admin without a stored admin grant', async () => {
		const h = createHarness()
		const email = 'bootstrap@example.com'
		const id = seedUser(h.sqlite, { sub: 'sub-bootstrap', email })
		const session = await h.signSession(id, { email })
		const response = await call(h, 'me', null, { session, env: { bootstrapAdmins: [email] } })

		expect(response.status).toBe(200)
		expect(prop(prop(await response.json(), 'result'), 'id')).toBe(id)
	})

	test('rejects an invalid bearer without offering a human login bounce', async () => {
		const response = await call(createHarness(), 'me', null, { bearer: 'px_invalid' })
		const failure = prop(await response.json(), 'error')

		expect(response.status).toBe(401)
		expect(prop(failure, 'type')).toBe('auth')
		expect(prop(failure, 'loginUrl')).toBeUndefined()
	})
})

describe('POST /admin/rpc typed operations', () => {
	test('serves queries and mutations through shared use cases', async () => {
		const h = createHarness()
		const session = await admin(h)
		const invite = await call(h, 'principals.invite', { email: 'new@example.com' }, { session })
		const invited = prop(await invite.json(), 'result')
		const id = prop(invited, 'id')

		expect(invite.status).toBe(200)
		expect(typeof id).toBe('string')
		if (typeof id !== 'string') throw new Error('expected principal id')

		const update = await call(h, 'principals.update', { id, disabled: true }, { session })
		expect(prop(prop(await update.json(), 'result'), 'status')).toBe('disabled')

		const list = await call(h, 'principals.list', { type: 'user', status: 'disabled' }, { session })
		const items = prop(prop(await list.json(), 'result'), 'items')
		expect(Array.isArray(items)).toBe(true)
		expect(Array.isArray(items) ? items.some((item) => prop(item, 'id') === id) : false).toBe(true)
	})

	test('returns API-key secrets once without exposing them from list queries', async () => {
		const h = createHarness()
		const session = await admin(h)
		seedAppAction(h.sqlite, 'delivery', 'deploy.run')

		const provision = await call(
			h,
			'apiKeys.provision',
			{ label: 'delivery CI', type: 'service', permissions: ['deploy.run'], app: 'delivery' },
			{ session },
		)
		const secret = prop(prop(await provision.json(), 'result'), 'apiKey')
		expect(typeof secret === 'string' && secret.startsWith('px_')).toBe(true)

		const list = await call(h, 'apiKeys.list', null, { session })
		const serialized = JSON.stringify(prop(await list.json(), 'result'))
		expect(serialized).not.toContain(typeof secret === 'string' ? secret : 'unreachable-secret')
		expect(serialized).not.toContain('apiKey')
	})

	test('maps validation and use-case failures to structural RPC errors', async () => {
		const h = createHarness()
		const session = await admin(h)
		const invalid = await call(h, 'principals.update', { id: '', disabled: 'yes' }, { session })
		const missing = await call(h, 'principals.get', { id: 'missing' }, { session })

		expect(invalid.status).toBe(400)
		expect(prop(prop(await invalid.json(), 'error'), 'type')).toBe('validation')
		expect(missing.status).toBe(404)
		expect(prop(prop(await missing.json(), 'error'), 'type')).toBe('not_found')
	})

	test('uses the request id captured before authentication for audit writes', async () => {
		const h = createHarness()
		const session = await admin(h)
		const request = rpcRequest('principals.invite', { email: 'correlated@example.com' }, { session, requestId: 'first-id' })
		const getPrincipal = h.repositories.principals.getPrincipalById.bind(h.repositories.principals)
		h.repositories.principals.getPrincipalById = async (id) => {
			request.headers.set('x-request-id', 'changed-during-auth')
			return getPrincipal(id)
		}

		const response = await fetchRpc(h, request)
		const row = h.sqlite.query<{ request_id: string }, []>("SELECT request_id FROM audit_events WHERE action = 'iam.principal.invite'").get()

		expect(response.status).toBe(200)
		expect(row?.request_id).toBe('first-id')
	})

	test('maps unexpected authentication repository failures to an opaque internal error', async () => {
		const h = createHarness()
		const session = await admin(h)
		h.repositories.sessions.getActiveSessionByHash = () => Promise.reject(new Error('secret session failure'))

		const response = await call(h, 'me', null, { session })
		const body: unknown = await response.json()

		expect(response.status).toBe(500)
		expect(body).toEqual({ error: { type: 'internal', message: 'internal error' } })
	})

	test('maps unexpected use-case repository failures to an opaque internal error', async () => {
		const h = createHarness()
		const session = await admin(h)
		h.repositories.principals.listPrincipals = () => Promise.reject(new Error('secret principal failure'))

		const response = await call(h, 'principals.list', {}, { session })
		const body: unknown = await response.json()

		expect(response.status).toBe(500)
		expect(body).toEqual({ error: { type: 'internal', message: 'internal error' } })
	})
})
