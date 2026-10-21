import { describe, expect, test } from 'bun:test'
import { KNOWN_DEVICE_COOKIE, KNOWN_DEVICE_TTL_SECONDS } from '../auth/known-device'
import { handleAuth } from '../auth/routes'
import type { RequestContext } from '../env'
import type { PasswordHasher, StoredPasswordHash } from '../password-crypto'
import { hashToken } from '../secret'
import { getSigner, Signer } from '../signing'
import { createHarness, type Harness, seedUser } from './helpers/harness'

const ISSUER = 'http://localhost:18191'
const AUTH_ENV = { FABRIKA_IAM_SIGNING_KEYS: '', ENVIRONMENT: 'local' }
const PASSWORD = 'a valid long password'
const KNOWN_DEVICE_AUDIENCE = 'fabrika:iam:known-device'

class FastPasswordHasher implements PasswordHasher {
	async hash(password: string): Promise<StoredPasswordHash> {
		return { algorithm: 'test', parameters: '{}', salt: 'salt', passwordHash: `hash:${password}` }
	}

	async verify(password: string, stored: StoredPasswordHash) {
		return { valid: stored.passwordHash === `hash:${password}`, needsRehash: false }
	}
}

class TestContext implements RequestContext {
	readonly waitUntil = (_promise: Promise<unknown>): void => {}
}

interface Fixture {
	h: Harness
	login: (email: string, password: string, deviceCookie?: string | null) => Promise<Response>
	seedPasswordUser: (email: string) => Promise<string>
	fillBucket: (key: string) => Promise<void>
}

function fixture(): Fixture {
	const h = createHarness()
	const hasher = new FastPasswordHasher()
	const services = h.makeServices({ issuer: ISSUER, authentication: { oidc: false, password: true }, passwordHasher: hasher, email: null })
	return {
		h,
		login: (email, password, deviceCookie = null) => {
			const headers = new Headers({
				Origin: ISSUER,
				'Sec-Fetch-Site': 'same-origin',
				'Content-Type': 'application/x-www-form-urlencoded',
			})
			if (deviceCookie !== null) headers.set('Cookie', `${KNOWN_DEVICE_COOKIE}=${deviceCookie}`)
			const request = new Request(`${ISSUER}/auth/login`, { method: 'POST', headers, body: new URLSearchParams({ email, password }) })
			return handleAuth(request, services, AUTH_ENV, new TestContext())
		},
		seedPasswordUser: async (email) => {
			const principalId = seedUser(h.sqlite, { sub: email, email })
			await h.repositories.passwords.enableEnrollment(principalId)
			await h.repositories.passwords.upsertCredential(principalId, await hasher.hash(PASSWORD))
			return principalId
		},
		fillBucket: async (key) => {
			await h.repositories.passwords.recordLoginFailure({ loginKeyHash: await hashToken(key), windowSeconds: 900, maxAttempts: 1, blockSeconds: 900 })
		},
	}
}

function deviceSetCookie(response: Response): string | null {
	return response.headers.getSetCookie().find((header) => header.startsWith(`${KNOWN_DEVICE_COOKIE}=`)) ?? null
}

function deviceCookieValue(response: Response): string {
	const header = deviceSetCookie(response)
	if (header === null) throw new Error('No known-device cookie was issued')
	return header.slice(KNOWN_DEVICE_COOKIE.length + 1).split(';')[0] ?? ''
}

async function fillAccountAndGlobal(f: Fixture, email: string): Promise<void> {
	await f.fillBucket(`password-login:account:${email}`)
	await f.fillBucket('password-login:global')
}

