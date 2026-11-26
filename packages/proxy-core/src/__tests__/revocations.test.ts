/**
 * IAM's revocation feed gates the token cache (ADR-0022, "Revocation reaches a cached token"). The properties under
 * test: a cached token outlives a revocation by at most `REVOCATION_FEED_INTERVAL_SECONDS`, and every way the feed can
 * be missing, stale or broken turns the cache off, so the proxy mints and IAM decides.
 */

import type { IamRevocationRpc, RevocationsInput, RevocationsResult } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { MemoryTokenCache } from '../cache'
import { PROXY_TOKEN_HEADER } from '../constants'
import { type FetchLike, HttpIamGateway, IamUnavailableError } from '../iam'
import { REVOCATION_FEED_INTERVAL_SECONDS, RevocationFeed } from '../revocations'
import { createVerifyService } from '../service'
import { FakeIam, ISSUER, manifestWith, serviceRow, signToken, signUserToken, verifyRequest } from './helpers'

const realNow = () => Math.floor(Date.now() / 1000)

class Clock {
	constructor(public value = realNow()) {}
	readonly now = () => this.value
}

class FakeFeed implements IamRevocationRpc {
	readonly seen: RevocationsInput[] = []
	answer: RevocationsResult | Error

	constructor(answer: RevocationsResult | Error = { ok: true, now: realNow(), complete: true, subjects: [] }) {
		this.answer = answer
	}

	revocations(input: RevocationsInput): Promise<RevocationsResult> {
		this.seen.push(input)
		return this.answer instanceof Error ? Promise.reject(this.answer) : Promise.resolve(this.answer)
	}
}

describe('RevocationFeed', () => {
	test('no source admits nothing and asks nothing', async () => {
		const feed = new RevocationFeed(null, new Clock().now)
		expect(await feed.admits('user-1', realNow())).toBe(false)
	})

	test('a fresh read admits a subject with no revocation and is reused within the interval', async () => {
		const clock = new Clock()
		const source = new FakeFeed()
		const feed = new RevocationFeed(source, clock.now)
		expect(await feed.admits('user-1', clock.value)).toBe(true)
		clock.value += REVOCATION_FEED_INTERVAL_SECONDS - 1
		expect(await feed.admits('user-1', clock.value)).toBe(true)
		expect(source.seen).toStrictEqual([{ since: null }])
	})

	test('a revocation at or after the token issue time refuses it; a token issued later is admitted', async () => {
		const clock = new Clock()
		const source = new FakeFeed({ ok: true, now: clock.value, complete: true, subjects: [{ subject: 'user-1', at: clock.value - 5 }] })
		const feed = new RevocationFeed(source, clock.now)
		expect(await feed.admits('user-1', clock.value - 6)).toBe(false)
		expect(await feed.admits('user-1', clock.value - 5)).toBe(false)
		expect(await feed.admits('user-1', clock.value - 4)).toBe(true)
		expect(await feed.admits('user-2', clock.value - 60)).toBe(true)
	})

	test('past the interval the feed reads again from just before the previous answer', async () => {
		const clock = new Clock()
		const source = new FakeFeed({ ok: true, now: 1000, complete: true, subjects: [] })
		const feed = new RevocationFeed(source, clock.now)
		await feed.admits('user-1', 999)
		clock.value += REVOCATION_FEED_INTERVAL_SECONDS
		source.answer = { ok: true, now: 1005, complete: true, subjects: [{ subject: 'user-1', at: 1003 }] }
		expect(await feed.admits('user-1', 999)).toBe(false)
		expect(source.seen).toStrictEqual([{ since: null }, { since: 990 }])
	})

	test('a revocation stays known across later reads that no longer list it', async () => {
		const clock = new Clock()
		const source = new FakeFeed({ ok: true, now: 1000, complete: true, subjects: [{ subject: 'user-1', at: 1000 }] })
		const feed = new RevocationFeed(source, clock.now)
		expect(await feed.admits('user-1', 999)).toBe(false)
		clock.value += REVOCATION_FEED_INTERVAL_SECONDS
		source.answer = { ok: true, now: 1100, complete: true, subjects: [] }
		expect(await feed.admits('user-1', 999)).toBe(false)
	})

	test('a failed read admits nothing, and the feed is asked again an interval later, not per request', async () => {
		const clock = new Clock()
		const source = new FakeFeed(new Error('connect ECONNREFUSED'))
		const feed = new RevocationFeed(source, clock.now)
		expect(await feed.admits('user-1', clock.value)).toBe(false)
		source.answer = { ok: true, now: clock.value, complete: true, subjects: [] }
		expect(await feed.admits('user-1', clock.value)).toBe(false)
		expect(source.seen).toHaveLength(1)
		clock.value += REVOCATION_FEED_INTERVAL_SECONDS
		expect(await feed.admits('user-1', clock.value)).toBe(true)
		expect(source.seen).toHaveLength(2)
	})

	test('a refusal admits nothing', async () => {
		const feed = new RevocationFeed(new FakeFeed({ ok: false, reason: 'not_allowed' }), new Clock().now)
		expect(await feed.admits('user-1', realNow())).toBe(false)
	})

	test('a stale read admits nothing when the next read fails', async () => {
		const clock = new Clock()
		const source = new FakeFeed()
		const feed = new RevocationFeed(source, clock.now)
		expect(await feed.admits('user-1', clock.value)).toBe(true)
		clock.value += REVOCATION_FEED_INTERVAL_SECONDS
		source.answer = new Error('timeout')
		expect(await feed.admits('user-1', clock.value)).toBe(false)
	})

	test('an incomplete answer refuses every token issued up to its time', async () => {
		const clock = new Clock()
		const source = new FakeFeed({ ok: true, now: 1000, complete: false, subjects: [] })
		const feed = new RevocationFeed(source, clock.now)
		expect(await feed.admits('anyone', 1000)).toBe(false)
		expect(await feed.admits('anyone', 1001)).toBe(true)
	})

	test('concurrent requests share one read', async () => {
		const clock = new Clock()
		let release = (_: RevocationsResult) => {}
		let calls = 0
		const source: IamRevocationRpc = {
			revocations: () => {
				calls++
				return new Promise((resolve) => {
					release = resolve
				})
			},
		}
		const feed = new RevocationFeed(source, clock.now)
		const answers = Promise.all([feed.admits('a', clock.value), feed.admits('b', clock.value), feed.admits('c', clock.value)])
		release({ ok: true, now: clock.value, complete: true, subjects: [] })
		expect(await answers).toStrictEqual([true, true, true])
		expect(calls).toBe(1)
	})
})

