import { SESSION_COOKIE } from '@fabrika/auth-core'
import type { EmailMessage, EmailSender } from '@fabrika/email'
import { unusedDatabase } from '@fabrika/platform/testing'
import { describe, expect, test } from 'bun:test'
import { type AdminContext, AdminUseCaseError, adminUseCases } from '../admin/handlers'
import { createIamApp } from '../app'
import type { Env } from '../env'
import { prop } from '../json'
import type { Services } from '../services'
import { mintToken } from '../tokens'
import { CONSOLE_APP, createHarness, type Harness, seedGrant, seedService, seedUser, TEST_SIGNING_ENV, TEST_SIGNING_KEYS } from './helpers/harness'

const ORIGIN = 'https://iam.example.com'
const exec = { waitUntil() {} }

interface EnvOptions {
	oidc?: boolean
	password?: boolean
	provisioningKey?: string
	email?: boolean
	bootstrapAdmins?: string[]
}

function env(h: Harness, options: EnvOptions = {}): Env {
	return {
		DB: unusedDatabase,
		REPOSITORIES: h.repositories,
		HUMAN_EMAIL_DOMAINS: '[]',
		HUMAN_EMAILS: '[]',
		IAM_BOOTSTRAP_ADMINS: JSON.stringify(options.bootstrapAdmins ?? []),
		ENVIRONMENT: 'stage',
		OIDC_ENABLED: String(options.oidc ?? true),
		PASSWORD_ENABLED: String(options.password ?? true),
		EMAIL_PROVIDER: options.email === true ? 'resend' : 'none',
		EMAIL_FROM: options.email === true ? 'auth@example.com' : undefined,
		EMAIL_API_KEY: options.email === true ? 're_test_key' : undefined,
		ISSUER: ORIGIN,
		FABRIKA_IAM_SIGNING_KEYS: TEST_SIGNING_KEYS,
		FABRIKA_IAM_PROVISIONING_KEY: options.provisioningKey ?? '',
		OIDC_ISSUER: 'https://idp.test',
		OIDC_CLIENT_ID: 'client',
		OIDC_CLIENT_SECRET: 'secret',
		OIDC_SCOPES: '',
		OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
	}
}

function rpcRequest(method: string, input: unknown, options: { bearer?: string } = {}): Request {
	const headers = new Headers({ 'content-type': 'application/json' })
	if (options.bearer !== undefined) headers.set('authorization', `Bearer ${options.bearer}`)
	return new Request(`${ORIGIN}/admin/rpc`, { method: 'POST', headers, body: JSON.stringify({ method, input }) })
}

function actionToken(url: string): string | null {
	return new URLSearchParams(new URL(url).hash.slice(1)).get('token')
}

function cookieValue(response: Response, name: string): string | null {
	for (const header of response.headers.getSetCookie()) {
		if (!header.startsWith(`${name}=`)) continue
		return header.slice(name.length + 1).split(';')[0] ?? null
	}
	return null
}

function call(
	h: Harness,
	method: string,
	input: unknown,
	options: { bearer?: string; env?: EnvOptions } = {},
): Promise<Response> {
	return createIamApp().fetch(rpcRequest(method, input, options), env(h, options.env), exec)
}

async function admin(h: Harness): Promise<{ id: string; bearer: string }> {
	const id = seedUser(h.sqlite, { sub: 'sub-admin', email: 'admin@example.com' })
	seedGrant(h.sqlite, id, 'admin', null)
	return { id, bearer: await h.adminToken(id, { issuer: ORIGIN }) }
}

function passwordServices(h: Harness, email: EmailSender | null = null, oidc: boolean = true): Services {
	return h.makeServices({ authentication: { oidc, password: true }, email, issuer: ORIGIN })
}

