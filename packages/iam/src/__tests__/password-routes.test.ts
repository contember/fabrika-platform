import { SESSION_COOKIE } from '@fabrika/auth-core'
import type { EmailDeliveryResult, EmailMessage, EmailSender } from '@fabrika/email'
import { describe, expect, test } from 'bun:test'
import { handleAuth, safeRedirect } from '../auth/routes'
import type { RequestContext } from '../env'
import type { PasswordHasher, StoredPasswordHash } from '../password-crypto'
import { issuePasswordAction } from '../password-service'
import { hashToken } from '../secret'
import type { Services } from '../services'
import { createHarness, type Harness, seedUser } from './helpers/harness'

const ISSUER = 'http://localhost:18191'
const AUTH_ENV = { FABRIKA_IAM_SIGNING_KEYS: '', ENVIRONMENT: 'local' }

class FastPasswordHasher implements PasswordHasher {
	hashCalls = 0
	verifyCalls = 0

	async hash(password: string): Promise<StoredPasswordHash> {
		this.hashCalls += 1
		return { algorithm: 'test', parameters: '{}', salt: 'salt', passwordHash: `hash:${password}` }
	}

	async verify(password: string, stored: StoredPasswordHash) {
		this.verifyCalls += 1
		return { valid: stored.passwordHash === `hash:${password}`, needsRehash: false }
	}
}

class CapturingEmail implements EmailSender {
	readonly messages: EmailMessage[] = []
	constructor(private readonly fail = false) {}

	async send(message: EmailMessage): Promise<EmailDeliveryResult> {
		this.messages.push(message)
		if (this.fail) throw new Error('delivery failed')
		return { status: 'accepted', provider: 'test', messageId: `message-${this.messages.length}` }
	}
}

class TestContext implements RequestContext {
	readonly pending: Promise<unknown>[] = []
	readonly waitUntil = (promise: Promise<unknown>): void => {
		this.pending.push(promise)
	}
	async drain(): Promise<void> {
		await Promise.all(this.pending)
	}
}

function passwordServices(options: {
	oidc?: boolean
	email?: EmailSender | null
	bootstrapAdmins?: ReadonlySet<string>
	hasher?: FastPasswordHasher
} = {}) {
	const h = createHarness()
	const hasher = options.hasher ?? new FastPasswordHasher()
	const services = h.makeServices({
		issuer: ISSUER,
		authentication: { oidc: options.oidc ?? false, password: true },
		passwordHasher: hasher,
		email: options.email ?? null,
		bootstrapAdmins: options.bootstrapAdmins,
	})
	return { h, hasher, services }
}

function post(path: string, fields: Record<string, string>, headers: Record<string, string> = {}): Request {
	return new Request(`${ISSUER}${path}`, {
		method: 'POST',
		headers: {
			Origin: ISSUER,
			'Sec-Fetch-Site': 'same-origin',
			'Content-Type': 'application/x-www-form-urlencoded',
			'CF-Connecting-IP': '192.0.2.10',
			...headers,
		},
		body: new URLSearchParams(fields),
	})
}

function cookieValue(response: Response, name: string): string | null {
	for (const header of response.headers.getSetCookie()) {
		if (!header.startsWith(`${name}=`)) continue
		return header.slice(name.length + 1).split(';')[0] ?? null
	}
	return null
}

