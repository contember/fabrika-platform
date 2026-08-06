/**
 * `TokenVerifier` conformance — one table, two implementations, identical verdicts.
 *
 * `packages/auth/src/verify.ts` and `packages/proxy/src/verifier.ts` are near-twins, and sharing the
 * code was considered and REJECTED: `@fabrika/auth-core` is deliberately jose-free and
 * dependency-free, the proxy must not depend on the app SDK, and a package existing to share ~90
 * lines between two consumers with genuinely different cache lifetimes is over-engineering.
 *
 * What must not drift is their THREE-STATE semantics — a decided negative ("this token is bad", 401),
 * versus "we could not consult IAM" (503), versus valid. Collapsing the first two would let a JWKS
 * outage read as a forged token, which is a silent incident on one side and a login loop on the
 * other. So the shared property is pinned here rather than in the code.
 *
 * It lives OUTSIDE `src/`, like `proxy-gates.test.ts` and `console-access-plane.test.ts`:
 * `tsconfig.json` includes `src/**` only, so reaching across into two other packages never enters
 * this package's program. The key material and the signing helper are borrowed from the proxy suite
 * because `jose` resolves from that package, not from this one.
 */

import { describe, expect, test } from 'bun:test'
import { IamRpcStub } from '../../auth/src/__tests__/stub'
import { TokenVerifier as AuthTokenVerifier } from '../../auth/src/verify'
import { APP, foreignPrivateKey, ISSUER, PUBLIC_JWKS, ROTATED_JWKS, rotatedPrivateKey, signToken } from '../../proxy-core/src/__tests__/helpers'
import { TokenVerifier as ProxyTokenVerifier } from '../../proxy-core/src/verifier'

/** The three states, flattened to one word so two different result types compare directly. */
type Verdict = 'valid' | 'invalid' | 'unavailable'

function verdict(result: { ok: true } | { ok: false; reason: 'invalid' | 'unavailable' }): Verdict {
	return result.ok ? 'valid' : result.reason
}

/** Verify one token. Both implementations are reduced to this, so the table can drive either. */
type Verify = (token: string) => Promise<Verdict>

interface Implementation {
	readonly name: string
	/**
	 * `keys` is that implementation's OWN key-set source, so `jwksCalls` counts its fetches alone. The
	 * proxy takes a bare `getJwks` and an audience per call; the SDK takes the whole `IamRpc` binding
	 * and fixes the audience at construction. That difference is the constructor, not the semantics.
	 */
	build(keys: IamRpcStub, now: () => number): Verify
}

const IMPLEMENTATIONS: Implementation[] = [
	{
		name: '@fabrika/proxy',
		build(keys, now) {
			const verifier = new ProxyTokenVerifier(() => keys.getJwks(), ISSUER, now)
			return async (token) => verdict(await verifier.verify(token, APP))
		},
	},
	{
		name: '@fabrika/auth',
		build(keys, now) {
			const verifier = new AuthTokenVerifier(keys, ISSUER, APP, now)
			return async (token) => verdict(await verifier.verify(token))
		},
	},
]

function keySource(): IamRpcStub {
	const keys = new IamRpcStub()
	keys.jwks = PUBLIC_JWKS
	return keys
}

interface Scenario {
	name: string
	expected: Verdict
	/** How many times the key set may be fetched. Asserted only where the count is the point. */
	fetches?: number
	run(verify: Verify, keys: IamRpcStub): Promise<Verdict>
}