function directContext(h: Harness, services: Services, adminId: string): AdminContext {
	return {
		services,
		request: new Request(`${ORIGIN}/admin/rpc`, { method: 'POST' }),
		url: new URL(`${ORIGIN}/admin/rpc`),
		admin: { id: adminId, type: 'user', label: 'Admin', permissions: [{ action: 'iam.admin', scope: null, source: 'grant' }] },
		app: 'fabrika-iam',
		requestId: 'request-password-admin',
		ctx: exec,
	}
}

function storedPassword() {
	return {
		algorithm: 'test-password-hash',
		parameters: '{}',
		salt: 'test-salt',
		passwordHash: 'test-derived-value',
	}
}

describe('password administration RPC', () => {
	test('requires the existing global admin permission', async () => {
		const h = createHarness()
		const user = seedUser(h.sqlite, { sub: null, email: 'user@example.com' })

		const response = await call(h, 'passwords.issueEnrollment', { principalId: user })

		expect(response.status).toBe(401)
		expect(prop(prop(await response.json(), 'error'), 'type')).toBe('auth')
	})

	test('provisioning bearer can invite the first user and issue a manual enrollment link', async () => {
		const h = createHarness()
		const key = 'px_provisioning-password-bootstrap'
		const options = { bearer: key, env: { provisioningKey: key } }
		const invite = await call(h, 'principals.invite', { email: 'first-admin@example.com' }, options)
		const principalId = prop(prop(await invite.json(), 'result'), 'id')
		if (typeof principalId !== 'string') throw new Error('expected principal id')

		const enrollmentIssue = await call(h, 'passwords.issueEnrollment', { principalId: principalId }, options)
		const result = prop(await enrollmentIssue.json(), 'result')

		expect(invite.status).toBe(200)
		expect(enrollmentIssue.status).toBe(200)
		expect(prop(result, 'delivery')).toBe('manual')
		const actionUrl = prop(result, 'url')
		expect(actionUrl).toStartWith(`${ORIGIN}/auth/password/enroll#token=`)
		if (typeof actionUrl !== 'string') throw new Error('expected action URL')
		const plaintextToken = actionToken(actionUrl)
		if (plaintextToken === null) throw new Error('expected action token')
		expect((await h.repositories.passwords.getAccount(principalId))?.state).toBe('pending')
		const stored = h.sqlite.query<{ token_hash: string }, [string]>(
			'SELECT token_hash FROM password_action_tokens WHERE principal_id = ?',
		).get(principalId)
		expect(stored?.token_hash).not.toBe(plaintextToken)
		const audit = h.sqlite.query<{ metadata: string | null }, []>(
			"SELECT metadata FROM audit_events WHERE action = 'iam.password.enrollment.issue'",
		).get()
		expect(audit?.metadata).toBe('{"delivery":"manual"}')
		expect(JSON.stringify(audit)).not.toContain(plaintextToken)

		const enrollment = await createIamApp().fetch(
			new Request(`${ORIGIN}/auth/password/enroll`, {
				method: 'POST',
				headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ token: plaintextToken, password: 'a secure first administrator password' }),
			}),
			env(h, { oidc: false, password: true, bootstrapAdmins: [' First-Admin@Example.com '] }),
			exec,
		)
		const session = cookieValue(enrollment, SESSION_COOKIE)
		if (session === null) throw new Error('expected enrollment session')
		// The console reaches IAM admin with the token the proxy mints from that session.
		const services = h.makeServices({ environment: 'stage', issuer: ORIGIN, authentication: { oidc: false, password: true } })
		const minted = await mintToken(services, TEST_SIGNING_ENV, { app: CONSOLE_APP, session, requestId: 'r1' })
		if (!minted.result.ok) throw new Error(`console token mint failed: ${minted.result.reason}`)
		const me = await call(h, 'me', null, { bearer: minted.result.token, env: { bootstrapAdmins: [' First-Admin@Example.com '] } })
		expect(me.status).toBe(200)
		expect(prop(prop(await me.json(), 'result'), 'id')).toBe(principalId)
	})

	test('rejects case-variant admin invites, including concurrent attempts', async () => {
		const h = createHarness()
		const { bearer } = await admin(h)
		const [first, second] = await Promise.all([
			call(h, 'principals.invite', { email: 'Alice@example.com' }, { bearer }),
			call(h, 'principals.invite', { email: 'alice@example.com' }, { bearer }),
		])

		expect([first.status, second.status].sort()).toEqual([200, 409])
		expect((await h.repositories.passwords.lookupActionUser('alice@example.com')).status).toBe('found')
	})

	test('shows global and per-user method states and keeps reissued enrollment pending', async () => {
		const h = createHarness()
		const { bearer } = await admin(h)
		const user = seedUser(h.sqlite, { sub: null, email: 'pending@example.com' })

		const before = await call(h, 'principals.get', { principalId: user }, { bearer })
		const beforeAuth = prop(prop(await before.json(), 'result'), 'authentication')
		expect(prop(prop(beforeAuth, 'oidc'), 'state')).toBe('unlinked')
		expect(prop(prop(beforeAuth, 'password'), 'state')).toBe('disabled')

		const first = await call(h, 'passwords.issueEnrollment', { principalId: user }, { bearer })
		const firstUrl = prop(prop(await first.json(), 'result'), 'url')
		const second = await call(h, 'passwords.issueEnrollment', { principalId: user }, { bearer })
		const secondUrl = prop(prop(await second.json(), 'result'), 'url')

		expect(first.status).toBe(200)
		expect(second.status).toBe(200)
		expect(secondUrl).not.toBe(firstUrl)
		expect((await h.repositories.passwords.getAccount(user))?.state).toBe('pending')
		const after = await call(h, 'principals.get', { principalId: user }, { bearer })
		expect(prop(prop(prop(prop(await after.json(), 'result'), 'authentication'), 'password'), 'state')).toBe('pending')
		const tokens = h.sqlite.query<{ consumed_at: number | null }, [string]>(
			'SELECT consumed_at FROM password_action_tokens WHERE principal_id = ? ORDER BY created_at, id',
		).all(user)
		expect(tokens).toHaveLength(2)
		expect(tokens.filter((token) => token.consumed_at === null)).toHaveLength(1)
	})

	test('reports globally unavailable OIDC without linking or changing the stored identity', async () => {
		const h = createHarness()
		const { bearer } = await admin(h)
		const user = seedUser(h.sqlite, { sub: 'idp-subject', email: 'linked@example.com' })

		const response = await call(h, 'principals.get', { principalId: user }, { bearer, env: { oidc: false } })
		const result = prop(await response.json(), 'result')

		expect(prop(prop(prop(result, 'authentication'), 'oidc'), 'state')).toBe('unavailable')
		expect(prop(result, 'externalId')).toBe('idp-subject')
	})

	test('rejects service principals and reset before password enrollment completes', async () => {
		const h = createHarness()
		const { bearer } = await admin(h)
		const service = seedService(h.sqlite, { commonName: 'worker' })
		const user = seedUser(h.sqlite, { sub: null, email: 'not-enabled@example.com' })

		const serviceResponse = await call(h, 'passwords.issueEnrollment', { principalId: service }, { bearer })
		const resetResponse = await call(h, 'passwords.issueReset', { principalId: user }, { bearer })

		expect(serviceResponse.status).toBe(400)
		expect(resetResponse.status).toBe(409)
	})

	test('returns email delivery without a URL through the typed RPC', async () => {
		const h = createHarness()
		const { bearer } = await admin(h)
		const user = seedUser(h.sqlite, { sub: null, email: 'rpc-mail@example.com' })
		const originalFetch = globalThis.fetch
		let requestBody = ''
		globalThis.fetch = Object.assign(
			async (...args: Parameters<typeof fetch>) => {
				const init = args[1]
				requestBody = typeof init?.body === 'string' ? init.body : ''
				return Response.json({ id: 'email-message-id' })
			},
			{ preconnect: originalFetch.preconnect },
		)
		let response: Response
		try {
			response = await call(h, 'passwords.issueEnrollment', { principalId: user }, { bearer, env: { email: true } })
		} finally {
			globalThis.fetch = originalFetch
		}
		const result = prop(await response.json(), 'result')

		expect(response.status).toBe(200)
		expect(prop(result, 'delivery')).toBe('email')
		expect(prop(result, 'email')).toBe('rpc-mail@example.com')
		expect(prop(result, 'url')).toBeUndefined()
		expect(requestBody).toContain('/auth/password/enroll#token=')
	})

	test('maps failed email delivery to an opaque typed RPC error', async () => {
		const h = createHarness()
		const { bearer } = await admin(h)
		const user = seedUser(h.sqlite, { sub: null, email: 'rpc-failure@example.com' })
		const originalFetch = globalThis.fetch
		const originalError = console.error
		const logs: unknown[][] = []
		globalThis.fetch = Object.assign(
			async (..._args: Parameters<typeof fetch>) => Response.json({ name: 'internal_error', message: 'private provider body' }, { status: 500 }),
			{ preconnect: originalFetch.preconnect },
		)
		console.error = (...args: unknown[]) => {
			logs.push(args)
		}
		let response: Response
		try {
			response = await call(h, 'passwords.issueEnrollment', { principalId: user }, { bearer, env: { email: true } })
		} finally {
			globalThis.fetch = originalFetch
			console.error = originalError
		}

		expect(response.status).toBe(500)
		expect(prop(prop(await response.json(), 'error'), 'message')).toBe('internal error')
		expect(logs).toEqual([['Password action email delivery failed']])
	})
})