describe('password login modes and CSRF', () => {
	test('renders password-only and hybrid login choices', async () => {
		const passwordOnly = passwordServices()
		const passwordResponse = await handleAuth(new Request(`${ISSUER}/auth/login`), passwordOnly.services, AUTH_ENV, new TestContext())
		expect(await passwordResponse.text()).toContain('autocomplete="current-password"')
		expect(passwordResponse.status).toBe(200)

		const hybrid = passwordServices({ oidc: true })
		const hybridResponse = await handleAuth(new Request(`${ISSUER}/auth/login`), hybrid.services, AUTH_ENV, new TestContext())
		expect(await hybridResponse.text()).toContain('Continue with single sign-on')
	})

	test('fails OIDC start and callback closed when OIDC is disabled', async () => {
		const { services } = passwordServices()
		expect((await handleAuth(new Request(`${ISSUER}/auth/oidc/start`), services, AUTH_ENV, new TestContext())).status).toBe(404)
		expect((await handleAuth(new Request(`${ISSUER}/auth/callback`), services, AUTH_ENV, new TestContext())).status).toBe(404)
	})

	test('rejects missing, cross-origin, and same-site cross-origin POSTs', async () => {
		const { services } = passwordServices()
		const fields = { email: 'person@example.test', password: 'a valid long password' }
		const missing = post('/auth/login', fields)
		missing.headers.delete('Origin')
		expect((await handleAuth(missing, services, AUTH_ENV, new TestContext())).status).toBe(403)
		expect((await handleAuth(post('/auth/login', fields, { Origin: 'https://evil.test' }), services, AUTH_ENV, new TestContext())).status).toBe(403)
		expect(
			(await handleAuth(post('/auth/login', fields, { 'Sec-Fetch-Site': 'same-site' }), services, AUTH_ENV, new TestContext())).status,
		).toBe(403)
	})

	test('rejects an oversized streamed form without trusting Content-Length', async () => {
		const { services } = passwordServices()
		const request = post('/auth/login', { email: 'person@example.test', password: 'x'.repeat(20_000) })
		request.headers.delete('Content-Length')
		expect((await handleAuth(request, services, AUTH_ENV, new TestContext())).status).toBe(400)
	})

	test("a `?redirect=` may only stay on IAM's own origin", () => {
		const h = createHarness()
		const production = h.makeServices({ environment: 'stage', issuer: 'https://iam.example.com' }).config
		const local = h.makeServices({ environment: 'local', issuer: ISSUER }).config
		expect(safeRedirect('https://iam.example.com/console', production)).toBe('https://iam.example.com/console')
		expect(safeRedirect(`${ISSUER}/console`, local)).toBe(`${ISSUER}/console`)
		// Everything else falls back to the issuer, including a sibling host and a local one. ADR-0023
		// left the return-origin registry as the only authority on sending a browser to another host,
		// and `readHandoff` has already consulted it by the time this runs.
		expect(safeRedirect('https://evil.example/x', production)).toBe('https://iam.example.com')
		expect(safeRedirect('http://localhost:3000/callback', local)).toBe(ISSUER)
		expect(safeRedirect('http://notes.fabrika.localhost:18081/', local)).toBe(ISSUER)
		expect(safeRedirect('https://iam.example.com.evil.test/', production)).toBe('https://iam.example.com')
	})
})

describe('password credential login', () => {
	test('issues a method-tagged 30-day session', async () => {
		const { h, hasher, services } = passwordServices()
		const principalId = seedUser(h.sqlite, { sub: 'existing-idp', email: 'person@example.test' })
		await h.repositories.passwords.enableEnrollment(principalId)
		await h.repositories.passwords.upsertCredential(principalId, await hasher.hash('a valid long password'))

		const ctx = new TestContext()
		const response = await handleAuth(
			post('/auth/login', { email: 'PERSON@example.test', password: 'a valid long password', redirect: `${ISSUER}/after` }),
			services,
			AUTH_ENV,
			ctx,
		)
		expect(response.status).toBe(302)
		expect(response.headers.get('Location')).toBe(`${ISSUER}/after`)
		const token = cookieValue(response, SESSION_COOKIE)
		expect(token).not.toBeNull()
		const session = await h.repositories.sessions.getActiveSessionByHash(await hashToken(token ?? ''))
		expect(session?.authentication_method).toBe('password')
		expect(session?.idp_sub).toBeNull()
		await ctx.drain()
	})

	test('uses one generic response and dummy work for unknown and oversized passwords', async () => {
		const hasher = new FastPasswordHasher()
		const { services } = passwordServices({ hasher })
		const unknown = await handleAuth(
			post('/auth/login', { email: 'missing@example.test', password: 'a valid long password' }),
			services,
			AUTH_ENV,
			new TestContext(),
		)
		const oversized = await handleAuth(
			post('/auth/login', { email: 'missing@example.test', password: 'x'.repeat(300) }),
			services,
			AUTH_ENV,
			new TestContext(),
		)
		expect(await unknown.text()).toContain('Invalid email or password.')
		expect(await oversized.text()).toContain('Invalid email or password.')
		expect(hasher.hashCalls).toBe(2)
		expect(hasher.verifyCalls).toBe(0)
	})

	test('stores only hashed account and global throttle keys', async () => {
		const { h, services } = passwordServices()
		await handleAuth(
			post('/auth/login', { email: 'missing@example.test', password: 'a valid long password' }),
			services,
			AUTH_ENV,
			new TestContext(),
		)
		const rows = h.sqlite.query<{ login_key_hash: string }, []>('SELECT login_key_hash FROM password_login_throttles').all()
		expect(rows).toHaveLength(2)
		expect(rows.every((row) => !row.login_key_hash.includes('missing') && !row.login_key_hash.includes('192.0.2.10'))).toBe(true)
	})

	test('does dummy derivation for unusable accounts but skips work after blocking', async () => {
		const hasher = new FastPasswordHasher()
		const { h, services } = passwordServices({ hasher })
		const disabledId = seedUser(h.sqlite, { sub: 'disabled', email: 'disabled@example.test', disabled: true })
		await h.repositories.passwords.enableEnrollment(disabledId)
		await h.repositories.passwords.upsertCredential(disabledId, await hasher.hash('a valid long password'))
		// A row whose stored address is not the normalized mailbox — only a raw INSERT can produce one
		// now, and it must stay unreachable rather than authenticate off a case-folding accident.
		const strayId = seedUser(h.sqlite, { sub: 'stray', email: 'Case@example.test' })
		await h.repositories.passwords.enableEnrollment(strayId)
		await h.repositories.passwords.upsertCredential(strayId, await hasher.hash('a valid long password'))
		const blockedEmail = 'blocked@example.test'
		await h.repositories.passwords.recordLoginFailure({
			loginKeyHash: await hashToken(`password-login:account:${blockedEmail}`),
			windowSeconds: 900,
			maxAttempts: 1,
			blockSeconds: 900,
		})
		const baselineHashCalls = hasher.hashCalls

		for (const email of ['missing@example.test', 'case@example.test', 'disabled@example.test', blockedEmail]) {
			const response = await handleAuth(
				post('/auth/login', { email, password: 'a valid long password' }),
				services,
				AUTH_ENV,
				new TestContext(),
			)
			expect(await response.text()).toContain('Invalid email or password.')
		}
		expect(hasher.hashCalls - baselineHashCalls).toBe(3)
		expect(hasher.verifyCalls).toBe(0)
	})
})

