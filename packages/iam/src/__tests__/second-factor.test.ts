import { SESSION_COOKIE } from '@fabrika/auth-core'
import { unusedDatabase } from '@fabrika/platform/testing'
import { describe, expect, test } from 'bun:test'
import { createIamApp } from '../app'
import { KNOWN_DEVICE_COOKIE } from '../auth/known-device'
import { handleAuth } from '../auth/routes'
import { SECOND_FACTOR_MAX_ATTEMPTS } from '../auth/second-factor'
import { SECOND_FACTOR_COOKIE } from '../auth/second-factor-challenge'
import { issueSession } from '../auth/sessions'
import { openValue, parseDataKey, sealValue } from '../data-key'
import type { Env } from '../env'
import type { PasswordHasher, StoredPasswordHash } from '../password-crypto'
import { sealedValueOf } from '../repositories/second-factors'
import type { Services } from '../services'
import { base32, generateTotpSecret, recoveryCodeHash, totpCode, totpStep } from '../totp'
import { createHarness, type Harness, seedGrant, seedUser, TEST_SIGNING_ENV, TEST_SIGNING_KEYS } from './helpers/harness'

const ISSUER = 'https://iam.example.com'
const PASSWORD = 'a valid long password'
const exec = { waitUntil() {} }

class PlainHasher implements PasswordHasher {
	async hash(password: string): Promise<StoredPasswordHash> {
		return { algorithm: 'test', parameters: '{}', salt: 'salt', passwordHash: `hash:${password}` }
	}

	async verify(password: string, stored: StoredPasswordHash) {
		return { valid: stored.passwordHash === `hash:${password}`, needsRehash: false }
	}
}

function randomDataKey(): Uint8Array<ArrayBuffer> {
	return crypto.getRandomValues(new Uint8Array(new ArrayBuffer(32)))
}

interface Fixture {
	h: Harness
	services: Services
	dataKey: Uint8Array<ArrayBuffer>
	send(request: Request): Promise<Response>
	/** A user with a password who holds `admin` at the installation. */
	admin(email: string): Promise<string>
	/** Enrol `principalId` directly, as the enrolment's two steps do: a known secret, confirmed, with `codes`. */
	enrol(principalId: string, codes?: readonly string[]): Promise<Uint8Array<ArrayBuffer>>
	login(email: string): Promise<Response>
	submitCode(challenge: string, code: string): Promise<Response>
	auditActions(): string[]
	authLog(): { decision: string; reason: string | null; principal_id: string | null }[]
}