describe('password administration delivery and audit', () => {
	test('sends enrollment email without returning its URL and audits no secret material', async () => {
		const h = createHarness()
		const { id: adminId } = await admin(h)
		const user = seedUser(h.sqlite, { sub: null, email: 'mail-user@example.com' })
		const messages: EmailMessage[] = []
		const sender: EmailSender = {
			async send(message) {
				messages.push(message)
				return { status: 'accepted', provider: 'test', messageId: 'message-1' }
			},
		}
		const c = directContext(h, passwordServices(h, sender), adminId)

		const result = await adminUseCases.issuePasswordEnrollment(c, { principalId: user })

		expect(result).toEqual({ delivery: 'email', email: 'mail-user@example.com', expiresAt: expect.any(Number) })
		expect(JSON.stringify(result)).not.toContain('token=')
		expect(messages).toHaveLength(1)
		expect(messages[0]?.to).toBe('mail-user@example.com')
		expect(messages[0]?.text).toContain('/auth/password/enroll#token=')
		const audit = h.sqlite.query<{ action: string; diff: string | null; metadata: string | null }, []>(
			"SELECT action, diff, metadata FROM audit_events WHERE action = 'iam.password.enrollment.issue'",
		).get()
		expect(audit?.metadata).toBe('{"delivery":"email"}')
		expect(JSON.stringify(audit)).not.toContain('token=')
		expect(JSON.stringify(audit)).not.toContain('test-derived-value')
	})

	test('returns an honest failure, leaves the action reissuable, and logs no sender error details', async () => {
		const h = createHarness()
		const { id: adminId } = await admin(h)
		const user = seedUser(h.sqlite, { sub: null, email: 'private-address@example.com' })
		const sender: EmailSender = {
			send() {
				return Promise.reject(new Error('provider body with private-address@example.com and secret-token'))
			},
		}
		const c = directContext(h, passwordServices(h, sender), adminId)
		const logs: unknown[][] = []
		const originalError = console.error
		let failure: unknown
		console.error = (...args: unknown[]) => {
			logs.push(args)
		}
		try {
			await adminUseCases.issuePasswordEnrollment(c, { principalId: user })
		} catch (cause) {
			failure = cause
		} finally {
			console.error = originalError
		}

		expect(failure).toBeInstanceOf(AdminUseCaseError)
		if (!(failure instanceof AdminUseCaseError)) throw new Error('expected admin use-case failure')
		expect(failure.httpStatus).toBe(502)
		expect(logs).toEqual([['Password action email delivery failed']])
		expect(JSON.stringify(logs)).not.toContain('private-address@example.com')
		expect(JSON.stringify(logs)).not.toContain('secret-token')
		expect((await h.repositories.passwords.getAccount(user))?.state).toBe('pending')
		const token = h.sqlite.query<{ consumed_at: number | null }, [string]>(
			'SELECT consumed_at FROM password_action_tokens WHERE principal_id = ?',
		).get(user)
		expect(token?.consumed_at).toBeNull()
		const audit = h.sqlite.query<{ metadata: string | null }, []>(
			"SELECT metadata FROM audit_events WHERE action = 'iam.password.enrollment.issue'",
		).get()
		expect(audit?.metadata).toBe('{"delivery":"email"}')
		const failed = h.sqlite.query<{ n: number }, []>(
			"SELECT COUNT(*) AS n FROM audit_events WHERE action = 'iam.password.enrollment.delivery_failed'",
		).get()
		expect(failed?.n).toBe(1)
	})

	test('reset works only for enabled accounts', async () => {
		const h = createHarness()
		const { id: adminId } = await admin(h)
		const user = seedUser(h.sqlite, { sub: 'sub-reset', email: 'reset@example.com' })
		await h.repositories.passwords.upsertCredential(user, storedPassword())
		const c = directContext(h, passwordServices(h), adminId)

		const result = await adminUseCases.issuePasswordReset(c, { principalId: user })

		expect(result.delivery).toBe('manual')
		if (result.delivery !== 'manual') throw new Error('expected manual reset')
		expect(result.url).toStartWith(`${ORIGIN}/auth/password/reset#token=`)
	})

	test('disable works for a soft-disabled user and revokes only password-origin sessions', async () => {
		const h = createHarness()
		const { id: adminId } = await admin(h)
		const user = seedUser(h.sqlite, { sub: 'sub-hybrid', email: 'hybrid@example.com', disabled: true })
		await h.repositories.passwords.upsertCredential(user, storedPassword())
		await h.repositories.passwords.issueActionToken({
			principalId: user,
			purpose: 'reset',
			tokenHash: 'reset-action-hash',
			issuedBy: adminId,
			expiresAt: Math.floor(Date.now() / 1000) + 3600,
		})
		await h.signSession(user, { authenticationMethod: 'oidc', idpSub: 'sub-hybrid' })
		await h.repositories.sessions.createSession({
			tokenHash: 'password-session-hash',
			principalId: user,
			email: 'hybrid@example.com',
			authenticationMethod: 'password',
			expiresAt: Math.floor(Date.now() / 1000) + 3600,
		})
		const c = directContext(h, passwordServices(h), adminId)

		await adminUseCases.disablePassword(c, { principalId: user })

		expect((await h.repositories.passwords.getAccount(user))?.state).toBe('disabled')
		expect(await h.repositories.passwords.getCredential(user)).toBeNull()
		const action = h.sqlite.query<{ consumed_at: number | null }, [string]>(
			'SELECT consumed_at FROM password_action_tokens WHERE principal_id = ?',
		).get(user)
		expect(action?.consumed_at).not.toBeNull()
		const sessions = await h.repositories.sessions.listSessionsForPrincipal(user, { limit: 50 })
		expect(sessions.find((session) => session.authentication_method === 'oidc')?.revoked_at).toBeNull()
		expect(sessions.find((session) => session.authentication_method === 'password')?.revoked_at).not.toBeNull()
		const audit = h.sqlite.query<{ action: string }, []>("SELECT action FROM audit_events WHERE action = 'iam.password.disable'").get()
		expect(audit?.action).toBe('iam.password.disable')
	})
})