describe('forgot password and one-time actions', () => {
	test('issues and sends reset only for an enabled password account', async () => {
		const email = new CapturingEmail()
		const { h, hasher, services } = passwordServices({ email })
		const principalId = seedUser(h.sqlite, { sub: 'existing', email: 'person@example.test' })
		await h.repositories.passwords.enableEnrollment(principalId)
		await h.repositories.passwords.upsertCredential(principalId, await hasher.hash('old long password value'))
		const ctx = new TestContext()
		const response = await handleAuth(post('/auth/forgot-password', { email: 'PERSON@example.test' }), services, AUTH_ENV, ctx)
		expect(response.status).toBe(200)
		await ctx.drain()
		expect(email.messages).toHaveLength(1)
		expect(email.messages[0]?.subject).toBe('Reset your Fabrika password')
		expect(email.messages[0]?.text).not.toContain('PERSON@example.test')
	})

	test('does nothing without a sender and keeps unknown-account response identical', async () => {
		const withoutSender = passwordServices()
		const knownId = seedUser(withoutSender.h.sqlite, { sub: 'existing', email: 'person@example.test' })
		await withoutSender.h.repositories.passwords.enableEnrollment(knownId)
		await withoutSender.h.repositories.passwords.upsertCredential(knownId, await withoutSender.hasher.hash('old long password value'))
		const known = await handleAuth(
			post('/auth/forgot-password', { email: 'person@example.test' }),
			withoutSender.services,
			AUTH_ENV,
			new TestContext(),
		)
		expect(withoutSender.h.sqlite.query('SELECT * FROM password_action_tokens').all()).toHaveLength(0)

		const withSender = passwordServices({ email: new CapturingEmail() })
		const unknown = await handleAuth(
			post('/auth/forgot-password', { email: 'unknown@example.test' }),
			withSender.services,
			AUTH_ENV,
			new TestContext(),
		)
		expect(await known.text()).toContain('If the account can use password sign-in and email delivery succeeds')
		expect(await unknown.text()).toContain('If the account can use password sign-in and email delivery succeeds')
	})

	test('throttles repeated recovery delivery per account', async () => {
		const email = new CapturingEmail()
		const { h, hasher, services } = passwordServices({ email })
		const principalId = seedUser(h.sqlite, { sub: 'recovery-rate-limit', email: 'limited@example.test' })
		await h.repositories.passwords.upsertCredential(principalId, await hasher.hash('old long password value'))
		const ctx = new TestContext()
		for (let index = 0; index < 4; index += 1) {
			const response = await handleAuth(post('/auth/forgot-password', { email: 'limited@example.test' }), services, AUTH_ENV, ctx)
			expect(response.status).toBe(200)
		}
		await ctx.drain()
		expect(email.messages).toHaveLength(3)
	})

	test('bootstraps only an exact configured address in password-only mode', async () => {
		const email = new CapturingEmail()
		const { h, services } = passwordServices({ email, bootstrapAdmins: new Set([' Admin@example.test ']) })
		const ctx = new TestContext()
		await handleAuth(post('/auth/forgot-password', { email: 'admin@example.test' }), services, AUTH_ENV, ctx)
		await ctx.drain()
		const principal = await h.repositories.passwords.lookupActionUser('admin@example.test')
		expect(principal.status === 'found' ? principal.account?.state : null).toBe('pending')
		expect(email.messages[0]?.subject).toBe('Set your Fabrika password')

		const otherAddress = passwordServices({ email: new CapturingEmail(), bootstrapAdmins: new Set(['other@example.test']) })
		await handleAuth(
			post('/auth/forgot-password', { email: 'admin@example.test' }),
			otherAddress.services,
			AUTH_ENV,
			new TestContext(),
		)
		expect((await otherAddress.h.repositories.passwords.lookupActionUser('admin@example.test')).status).toBe('missing')
	})

	test('GET does not consume; valid POST completes atomically and token cannot replay', async () => {
		const { h, services } = passwordServices()
		const principalId = seedUser(h.sqlite, { sub: null, email: 'invitee@example.test' })
		await h.repositories.passwords.enableEnrollment(principalId)
		const principal = await h.repositories.principals.getPrincipalById(principalId)
		if (principal === null) throw new Error('missing seeded principal')
		const action = await issuePasswordAction(services, { principal, purpose: 'enrollment' })
		expect(new URL(action.url).search).toBe('')
		const token = new URLSearchParams(new URL(action.url).hash.slice(1)).get('token')
		if (token === null) throw new Error('missing action token')

		const getResponse = await handleAuth(new Request(action.url), services, AUTH_ENV, new TestContext())
		expect(getResponse.status).toBe(200)
		expect(getResponse.headers.get('Referrer-Policy')).toBe('no-referrer')
		const actionPage = await getResponse.text()
		expect(actionPage).toContain('location.hash')
		expect(actionPage).not.toContain(token)
		expect(await h.repositories.passwords.inspectActionToken(await hashToken(token), 'enrollment')).not.toBeNull()

		const weak = await handleAuth(
			post('/auth/password/enroll', { token, password: 'short' }),
			services,
			AUTH_ENV,
			new TestContext(),
		)
		expect(weak.status).toBe(400)
		expect(await h.repositories.passwords.inspectActionToken(await hashToken(token), 'enrollment')).not.toBeNull()

		const complete = await handleAuth(
			post('/auth/password/enroll', { token, password: 'a sufficiently long password' }),
			services,
			AUTH_ENV,
			new TestContext(),
		)
		expect(complete.status).toBe(302)
		expect(cookieValue(complete, SESSION_COOKIE)).not.toBeNull()
		expect((await h.repositories.passwords.getAccount(principalId))?.state).toBe('enabled')
		expect((await h.repositories.principals.getPrincipalById(principalId))?.activated_at).not.toBeNull()

		const replay = await handleAuth(
			post('/auth/password/enroll', { token, password: 'another sufficient password' }),
			services,
			AUTH_ENV,
			new TestContext(),
		)
		expect(replay.status).toBe(400)
	})
})