function fixture(options: { dataKey?: boolean } = {}): Fixture {
	const h = createHarness()
	const dataKey = randomDataKey()
	const services = h.makeServices({
		issuer: ISSUER,
		environment: 'stage',
		authentication: { oidc: false, password: true },
		passwordHasher: new PlainHasher(),
		dataKey: options.dataKey === false ? null : dataKey,
	})
	const hasher = new PlainHasher()
	const send = (request: Request) => handleAuth(request, services, TEST_SIGNING_ENV, exec)
	const form = (path: string, body: Record<string, string>, cookie?: string) => {
		const headers = new Headers({ Origin: ISSUER, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded' })
		if (cookie !== undefined) headers.set('Cookie', cookie)
		return new Request(`${ISSUER}${path}`, { method: 'POST', headers, body: new URLSearchParams(body) })
	}
	return {
		h,
		services,
		dataKey,
		send,
		admin: async (email) => {
			const id = seedUser(h.sqlite, { sub: `sub-${email}`, email })
			seedGrant(h.sqlite, id, 'admin', null)
			await h.repositories.passwords.enableEnrollment(id)
			await h.repositories.passwords.upsertCredential(id, await hasher.hash(PASSWORD))
			return id
		},
		enrol: async (principalId, codes = []) => {
			const secret = generateTotpSecret()
			const sealed = await sealValue(dataKey, principalId, secret)
			expect(await h.repositories.secondFactors.begin(principalId, sealed)).toBe(true)
			const confirmed = await h.repositories.secondFactors.confirm({
				principalId,
				ciphertext: sealed.ciphertext,
				step: totpStep(Date.now() / 1000) - 2,
				recoveryCodeHashes: await Promise.all(codes.map((code) => recoveryCodeHash(principalId, code))),
			}, { requestId: 'seed', principalId, principalLabel: principalId, app: 'propustka', action: 'iam.second_factor.enrol', resourceType: 'principal' })
			expect(confirmed).toBe(true)
			return secret
		},
		login: (email) => send(form('/auth/login', { email, password: PASSWORD })),
		submitCode: (challenge, code) => send(form('/auth/second-factor', { code }, `${SECOND_FACTOR_COOKIE}=${challenge}`)),
		auditActions: () =>
			h.sqlite.query<{ action: string }, []>('SELECT action FROM audit_events ORDER BY created_at, id').all().map((row) => row.action),
		authLog: () =>
			h.sqlite.query<{ decision: string; reason: string | null; principal_id: string | null }, []>(
				'SELECT decision, reason, principal_id FROM auth_log ORDER BY id',
			).all(),
	}
}

function setCookie(response: Response, name: string): string | null {
	const header = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`))
	return header === undefined ? null : header.slice(name.length + 1).split(';')[0] ?? null
}

function challengeOf(response: Response): string {
	const value = setCookie(response, SECOND_FACTOR_COOKIE)
	if (value === null || value === '') throw new Error('no challenge cookie')
	return value
}

async function currentCode(secret: Uint8Array<ArrayBuffer>): Promise<string> {
	return totpCode(secret, totpStep(Date.now() / 1000))
}

/** A six-digit code that no step the server may accept during this test matches. */
async function wrongCode(secret: Uint8Array<ArrayBuffer>): Promise<string> {
	const now = totpStep(Date.now() / 1000)
	const valid = new Set(await Promise.all([now - 1, now, now + 1, now + 2].map((step) => totpCode(secret, step))))
	for (let candidate = 0;; candidate++) {
		const code = String(candidate).padStart(6, '0')
		if (!valid.has(code)) return code
	}
}

function base32Decode(value: string): Uint8Array<ArrayBuffer> {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
	let bits = 0
	let buffer = 0
	const out: number[] = []
	for (const character of value.replaceAll(' ', '')) {
		buffer = (buffer << 5) | alphabet.indexOf(character)
		bits += 5
		if (bits >= 8) {
			out.push((buffer >>> (bits - 8)) & 0xff)
			bits -= 8
		}
	}
	const bytes = new Uint8Array(new ArrayBuffer(out.length))
	bytes.set(out)
	return bytes
}

describe('TOTP', () => {
	test('matches the RFC 6238 SHA-1 vectors, cut to six digits', async () => {
		const secret = new Uint8Array(new ArrayBuffer(20))
		secret.set(new TextEncoder().encode('12345678901234567890'))
		const vectors: [number, string][] = [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037']]
		for (const [time, code] of vectors) expect(await totpCode(secret, totpStep(time))).toBe(code)
		expect(base32(secret)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
	})
})

describe('the data key', () => {
	test('a sealed secret opens only for its owner and only under its key', async () => {
		const key = randomDataKey()
		const secret = generateTotpSecret()
		const sealed = await sealValue(key, 'user-a', secret)
		expect(await openValue(key, 'user-a', sealed)).toEqual(secret)
		expect(openValue(key, 'user-b', sealed)).rejects.toThrow()
		expect(openValue(randomDataKey(), 'user-a', sealed)).rejects.toThrow()
	})

	test('the boot refuses a key that is not 32 bytes of base64, and unset is no key', () => {
		expect(parseDataKey(undefined)).toBeNull()
		expect(parseDataKey('  ')).toBeNull()
		expect(() => parseDataKey(btoa('short'))).toThrow('32 bytes')
		expect(() => parseDataKey('not base64 !')).toThrow('base64')
		expect(parseDataKey(btoa('x'.repeat(32)))?.length).toBe(32)
	})
})

describe('enrolment', () => {
	test('an administrator enrols an authenticator: the secret is stored sealed, the recovery codes hashed, the enrolment audited', async () => {
		const f = fixture()
		const admin = await f.admin('admin@example.com')
		const cookie = `${SESSION_COOKIE}=${await f.h.signSession(admin, { idpSub: null, authenticationMethod: 'password' })}`
		const request = (step?: string, code?: string) =>
			step === undefined
				? new Request(`${ISSUER}/auth/second-factor/enrol`, { headers: { Cookie: cookie } })
				: new Request(`${ISSUER}/auth/second-factor/enrol`, {
					method: 'POST',
					headers: { Cookie: cookie, Origin: ISSUER, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded' },
					body: new URLSearchParams({ step, ...(code === undefined ? {} : { code }) }),
				})

		const intro = await f.send(request())
		expect(intro.status).toBe(200)
		expect(await intro.text()).toContain('Set up an authenticator app')

		const started = await f.send(request('start'))
		expect(started.status).toBe(200)
		const html = await started.text()
		expect(html).toContain('src="data:image/svg+xml;base64,')
		const key = /<code>([A-Z2-7 ]+)<\/code>/.exec(html)?.[1]
		if (key === undefined) throw new Error('no key on the page')
		const secret = base32Decode(key)

		const stored = await f.h.repositories.secondFactors.get(admin)
		if (stored === null) throw new Error('no stored factor')
		expect(stored.confirmed_at).toBeNull()
		expect(JSON.stringify(stored)).not.toContain(key.replaceAll(' ', ''))
		expect(await openValue(f.dataKey, admin, sealedValueOf(stored))).toEqual(secret)

		const refused = await f.send(request('confirm', await wrongCode(secret)))
		expect(refused.status).toBe(400)
		expect(await f.h.repositories.secondFactors.isConfirmed(admin)).toBe(false)

		const confirmed = await f.send(request('confirm', await currentCode(secret)))
		expect(confirmed.status).toBe(200)
		const codes = [...(await confirmed.text()).matchAll(/<li><code>([a-z2-7-]+)<\/code><\/li>/g)].map((match) => match[1])
		expect(codes).toHaveLength(10)
		expect(await f.h.repositories.secondFactors.isConfirmed(admin)).toBe(true)
		const hashes = f.h.sqlite.query<{ code_hash: string }, [string]>('SELECT code_hash FROM second_factor_recovery_codes WHERE principal_id = ?').all(
			admin,
		)
		expect(hashes).toHaveLength(10)
		for (const { code_hash } of hashes) expect(codes.some((code) => code !== undefined && code_hash.includes(code.replaceAll('-', '')))).toBe(false)
		expect(f.auditActions()).toEqual(['iam.second_factor.enrol'])

		// A confirmed factor is not replaced by starting again.
		const again = await f.send(request('start'))
		expect(await again.text()).toContain('Two-step sign-in is on')
		expect(await openValue(f.dataKey, admin, sealedValueOf((await f.h.repositories.secondFactors.get(admin)) ?? stored))).toEqual(secret)
	})

	test('a person who administers nothing cannot enrol, and without the data key nobody can', async () => {
		const f = fixture()
		const user = seedUser(f.h.sqlite, { sub: 'sub-user', email: 'user@example.com' })
		const userCookie = `${SESSION_COOKIE}=${await f.h.signSession(user, { idpSub: null, authenticationMethod: 'password' })}`
		expect((await f.send(new Request(`${ISSUER}/auth/second-factor/enrol`, { headers: { Cookie: userCookie } }))).status).toBe(403)

		const keyless = fixture({ dataKey: false })
		const admin = await keyless.admin('admin@example.com')
		const adminCookie = `${SESSION_COOKIE}=${await keyless.h.signSession(admin, { idpSub: null, authenticationMethod: 'password' })}`
		const page = await keyless.send(new Request(`${ISSUER}/auth/second-factor/enrol`, { headers: { Cookie: adminCookie } }))
		expect(page.status).toBe(503)
		expect(await page.text()).toContain('cannot store authenticator keys yet')
	})
})

describe('sign-in with a second factor', () => {
	test('an enrolled administrator gets no session until a valid code, which opens the login it held', async () => {
		const f = fixture()
		const admin = await f.admin('admin@example.com')
		const secret = await f.enrol(admin)

		const first = await f.login('admin@example.com')
		expect(first.status).toBe(200)
		expect(await first.text()).toContain('Two-step sign-in')
		expect(setCookie(first, SESSION_COOKIE)).toBeNull()
		expect(setCookie(first, KNOWN_DEVICE_COOKIE)).toBeNull()
		expect(f.authLog()).toEqual([])

		const verified = await f.submitCode(challengeOf(first), await currentCode(secret))
		expect(verified.status).toBe(302)
		expect(setCookie(verified, SESSION_COOKIE)).not.toBeNull()
		expect(setCookie(verified, KNOWN_DEVICE_COOKIE)).not.toBeNull()
		expect(setCookie(verified, SECOND_FACTOR_COOKIE)).toBe('')
		expect(f.authLog()).toEqual([{ decision: 'allow', reason: 'password_login', principal_id: admin }])
	})

	test('a wrong code is refused and logged, and an accepted code is not accepted twice', async () => {
		const f = fixture()
		const admin = await f.admin('admin@example.com')
		const secret = await f.enrol(admin)
		const challenge = challengeOf(await f.login('admin@example.com'))

		const wrong = await f.submitCode(challenge, await wrongCode(secret))
		expect(wrong.status).toBe(401)
		expect(await wrong.text()).toContain('This code is not valid.')
		expect(setCookie(wrong, SESSION_COOKIE)).toBeNull()
		expect(f.authLog()).toEqual([{ decision: 'deny', reason: 'second_factor_invalid', principal_id: admin }])

		const code = await currentCode(secret)
		expect((await f.submitCode(challenge, code)).status).toBe(302)
		const replay = await f.submitCode(challengeOf(await f.login('admin@example.com')), code)
		expect(replay.status).toBe(401)
		expect(setCookie(replay, SESSION_COOKIE)).toBeNull()
	})

	test(`after ${SECOND_FACTOR_MAX_ATTEMPTS} attempts the account waits, even with a valid code, and the burst is audited once`, async () => {
		const f = fixture()
		const admin = await f.admin('admin@example.com')
		const secret = await f.enrol(admin)
		const challenge = challengeOf(await f.login('admin@example.com'))
		const wrong = await wrongCode(secret)
		for (let attempt = 0; attempt < SECOND_FACTOR_MAX_ATTEMPTS; attempt++) expect((await f.submitCode(challenge, wrong)).status).toBe(401)

		const blocked = await f.submitCode(challenge, await currentCode(secret))
		expect(blocked.status).toBe(429)
		expect(setCookie(blocked, SESSION_COOKIE)).toBeNull()
		expect((await f.submitCode(challenge, wrong)).status).toBe(429)
		expect(f.auditActions().filter((action) => action === 'iam.second_factor.throttle')).toHaveLength(1)
		expect(f.authLog().at(-1)).toEqual({ decision: 'deny', reason: 'second_factor_throttled', principal_id: admin })
	})

	test('a recovery code signs in once, audited, also when the data key is gone', async () => {
		const f = fixture()
		const admin = await f.admin('admin@example.com')
		await f.enrol(admin, ['abcd-efgh-ijkl-mnop', 'qrst-uvwx-yz23-4567'])
		// The installation lost its key: codes from the app cannot be checked, recovery codes still can.
		const keyless = f.h.makeServices({
			issuer: ISSUER,
			environment: 'stage',
			authentication: { oidc: false, password: true },
			passwordHasher: new PlainHasher(),
		})
		const send = (request: Request) => handleAuth(request, keyless, TEST_SIGNING_ENV, exec)
		const post = (path: string, body: Record<string, string>, cookie?: string) =>
			send(
				new Request(`${ISSUER}${path}`, {
					method: 'POST',
					headers: {
						Origin: ISSUER,
						'Sec-Fetch-Site': 'same-origin',
						'Content-Type': 'application/x-www-form-urlencoded',
						...(cookie === undefined ? {} : { Cookie: cookie }),
					},
					body: new URLSearchParams(body),
				}),
			)
		const challenge = challengeOf(await post('/auth/login', { email: 'admin@example.com', password: PASSWORD }))
		const appCode = await post('/auth/second-factor', { code: '123456' }, `${SECOND_FACTOR_COOKIE}=${challenge}`)
		expect(appCode.status).toBe(503)
		expect(await appCode.text()).toContain('Use a recovery code')

		const recovered = await post('/auth/second-factor', { code: 'ABCD EFGH IJKL MNOP' }, `${SECOND_FACTOR_COOKIE}=${challenge}`)
		expect(recovered.status).toBe(302)
		expect(setCookie(recovered, SESSION_COOKIE)).not.toBeNull()
		expect(f.auditActions()).toEqual(['iam.second_factor.enrol', 'iam.second_factor.recovery_code.use'])
		expect((await f.h.repositories.secondFactors.status(admin)).recoveryCodesLeft).toBe(1)

		const again = challengeOf(await post('/auth/login', { email: 'admin@example.com', password: PASSWORD }))
		expect((await post('/auth/second-factor', { code: 'abcd-efgh-ijkl-mnop' }, `${SECOND_FACTOR_COOKIE}=${again}`)).status).toBe(401)
	})

	test('a missing or forged challenge opens nothing', async () => {
		const f = fixture()
		const admin = await f.admin('admin@example.com')
		const secret = await f.enrol(admin)
		const forged = await f.submitCode('not-a-signed-challenge', await currentCode(secret))
		expect(forged.status).toBe(400)
		expect(setCookie(forged, SESSION_COOKIE)).toBeNull()
		expect(f.authLog()).toEqual([{ decision: 'deny', reason: 'second_factor_expired', principal_id: null }])
	})

	test('every OIDC and password login of an enrolled principal waits for the code; one not enrolled does not', async () => {
		const f = fixture()
		const admin = await f.admin('admin@example.com')
		const other = await f.admin('other@example.com')
		await f.enrol(admin)
		const open = (principalId: string, authenticationMethod: 'oidc' | 'password', reason: string) =>
			issueSession(new Request(`${ISSUER}/auth/callback`), f.services, TEST_SIGNING_ENV, exec, {
				principalId,
				authenticationMethod,
				...(authenticationMethod === 'oidc' ? { idpSub: `idp-${principalId}` } : {}),
				redirect: null,
				reason,
				requestId: `request-${reason}`,
			})
		for (const [method, reason] of [['oidc', 'login'], ['password', 'password_reset'], ['password', 'invitation_enrollment']] as const) {
			const response = await open(admin, method, reason)
			expect(response.status).toBe(200)
			expect(setCookie(response, SESSION_COOKIE)).toBeNull()
			expect(setCookie(response, SECOND_FACTOR_COOKIE)).not.toBeNull()
		}
		expect((await open(other, 'oidc', 'login')).status).toBe(302)
	})
})

describe('operator reset', () => {
	function env(f: Fixture): Env {
		return {
			DB: unusedDatabase,
			REPOSITORIES: f.h.repositories,
			HUMAN_EMAIL_DOMAINS: '[]',
			HUMAN_EMAILS: '[]',
			IAM_BOOTSTRAP_ADMINS: '[]',
			ENVIRONMENT: 'stage',
			OIDC_ENABLED: 'false',
			PASSWORD_ENABLED: 'true',
			ISSUER,
			FABRIKA_IAM_SIGNING_KEYS: TEST_SIGNING_KEYS,
			FABRIKA_IAM_PROVISIONING_KEY: '',
			FABRIKA_IAM_DATA_KEY: btoa(String.fromCharCode(...f.dataKey)),
		}
	}

	async function rpc(f: Fixture, bearer: string, method: string, input: unknown): Promise<Response> {
		return createIamApp().fetch(
			new Request(`${ISSUER}/admin/rpc`, {
				method: 'POST',
				headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
				body: JSON.stringify({ method, input }),
			}),
			env(f),
			exec,
		)
	}

	test('an installation administrator resets a lost authenticator: audited, and the next sign-in asks for no code', async () => {
		const f = fixture()
		const lost = await f.admin('lost@example.com')
		const operator = await f.admin('operator@example.com')
		await f.enrol(lost, ['abcd-efgh-ijkl-mnop'])
		const bearer = await f.h.adminToken(operator, { issuer: ISSUER })

		const before = await rpc(f, bearer, 'secondFactor.get', { principalId: lost })
		expect(before.status).toBe(200)
		expect(await before.json()).toMatchObject({ result: { recoveryCodesLeft: 1, available: true } })

		const reset = await rpc(f, bearer, 'secondFactor.reset', { principalId: lost })
		expect(reset.status).toBe(200)
		expect(await reset.json()).toEqual({ result: { enrolledAt: null, recoveryCodesLeft: 0, available: true } })
		const record = f.h.sqlite
			.query<{ principal_id: string; resource_id: string }, []>(
				`SELECT principal_id, resource_id FROM audit_events WHERE action = 'iam.second_factor.reset'`,
			)
			.all()
		expect(record).toEqual([{ principal_id: operator, resource_id: lost }])
		expect(f.h.sqlite.query('SELECT 1 FROM second_factor_recovery_codes').all()).toEqual([])

		expect((await f.login('lost@example.com')).status).toBe(302)
	})

	test('only an installation administrator reads or resets one', async () => {
		const f = fixture()
		const lost = await f.admin('lost@example.com')
		await f.enrol(lost)
		const user = seedUser(f.h.sqlite, { sub: 'sub-user', email: 'user@example.com' })
		const bearer = await f.h.adminToken(user, { issuer: ISSUER })
		expect((await rpc(f, bearer, 'secondFactor.reset', { principalId: lost })).status).toBe(403)
		expect(await f.h.repositories.secondFactors.isConfirmed(lost)).toBe(true)
	})
})