describe('a revocation reaches a cached token within the feed interval', () => {
	test('a human session re-mints once the feed lists its subject, and IAM refuses it', async () => {
		const clock = new Clock()
		const token = await signUserToken()
		let mint: { ok: true; token: string; expiresAt: number } | { ok: false; reason: 'disabled' } = { ok: true, token, expiresAt: realNow() + 300 }
		let revocations: RevocationsResult = { ok: true, now: realNow(), complete: true, subjects: [] }
		const iam = new FakeIam({ mintToken: () => mint, revocations: () => revocations })
		const verify = createVerifyService({
			manifest: manifestWith([serviceRow('/*', ['human'])]),
			iam,
			revocations: iam,
			issuer: ISSUER,
			cache: new MemoryTokenCache(),
			now: clock.now,
		})
		const request = () => verifyRequest({ cookie: '__Host-px_session=s' })

		expect((await verify(request())).status).toBe(204)
		expect((await verify(request())).status).toBe(204)
		expect(iam.mintTokenCalls).toBe(1)

		// The principal is disabled now. Within the interval the cached token may still be served…
		mint = { ok: false, reason: 'disabled' }
		revocations = { ok: true, now: realNow(), complete: true, subjects: [{ subject: 'user-1', at: realNow() }] }
		// …but the first request at the interval's end reads the feed, drops the cached token and asks IAM.
		clock.value += REVOCATION_FEED_INTERVAL_SECONDS
		const refused = await verify(request())
		expect(refused.status).not.toBe(204)
		expect(refused.headers.get(PROXY_TOKEN_HEADER)).toBeNull()
		expect(iam.mintTokenCalls).toBe(2)
	})

	test('a px_ key re-mints once the feed lists its subject', async () => {
		const clock = new Clock()
		const token = await signToken({ type: 'service', subject: 'svc-1' })
		let revocations: RevocationsResult = { ok: true, now: realNow(), complete: true, subjects: [] }
		const iam = new FakeIam({ mintFromKey: { ok: true, token, expiresAt: realNow() + 300 }, revocations: () => revocations })
		const verify = createVerifyService({
			manifest: manifestWith([serviceRow('/*', ['machine'])]),
			iam,
			revocations: iam,
			issuer: ISSUER,
			cache: new MemoryTokenCache(),
			now: clock.now,
		})
		await verify(verifyRequest({ bearer: 'px_ci' }))
		await verify(verifyRequest({ bearer: 'px_ci' }))
		expect(iam.mintFromKeyCalls).toBe(1)

		revocations = { ok: true, now: realNow(), complete: true, subjects: [{ subject: 'svc-1', at: realNow() }] }
		clock.value += REVOCATION_FEED_INTERVAL_SECONDS
		await verify(verifyRequest({ bearer: 'px_ci' }))
		expect(iam.mintFromKeyCalls).toBe(2)
	})
})