// `handlePasswordAction` is mounted twice, and the ONLY thing separating enrollment from reset is the
// `purpose` argument threaded into `inspectActionToken`/`completeAction`, where it is a SQL predicate.
// Nothing tested that predicate, so a dropped `AND purpose = ?` would have been invisible.
describe('an action token is bound to its purpose', () => {
	async function tokenFor(purpose: 'enrollment' | 'reset'): Promise<{ h: Harness; services: Services; token: string }> {
		const { h, services } = passwordServices()
		const principalId = seedUser(h.sqlite, { sub: null, email: `${purpose}@example.test` })
		await h.repositories.passwords.enableEnrollment(principalId)
		const principal = await h.repositories.principals.getPrincipalById(principalId)
		if (principal === null) throw new Error('missing seeded principal')
		const action = await issuePasswordAction(services, { principal, purpose })
		const token = new URLSearchParams(new URL(action.url).hash.slice(1)).get('token')
		if (token === null) throw new Error('missing action token')
		return { h, services, token }
	}

	for (
		const [issued, posted] of [
			['enrollment', '/auth/password/reset'],
			['reset', '/auth/password/enroll'],
		] as const
	) {
		test(`an ${issued} token posted to ${posted} is refused and stays unspent`, async () => {
			const { h, services, token } = await tokenFor(issued)
			const response = await handleAuth(post(posted, { token, password: 'a sufficiently long password' }), services, AUTH_ENV, new TestContext())
			expect(response.status).toBe(400)
			expect(await response.text()).toContain('Link unavailable')
			// Unspent: the token still validates for the purpose it WAS issued for.
			expect(await h.repositories.passwords.inspectActionToken(await hashToken(token), issued)).not.toBeNull()
		})
	}
})