const SCENARIOS: Scenario[] = [
	{
		name: 'a token signed by the published key',
		expected: 'valid',
		fetches: 1,
		run: (verify) => signToken({}).then(verify),
	},
	{
		name: 'a token minted for a DIFFERENT app',
		expected: 'invalid',
		// The proxy already admitted it, so this is the check that stops one app spending another's
		// token. Both sides must call it a decided negative, never an outage.
		run: (verify) => signToken({ audience: 'another-app' }).then(verify),
	},
	{
		name: 'a token from a DIFFERENT issuer',
		expected: 'invalid',
		run: (verify) => signToken({ issuer: 'https://evil.test' }).then(verify),
	},
	{
		name: 'an expired token',
		expected: 'invalid',
		run: (verify) => signToken({ ttlSeconds: -60 }).then(verify),
	},
	{
		name: 'a known kid whose signature is from an unpublished key',
		expected: 'invalid',
		run: (verify) => signToken({ key: foreignPrivateKey }).then(verify),
	},
	{
		name: 'an unknown kid: exactly ONE refetch, and the rotated-in key then verifies',
		expected: 'valid',
		fetches: 2,
		async run(verify, keys) {
			// Warm the cache with the pre-rotation key set, exactly as a live process would be.
			expect(await verify(await signToken({}))).toBe('valid')
			keys.jwks = ROTATED_JWKS
			return verify(await signToken({ kid: 'k2', key: rotatedPrivateKey }))
		},
	},
	{
		name: 'a kid absent from the cached set AND from the refetched one',
		expected: 'invalid',
		fetches: 2,
		// The refetch is spent and the answer is still "no". A third fetch would be an amplification
		// primitive; reporting `unavailable` would turn a bad token into an incident.
		run: (verify) => signToken({ kid: 'never-published', key: rotatedPrivateKey }).then(verify),
	},
	{
		name: 'a key set that cannot be fetched at all',
		expected: 'unavailable',
		async run(verify, keys) {
			keys.jwksError = new Error('connect ECONNREFUSED')
			return verify(await signToken({}))
		},
	},
	{
		name: 'a key set that becomes unfetchable after the cache warmed — never a stale verifier',
		expected: 'unavailable',
		async run(verify, keys) {
			// The warm entry is not reused across an unknown kid's forced refetch: the previous key set
			// may have been rotated out precisely because it was compromised.
			expect(await verify(await signToken({}))).toBe('valid')
			keys.jwksError = new Error('connect ECONNREFUSED')
			return verify(await signToken({ kid: 'k2', key: rotatedPrivateKey }))
		},
	},
]

const now = (): number => Math.floor(Date.now() / 1000)

for (const scenario of SCENARIOS) {
	describe(scenario.name, () => {
		for (const implementation of IMPLEMENTATIONS) {
			test(`${implementation.name} answers ${scenario.expected}`, async () => {
				const keys = keySource()
				const answer = await scenario.run(implementation.build(keys, now), keys)
				expect(`${implementation.name}: ${answer}`).toBe(`${implementation.name}: ${scenario.expected}`)
				if (scenario.fetches !== undefined) {
					expect(`${implementation.name}: ${keys.jwksCalls} fetches`).toBe(`${implementation.name}: ${scenario.fetches} fetches`)
				}
			})
		}
	})
}

// ── Where they differ, and why the difference is deliberate ───────────────────

describe('the caching differs on purpose, and the difference is asserted rather than skipped', () => {
	test('the proxy rate-limits unknown-kid refetches; the SDK does not, because it cannot be driven', async () => {
		// The proxy is the only publicly-routed component: a client that invents a `kid` per request
		// would turn every request into a JWKS round trip, so `mayForceRefetch` caps it. The SDK sees
		// only the token the PROXY injected — the generated Caddy config strips the header off the
		// inbound request — so the same input does not exist there and a cooldown would only add lag.
		const proxyKeys = keySource()
		const proxyVerifier = new ProxyTokenVerifier(() => proxyKeys.getJwks(), ISSUER, now)
		const authKeys = keySource()
		const authVerifier = new AuthTokenVerifier(authKeys, ISSUER, APP, now)

		for (let i = 0; i < 10; i++) {
			const token = await signToken({ kid: `unknown-${i}`, key: rotatedPrivateKey })
			expect(verdict(await proxyVerifier.verify(token, APP))).toBe('invalid')
			expect(verdict(await authVerifier.verify(token))).toBe('invalid')
		}
		// One warm fetch plus at most one forced refetch inside the cooldown window.
		expect(proxyKeys.jwksCalls).toBeLessThanOrEqual(2)
		// One warm fetch plus one forced refetch per attempt.
		expect(authKeys.jwksCalls).toBe(11)
	})

	test('the SDK caches per BINDING, so a second verifier over one binding makes no second fetch', async () => {
		// `@fabrika/app` calls `middleware(env)` per request, so the SDK object is per-request while the
		// binding lives for the isolate. Caching per instance there would refetch the JWKS every request.
		const keys = keySource()
		const token = await signToken({})
		expect(verdict(await new AuthTokenVerifier(keys, ISSUER, APP, now).verify(token))).toBe('valid')
		expect(verdict(await new AuthTokenVerifier(keys, ISSUER, APP, now).verify(token))).toBe('valid')
		expect(keys.jwksCalls).toBe(1)

		// The proxy is one long-lived process holding one verifier, so its cache is per instance — a
		// second one starts cold.
		const proxyKeys = keySource()
		expect(verdict(await new ProxyTokenVerifier(() => proxyKeys.getJwks(), ISSUER, now).verify(token, APP))).toBe('valid')
		expect(verdict(await new ProxyTokenVerifier(() => proxyKeys.getJwks(), ISSUER, now).verify(token, APP))).toBe('valid')
		expect(proxyKeys.jwksCalls).toBe(2)
	})
})