describe('version skew: a proxy newer than its IAM fails closed', () => {
	async function sessionRun(revocations: IamRevocationRpc | null | undefined, iam: FakeIam) {
		const verify = createVerifyService({
			manifest: manifestWith([serviceRow('/*', ['human'])]),
			iam,
			...(revocations === undefined ? {} : { revocations }),
			issuer: ISSUER,
			cache: new MemoryTokenCache(),
		})
		for (let i = 0; i < 3; i++) {
			const response = await verify(verifyRequest({ cookie: '__Host-px_session=s' }))
			expect(response.status).toBe(204)
		}
		return iam.mintTokenCalls
	}

	test('an IAM gateway without the feed: same decisions, every request mints', async () => {
		const token = await signUserToken()
		expect(await sessionRun(undefined, new FakeIam({ mintToken: { ok: true, token, expiresAt: realNow() + 300 } }))).toBe(3)
		expect(await sessionRun(null, new FakeIam({ mintToken: { ok: true, token, expiresAt: realNow() + 300 } }))).toBe(3)
	})

	test('a binding whose IAM rejects the method (an older IAM Worker): same decisions, every request mints', async () => {
		const token = await signUserToken()
		const iam = new FakeIam({ mintToken: { ok: true, token, expiresAt: realNow() + 300 } })
		const older: IamRevocationRpc = {
			revocations: () => Promise.reject(new TypeError('The RPC receiver does not implement the method "revocations".')),
		}
		expect(await sessionRun(older, iam)).toBe(3)
	})

	test('an IAM over HTTP that answers 404 on the feed path: same decisions, every request mints', async () => {
		const token = await signUserToken()
		const iam = new FakeIam({ mintToken: { ok: true, token, expiresAt: realNow() + 300 } })
		const paths: string[] = []
		const fetchImpl: FetchLike = async (input) => {
			paths.push(new URL(input).pathname)
			return new Response('not found', { status: 404 })
		}
		const gateway = new HttpIamGateway({ origin: 'https://iam.test', fetch: fetchImpl })
		expect(await sessionRun(gateway, iam)).toBe(3)
		// The first request has nothing cached; the second asks the feed, and the third does not ask again so soon.
		expect(paths).toStrictEqual(['/auth/mint/revocations'])
	})
})

describe('HttpIamGateway.revocations', () => {
	function gatewayAnswering(status: number, body: string) {
		const sent: { url: string; body: string | null; redirect: RequestRedirect | undefined }[] = []
		const fetchImpl: FetchLike = async (input, init) => {
			sent.push({ url: input, body: typeof init.body === 'string' ? init.body : null, redirect: init.redirect })
			return new Response(body, { status, headers: { 'content-type': 'application/json' } })
		}
		return { gateway: new HttpIamGateway({ origin: 'https://iam.test/', key: 'proxy-key', fetch: fetchImpl }), sent }
	}

	test('posts the cursor to the feed path and reads the answer', async () => {
		const answer: RevocationsResult = { ok: true, now: 1000, complete: true, subjects: [{ subject: 'u', at: 990 }] }
		const { gateway, sent } = gatewayAnswering(200, JSON.stringify(answer))
		expect(await gateway.revocations({ since: 900 })).toStrictEqual(answer)
		expect(sent).toStrictEqual([{ url: 'https://iam.test/auth/mint/revocations', body: '{"since":900}', redirect: 'manual' }])
	})

	test('a malformed answer is unavailable, never an empty feed', async () => {
		for (const body of ['{"ok":true,"now":1000,"subjects":[]}', '{"ok":true,"now":1000,"complete":true,"subjects":[{"subject":1,"at":2}]}', 'nope']) {
			const { gateway } = gatewayAnswering(200, body)
			await expect(gateway.revocations({ since: null })).rejects.toThrow(IamUnavailableError)
		}
	})
})