describe('known-device cookie', () => {
	test('a successful password login issues a host-only, long-lived device cookie', async () => {
		const f = fixture()
		await f.seedPasswordUser('person@example.test')
		const response = await f.login('person@example.test', PASSWORD)
		expect(response.status).toBe(302)
		const header = deviceSetCookie(response)
		expect(header).not.toBeNull()
		const attributes = (header ?? '').split('; ').slice(1)
		expect(attributes).toEqual(['Path=/', `Max-Age=${KNOWN_DEVICE_TTL_SECONDS}`, 'HttpOnly', 'Secure', 'SameSite=Lax'])
		expect(KNOWN_DEVICE_COOKIE.startsWith('__Host-')).toBe(true)
	})

	test('a refused login issues no device cookie', async () => {
		const f = fixture()
		await f.seedPasswordUser('person@example.test')
		const response = await f.login('person@example.test', 'a wrong long password')
		expect(response.status).toBe(401)
		expect(deviceSetCookie(response)).toBeNull()
	})

	test('a valid device cookie for the principal passes full account and global buckets', async () => {
		const f = fixture()
		await f.seedPasswordUser('person@example.test')
		const cookie = deviceCookieValue(await f.login('person@example.test', PASSWORD))
		await fillAccountAndGlobal(f, 'person@example.test')

		const withoutCookie = await f.login('person@example.test', PASSWORD)
		expect(withoutCookie.status).toBe(401)
		expect(await withoutCookie.text()).toContain('Invalid email or password.')

		const withCookie = await f.login('person@example.test', PASSWORD, cookie)
		expect(withCookie.status).toBe(302)
	})

	test("another principal's device cookie does not exempt", async () => {
		const f = fixture()
		await f.seedPasswordUser('person@example.test')
		await f.seedPasswordUser('other@example.test')
		const otherCookie = deviceCookieValue(await f.login('other@example.test', PASSWORD))
		await fillAccountAndGlobal(f, 'person@example.test')

		const response = await f.login('person@example.test', PASSWORD, otherCookie)
		expect(response.status).toBe(401)
		expect(await response.text()).toContain('Invalid email or password.')
	})

	test('a forged or expired device cookie does not exempt', async () => {
		const f = fixture()
		const principalId = await f.seedPasswordUser('person@example.test')
		await fillAccountAndGlobal(f, 'person@example.test')
		const foreignSigner = await Signer.ephemeral()
		const forged = await foreignSigner.signInternal({ sub: principalId, dev: 'forged-device' }, KNOWN_DEVICE_AUDIENCE, 3600)
		const expired = await (await getSigner(AUTH_ENV)).signInternal({ sub: principalId, dev: 'expired-device' }, KNOWN_DEVICE_AUDIENCE, 0)
		const wrongAudience = await (await getSigner(AUTH_ENV)).signInternal({ sub: principalId, dev: 'flight' }, 'fabrika:iam:oidc-flight', 3600)

		for (const cookie of [forged, expired, wrongAudience, 'not-a-token']) {
			const response = await f.login('person@example.test', PASSWORD, cookie)
			expect(response.status).toBe(401)
		}
	})

	test('the per-device bucket ends the exemption after its limit', async () => {
		const f = fixture()
		await f.seedPasswordUser('person@example.test')
		const cookie = deviceCookieValue(await f.login('person@example.test', PASSWORD))
		await fillAccountAndGlobal(f, 'person@example.test')

		for (let attempt = 0; attempt < 10; attempt++) {
			expect((await f.login('person@example.test', 'a wrong long password', cookie)).status).toBe(401)
		}
		const response = await f.login('person@example.test', PASSWORD, cookie)
		expect(response.status).toBe(401)
		expect(await response.text()).toContain('Invalid email or password.')
	})

	test('failures from a known device do not fill the account bucket', async () => {
		const f = fixture()
		await f.seedPasswordUser('person@example.test')
		const cookie = deviceCookieValue(await f.login('person@example.test', PASSWORD))

		for (let attempt = 0; attempt < 6; attempt++) {
			await f.login('person@example.test', 'a wrong long password', cookie)
		}
		expect((await f.login('person@example.test', PASSWORD)).status).toBe(302)
	})
})
