// Signed tokens: a purpose declared once in `defineApp`'s options, `signs` on the site that signs, `signedToken()` in an
// input or `http.query`. The framework verifies a token as it parses the input: the HMAC over the purpose and the
// claims, its key, its expiry. The artifact half and the keys run everywhere; the requests run through the test kit and
// a REAL Postgres, and skip cleanly when FABRIKA_TEST_POSTGRES_URL is unset.

import type { App, KitTypes, TokenSigning } from '@fabrika/app/contract'
import { compileContract, signedToken, token } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { FABRIKA_TOKEN_KEYS } from '@fabrika/auth-core'
import { scoped } from '@fabrika/db'
import { testDatabase } from '@fabrika/db/testing'
import { afterAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { readTokenKeys, SignedTokens } from '../implement/tokens'
import { contract } from './token-fixture/fabrika.contract'
import { app, Recipient } from './token-fixture/src/app-kit'
import { tables } from './token-fixture/src/db/tables'
import { Booked, Unsubscribed } from './token-fixture/src/mail/endpoints'

type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T
type Kit = typeof app extends App<infer K extends KitTypes> ? K : never
type Signing = TokenSigning<Kit['tokens'], 'unsubscribe'>

/** A site signs only the purposes it declares, with the purpose's claims. */
export type SigningShape = [
	Expect<Equal<Parameters<Signing['sign']>[0], 'unsubscribe'>>,
	Expect<Equal<Parameters<Signing['sign']>[1], { email: string; campaign: string }>>,
]

const Empty = z.strictObject({})

const artifact = compileContract(contract, tables)

describe('the artifact of signed tokens', () => {
	test('records each purpose with its claims and its longest lifetime', () => {
		expect(artifact.tokens?.['unsubscribe']).toMatchObject({ maxDays: 400, claims: { type: 'object' } })
		expect(artifact.tokens?.['booking']?.maxDays).toBe(30)
	})

	test('records the purposes a site signs, and a token field as its purpose', () => {
		expect(artifact.declared?.['api.bookings.book']).toMatchObject({ signs: ['booking'] })
		expect(artifact.procedures?.['api.mail.unsubscribe']?.query).toEqual({ type: 'object', fields: { t: { type: 'token', purpose: 'unsubscribe' } } })
	})

	test('refuses a token of an undeclared purpose, a nested token and an undeclared signs', () => {
		const nested = app.group({}, (r) => ({
			nested: r.mutation({
				input: z.strictObject({ inner: z.strictObject({ t: signedToken('unsubscribe') }) }),
				output: Empty,
				access: { public: true },
				actions: ['bookings.book'],
			}).handle(() => ({})),
		}))
		expect(() => compileContract(app.contract((c) => ({ api: c.rpc('/api', { nested }) })), tables)).toThrow(/where the framework does not verify it/)
		const unknown = app.group({}, (r) => ({
			unknown: r.mutation({
				input: z.strictObject({ t: signedToken('invoice') }),
				output: Empty,
				access: { public: true },
				actions: ['bookings.book'],
			}).handle(() => ({})),
		}))
		expect(() => compileContract(app.contract((c) => ({ api: c.rpc('/api', { unknown }) })), tables)).toThrow(/names no token purpose/)
		const signing = app.cron('0 3 * * *', { actions: ['mail.read'], scope: 'app', signs: ['unsubscribe'] }).handle(() => {})
		expect(
			compileContract(app.contract((c) => ({ api: c.rpc('/api', { mail: app.group({ callers: ['human'] }, () => ({})) }), jobs: { signing } })), tables)
				.declared?.['job:signing'],
		)
			.toMatchObject({ signs: ['unsubscribe'] })
	})

	test('a contract takes its tokens from the kit, never a section of its own', () => {
		// The types refuse the section; a contract that slips past them is refused when it is built.
		const written = () => ({ tokens: { other: token(Recipient, { maxDays: 1 }) } })
		expect(() => Reflect.apply(app.contract, app, [written])).toThrow(/tokens come from defineApp/)
	})
})

describe('the keys and the token format', () => {
	const secret = (byte: number) => Buffer.from(new Uint8Array(32).fill(byte)).toString('base64url')
	const purposes = new Map([['unsubscribe', { claims: Recipient, maxDays: 400 }]])
	const claims = { email: 'ann@example.com', campaign: 'spring' }

	test('a key that signed stays verifying after a rotation puts a new key first', () => {
		const old = readTokenKeys({ [FABRIKA_TOKEN_KEYS]: `oldkey01:${secret(1)}` }, artifact, [])
		const signed = new SignedTokens(purposes, old).context('a site', ['unsubscribe']).sign('unsubscribe', claims, { days: 400 })
		const rotated = readTokenKeys({ [FABRIKA_TOKEN_KEYS]: `newkey01:${secret(2)},oldkey01:${secret(1)}` }, artifact, [])
		expect(new SignedTokens(purposes, rotated).verify('unsubscribe', signed)).toEqual(claims)
		const dropped = readTokenKeys({ [FABRIKA_TOKEN_KEYS]: `newkey01:${secret(2)}` }, artifact, [])
		expect(() => new SignedTokens(purposes, dropped).verify('unsubscribe', signed)).toThrow(/not valid/)
	})

	test('refuses a tampered token, another purpose, an expired token and a lifetime past maxDays', () => {
		const keys = readTokenKeys({ [FABRIKA_TOKEN_KEYS]: `onlykey1:${secret(3)}` }, artifact, [])
		let now = Date.UTC(2026, 0, 1)
		const tokens = new SignedTokens(new Map([...purposes, ['other', { claims: Recipient, maxDays: 1 }]]), keys, () => now)
		const signed = tokens.context('a site', ['unsubscribe']).sign('unsubscribe', claims, { days: 1 })
		const [id, payload, signature] = signed.split('.')
		const forged = Buffer.from(JSON.stringify({ p: 'unsubscribe', x: 4_000_000_000, c: claims })).toString('base64url')
		expect(() => tokens.verify('unsubscribe', `${id}.${forged}.${signature}`)).toThrow(/not valid/)
		expect(() => tokens.verify('other', signed)).toThrow(/not valid/)
		expect(() => tokens.verify('unsubscribe', `${id}.${payload}`)).toThrow(/not valid/)
		now += 2 * 86_400_000
		expect(() => tokens.verify('unsubscribe', signed)).toThrow(/expired/)
		expect(() => tokens.context('a site', ['unsubscribe']).sign('unsubscribe', claims, { days: 401 })).toThrow(/allows 1 to 400/)
		expect(() => tokens.context('a site', ['unsubscribe']).sign('other', claims, { days: 1 })).toThrow(/does not declare signs/)
	})

	test('boot refuses a contract with purposes and no keys, and a malformed key', () => {
		const problems: string[] = []
		expect(readTokenKeys({}, artifact, problems)).toBeNull()
		expect(readTokenKeys({ [FABRIKA_TOKEN_KEYS]: 'short:abc' }, artifact, problems)).toBeNull()
		expect(problems).toEqual([expect.stringContaining('is not set'), expect.stringContaining('<key id>:<secret>')])
	})
})

const postgres = await testDatabase({ migrations: join(import.meta.dir, 'token-fixture', 'db', 'migrations'), label: 'signed-tokens.test.ts' })

afterAll(async () => {
	await postgres?.close()
})

if (postgres !== null) {
	const kit = testKit(serve(contract, { database: scoped(tables) }), { database: postgres.database })
	const staff = kit.testCaller([{ role: 'staff' }])
	const unsubscribe = (query: string) =>
		kit.fetch(`/api/mail.unsubscribe?${query}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: kit.origin },
			body: 'List-Unsubscribe=One-Click',
		})
	const unsubscribed = async () => {
		const listed = await kit.browser(staff)('/api/staff.unsubscribes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
		return Unsubscribed.parse((await listed.json()).result).items
	}

	describe('signed tokens through the proxy and boot', () => {
		test('a one-click unsubscribe reads the recipient from its verified token, once per campaign', async () => {
			const email = `${crypto.randomUUID()}@example.com`
			const signed = kit.signToken('unsubscribe', { email, campaign: 'spring' }, { days: 400 })
			expect((await unsubscribe(`t=${signed}`)).status).toBe(200)
			expect((await unsubscribe(`t=${signed}`)).status).toBe(200)
			expect((await unsubscribed()).filter((row) => row.email === email)).toEqual([{ email, campaign: 'spring' }])
		})

		test('a tampered token, a token of another purpose and none are refused before the handler', async () => {
			const signed = kit.signToken('unsubscribe', { email: 'bob@example.com', campaign: 'spring' }, { days: 1 })
			expect((await unsubscribe(`t=${signed.slice(0, -2)}xx`)).status).toBe(400)
			const booking = kit.signToken('booking', { booking: crypto.randomUUID() }, { days: 1 })
			expect((await unsubscribe(`t=${booking}`)).status).toBe(400)
			expect((await unsubscribe('')).status).toBe(400)
			expect((await unsubscribed()).some((row) => row.email === 'bob@example.com')).toBe(false)
		})

		test('a booking procedure answers its own management link, signed with the environment key', async () => {
			const response = await kit.fetch('/api/bookings.book', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: 'Ann', slot: 'mon-9' }),
			})
			expect(response.status).toBe(200)
			const { id, manage } = Booked.parse((await response.json()).result)
			const [, payload] = manage.split('.')
			expect(JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8'))).toMatchObject({ p: 'booking', c: { booking: id } })
		})
	})
} else {
	test.skip('signed tokens through the proxy and boot (set FABRIKA_TEST_POSTGRES_URL)', () => {})
}
