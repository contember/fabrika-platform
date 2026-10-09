/**
 * The cache is an OPTIMISATION, never a correctness input. The property under test: with the cache
 * fully disabled every decision is byte-identical — only the number of IAM calls changes.
 */

import { AUTH_HANDOFF_CHALLENGE_PARAM, AUTH_HANDOFF_STATE_PARAM } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { cacheKey, MemoryTokenCache } from '../cache'
import { PROXY_TOKEN_HEADER } from '../constants'
import type { InstallationProxyEndpointRow } from '../manifest'
import { createVerifyService } from '../service'
import { FakeIam, type FakeIamOptions, ISSUER, manifestWith, protocolRow, serviceRow, signToken, signUserToken, verifyRequest } from './helpers'

const future = (seconds = 300) => Math.floor(Date.now() / 1000) + seconds

const HUMAN = [serviceRow('/*', ['human'])]
const MACHINE = [serviceRow('/*', ['machine'])]

function run(endpoints: InstallationProxyEndpointRow[], options: FakeIamOptions, cache: MemoryTokenCache | null) {
	const iam = new FakeIam(options)
	return { iam, verify: createVerifyService({ manifest: manifestWith(endpoints), iam, issuer: ISSUER, cache }) }
}

function stableLocation(raw: string | null): string | null {
	if (raw === null) return null
	const url = new URL(raw)
	url.searchParams.delete(AUTH_HANDOFF_STATE_PARAM)
	url.searchParams.delete(AUTH_HANDOFF_CHALLENGE_PARAM)
	return url.toString()
}

describe('cache disabled — same decisions, more calls', () => {
	test('a human session still authorizes on every request, minting each time', async () => {
		const token = await signUserToken()
		const options: FakeIamOptions = { mintToken: { ok: true, token, expiresAt: future() } }

		const cached = run(HUMAN, options, new MemoryTokenCache())
		const uncached = run(HUMAN, options, null)

		for (let i = 0; i < 3; i++) {
			const a = await cached.verify(verifyRequest({ cookie: '__Host-px_session=s' }))
			const b = await uncached.verify(verifyRequest({ cookie: '__Host-px_session=s' }))
			expect(a.status).toBe(204)
			expect(b.status).toBe(a.status)
			expect(b.headers.get(PROXY_TOKEN_HEADER)).toBe(a.headers.get(PROXY_TOKEN_HEADER))
		}
		expect(cached.iam.mintTokenCalls).toBe(1)
		expect(uncached.iam.mintTokenCalls).toBe(3)
	})

	test('a px_ key still authorizes on every request', async () => {
		const token = await signToken({ type: 'service' })
		const options: FakeIamOptions = { mintFromKey: { ok: true, token, expiresAt: future() } }

		const cached = run(MACHINE, options, new MemoryTokenCache())
		const uncached = run(MACHINE, options, null)

		for (let i = 0; i < 3; i++) {
			expect((await cached.verify(verifyRequest({ bearer: 'px_ci' }))).status).toBe(204)
			expect((await uncached.verify(verifyRequest({ bearer: 'px_ci' }))).status).toBe(204)
		}
		expect(cached.iam.mintFromKeyCalls).toBe(1)
		expect(uncached.iam.mintFromKeyCalls).toBe(3)
	})

	test('every deny in the matrix denies identically with no cache', async () => {
		const cases: { endpoints: InstallationProxyEndpointRow[]; options: FakeIamOptions; request: Request }[] = [
			{ endpoints: HUMAN, options: {}, request: verifyRequest({}) },
			{ endpoints: HUMAN, options: { mintToken: { ok: false, reason: 'disabled' } }, request: verifyRequest({ cookie: '__Host-px_session=s' }) },
			{ endpoints: MACHINE, options: {}, request: verifyRequest({ bearer: 'px_nope' }) },
			{ endpoints: MACHINE, options: { unreachable: true }, request: verifyRequest({ bearer: 'px_x' }) },
			{ endpoints: [protocolRow('/nope')], options: {}, request: verifyRequest({ path: '/yes' }) },
		]
		for (const { endpoints, options, request } of cases) {
			const withCache = await run(endpoints, options, new MemoryTokenCache()).verify(request.clone())
			const without = await run(endpoints, options, null).verify(request.clone())
			expect(without.status).toBe(withCache.status)
			expect(stableLocation(without.headers.get('location'))).toBe(stableLocation(withCache.headers.get('location')))
		}
	})

	test('a cache is never consulted for a protocol row', async () => {
		const cache = new MemoryTokenCache()
		const { verify } = run([protocolRow('/*')], {}, cache)
		expect((await verify(verifyRequest({}))).status).toBe(204)
		expect(cache.size).toBe(0)
	})
})

describe('cache correctness', () => {
	test('a cached entry inside the refresh skew is not reused', async () => {
		const nearlyExpired = await signToken({ type: 'service' })
		const iam = new FakeIam({ mintFromKey: { ok: true, token: nearlyExpired, expiresAt: future(5) } })
		const verify = createVerifyService({ manifest: manifestWith(MACHINE), iam, issuer: ISSUER, cache: new MemoryTokenCache() })
		await verify(verifyRequest({ bearer: 'px_ci' }))
		await verify(verifyRequest({ bearer: 'px_ci' }))
		// expiresAt is inside TOKEN_REFRESH_SKEW_SECONDS, so the entry is re-minted rather than ridden.
		expect(iam.mintFromKeyCalls).toBe(2)
	})

	test('two different credentials never share an entry', async () => {
		const token = await signToken({ type: 'service' })
		const iam = new FakeIam({ mintFromKey: { ok: true, token, expiresAt: future() } })
		const verify = createVerifyService({ manifest: manifestWith(MACHINE), iam, issuer: ISSUER, cache: new MemoryTokenCache() })
		await verify(verifyRequest({ bearer: 'px_a' }))
		await verify(verifyRequest({ bearer: 'px_b' }))
		expect(iam.seenKeys).toEqual(['px_a', 'px_b'])
	})

	test('keys are namespaced by app and credential kind', () => {
		expect(cacheKey('a', 'key', 'x')).not.toBe(cacheKey('b', 'key', 'x'))
		expect(cacheKey('a', 'key', 'x')).not.toBe(cacheKey('a', 'session', 'x'))
	})

	test('MemoryTokenCache is bounded — a flood of credentials cannot grow it without limit', () => {
		const cache = new MemoryTokenCache(3)
		for (let i = 0; i < 100; i++) {
			cache.set(`k${i}`, { token: 't', expiresAt: future() })
		}
		expect(cache.size).toBe(3)
		expect(cache.get('k0')).toBeUndefined()
		expect(cache.get('k99')).toBeDefined()
	})
})
