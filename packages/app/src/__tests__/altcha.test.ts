// An ALTCHA challenge without a database: what the build makes of one (its issuer row, its rules, the CSP), and how the
// application issues and verifies it, nothing leaving the process. The Postgres half, the replay record and the
// buckets through boot, runs in altcha-admission.test.ts.

import { ContractError, defineApp } from '@fabrika/app/contract'
import type { ContractArtifact } from '@fabrika/auth-core'
import { cspOrigins, headerPolicy } from '@fabrika/proxy-core/headers'
import { contractProxyTable, parseProxyManifest } from '@fabrika/proxy-core/manifest'
import { solveChallenge } from 'altcha-lib'
import { deriveKey } from 'altcha-lib/algorithms/web/pbkdf2'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { parseContractArtifact } from '../contract/artifact-schema'
import { compileContract } from '../contract/compile'
import { ALTCHA_LIMITS, altchaWorstSolveMs, CHALLENGE_PREFIX, challengePath, challengeRowId } from '../contract/defaults'
import { altchaChallenge, type IssuedChallenge, MINIMAL_CHALLENGE_WORK } from '../implement/challenge'
import { contract } from './fixtures/altcha/fabrika.contract'
import { tables } from './fixtures/altcha/src/db/tables'
import { vocabulary } from './fixtures/altcha/src/vocabulary'

// The issuer's clock: altcha-lib and the verifier read a challenge's expiry on the real clock, so it is the real one at load.
const NOW = Date.now()
const RULES = { action: 'register', cost: ALTCHA_LIMITS.cost, maxAgeMs: ALTCHA_LIMITS.maxAgeMs }
const HOST = 'signup.example.com'

async function solved(issued: IssuedChallenge): Promise<string> {
	const challenge = { parameters: { ...issued.parameters }, ...(issued.signature === undefined ? {} : { signature: issued.signature }) }
	// Read back as the widget reads it: plain JSON, which the verifier then holds to its shape.
	const parsed: unknown = JSON.parse(JSON.stringify(challenge))
	const solution = await solveChallenge({ challenge: challengeOf(parsed), deriveKey })
	return btoa(JSON.stringify({ challenge: parsed, solution }))
}

function challengeOf(value: unknown): Parameters<typeof solveChallenge>[0]['challenge'] {
	if (typeof value !== 'object' || value === null) throw new Error('not a challenge')
	const parameters: unknown = Reflect.get(value, 'parameters')
	if (typeof parameters !== 'object' || parameters === null) throw new Error('not a challenge')
	const read = (name: string): string => String(Reflect.get(parameters, name))
	return {
		parameters: {
			algorithm: read('algorithm'),
			nonce: read('nonce'),
			salt: read('salt'),
			cost: Number(Reflect.get(parameters, 'cost')),
			keyLength: Number(Reflect.get(parameters, 'keyLength')),
			keyPrefix: read('keyPrefix'),
		},
	}
}

/** The payload with its JSON rewritten by `edit`, base64 again. */
function edited(token: string, edit: (payload: Record<string, unknown>) => unknown): string {
	const payload: unknown = JSON.parse(atob(token))
	if (typeof payload !== 'object' || payload === null) throw new Error('not a payload')
	return btoa(JSON.stringify(edit({ ...payload })))
}

describe('an ALTCHA challenge, issued and verified by the application', () => {
	const { issuer, verifier } = altchaChallenge('hmac-key-1', RULES, MINIMAL_CHALLENGE_WORK, () => NOW)

	test('a solved challenge passes for the host and the action it was issued for', async () => {
		const token = await solved(await issuer.issue(HOST))
		expect((await verifier.verify({ token, hostname: HOST, action: 'register' })).outcome).toBe('passed')
	})

	test('the challenge carries the contract’s cost, the action, the host and its expiry, signed', async () => {
		const real = altchaChallenge('hmac-key-1', { ...RULES, cost: 2000, maxAgeMs: 120_000 }, null, () => NOW)
		const issued = await real.issuer.issue(HOST)
		expect(issued.parameters).toMatchObject({
			algorithm: 'PBKDF2/SHA-256',
			cost: 2000,
			keyLength: 32,
			expiresAt: Math.floor((NOW + 120_000) / 1000),
			data: { action: 'register', host: HOST },
		})
		expect(issued.signature).toMatch(/^[0-9a-f]{64}$/)
	})

	test('another host, another action, or an expired challenge is refused', async () => {
		const token = await solved(await issuer.issue(HOST))
		expect((await verifier.verify({ token, hostname: 'other.example.com', action: 'register' })).outcome).toBe('failed')
		expect((await verifier.verify({ token, hostname: HOST, action: 'enroll' })).outcome).toBe('failed')
		// Issued a lifetime and a second ago: expired on the real clock, which the verifier and altcha-lib both read.
		const earlier = altchaChallenge('hmac-key-1', RULES, MINIMAL_CHALLENGE_WORK, () => Date.now() - RULES.maxAgeMs - 1000).issuer
		const expired = await solved(await earlier.issue(HOST))
		expect((await verifier.verify({ token: expired, hostname: HOST, action: 'register' })).outcome).toBe('failed')
	})

	test('a challenge signed with another key, or whose parameters were changed, is refused', async () => {
		const token = await solved(await issuer.issue(HOST))
		const other = altchaChallenge('hmac-key-2', RULES, MINIMAL_CHALLENGE_WORK, () => NOW).verifier
		expect((await other.verify({ token, hostname: HOST, action: 'register' })).outcome).toBe('failed')
		const moved = edited(token, (payload) => {
			const challenge = payload['challenge']
			if (typeof challenge !== 'object' || challenge === null) return payload
			const parameters: unknown = Reflect.get(challenge, 'parameters')
			return { ...payload, challenge: { ...challenge, parameters: { ...Object(parameters), data: { action: 'register', host: 'evil.example.com' } } } }
		})
		expect((await verifier.verify({ token: moved, hostname: 'evil.example.com', action: 'register' })).outcome).toBe('failed')
	})

	test('a solution that is not the challenge’s is refused', async () => {
		const token = await solved(await issuer.issue(HOST))
		const guessed = edited(token, (payload) => ({ ...payload, solution: { counter: 0, derivedKey: '0'.repeat(64) } }))
		expect((await verifier.verify({ token: guessed, hostname: HOST, action: 'register' })).outcome).toBe('failed')
	})

	test('the widget’s test payload, a server-signed one and anything that is no payload are refused unread', async () => {
		for (
			const token of [
				btoa(JSON.stringify({ challenge: null, solution: null, test: true })),
				btoa(JSON.stringify({ algorithm: 'SHA-256', signature: 'x', verificationData: 'verified=true', verified: true })),
				'',
				'not base64!',
				btoa('not json'),
				'A'.repeat(ALTCHA_LIMITS.maxTokenLength + 4),
			]
		) {
			expect((await verifier.verify({ token, hostname: HOST, action: 'register' })).outcome).toBe('failed')
		}
	})

	test('one solution has one replay key however its JSON is spelled', async () => {
		const token = await solved(await issuer.issue(HOST))
		const respelled = edited(token, (payload) => ({ solution: payload['solution'], challenge: payload['challenge'] }))
		expect(respelled).not.toBe(token)
		const once = await verifier.verify({ token, hostname: HOST, action: 'register' })
		const again = await verifier.verify({ token: respelled, hostname: HOST, action: 'register' })
		expect(again.outcome).toBe('passed')
		expect(again).toEqual(once)
		expect(once).toEqual({ outcome: 'passed', replayKey: expect.stringMatching(/^[0-9a-f]{64}$/) })
		expect(verifier.recordMs).toBeGreaterThan(RULES.maxAgeMs)
	})
})

describe('what the build makes of an ALTCHA challenge', () => {
	const artifact = compileContract(contract, tables)

	test('each procedure gets its own issuer: a GET under its action, from the procedure’s origins, with its own buckets', () => {
		const register = artifact.endpoints.find((row) => row.id === 'api.signups.register')
		const issuer = artifact.endpoints.find((row) => row.id === challengeRowId('api.signups.register'))
		expect(issuer).toEqual({
			id: 'api.signups.register.challenge',
			source: { kind: 'challenge', name: 'api.signups.register' },
			kind: 'public',
			method: 'GET',
			path: challengePath('api_signups_register'),
			admission: null,
			input: null,
			output: null,
			callers: [],
			requirement: null,
			crossOrigin: 'environment',
		})
		expect(register?.crossOrigin).toBe('environment')
		// At least the defaults, and at least twice the procedure's own 20 and 50.
		expect(artifact.procedures?.[challengeRowId('api.signups.register')]).toEqual({
			rate: { perClient: 40, perCaller: null, perEndpoint: 600, bytesPerHour: null },
			challenge: null,
			timeoutMs: 10_000,
		})
		const enroll = artifact.endpoints.find((row) => row.id === challengeRowId('api.signups.enroll'))
		expect(enroll?.path).toBe('/__fabrika/challenge/enroll')
		expect(enroll?.crossOrigin).toBeUndefined()
	})

	test('the challenge records its cost and lifetime, the defaults where the contract names none', () => {
		expect(artifact.procedures?.['api.signups.register']?.challenge).toEqual({
			provider: 'altcha',
			secret: 'ALTCHA_HMAC_KEY',
			action: 'api_signups_register',
			cost: 5000,
			maxAgeMs: 600_000,
		})
		expect(artifact.procedures?.['api.signups.enroll']?.challenge).toMatchObject({ action: 'enroll', cost: 2000, maxAgeMs: 120_000 })
	})

	test('no script or frame origin joins the CSP, only blob: workers, which the header policy emits', () => {
		expect(artifact.csp.scriptSrc).toBeUndefined()
		expect(artifact.csp.frameSrc).toBeUndefined()
		expect(artifact.csp.workerSrc).toEqual([{
			origin: 'blob:',
			purpose: "the workers of the altcha challenge of 'api.signups.enroll', 'api.signups.register'",
		}])
		const [, csp] = headerPolicy(cspOrigins(artifact.csp), null)[0] ?? []
		expect(csp).toContain("worker-src 'self' blob:")
		expect(csp).toContain("script-src 'self';")
	})

	test('the artifact parses back, and its proxy table parses in a manifest', () => {
		expect(parseContractArtifact(JSON.parse(JSON.stringify(artifact)))).toEqual(artifact)
		const table = contractProxyTable(artifact)
		expect(table.csp.workerSrc).toEqual(['blob:'])
		const manifest = parseProxyManifest({
			apps: [{ id: 'notes@prod', hosts: ['notes.example.com'], upstream: 'http://notes:8080', scheme: 'https', ...table }],
		})
		const [entry] = manifest?.apps ?? []
		expect(entry !== undefined && 'endpoints' in entry && entry.endpoints.some((row) => row.id === 'api.signups.register.challenge')).toBe(true)
	})
})

describe('the CSP of a contract without an ALTCHA challenge', () => {
	test('keeps no worker-src and its manifest no workerSrc, so an older proxy still parses it', () => {
		const origins = cspOrigins({ connectSrc: [], imgSrc: [], frameAncestors: [] })
		expect('workerSrc' in origins).toBe(false)
		const [, csp] = headerPolicy(origins, null)[0] ?? []
		expect(csp).not.toContain('worker-src')
	})
})

/** The contract of one public registration with `admission`, compiled, or the build's problems when it refuses. */
function registration(admission: Record<string, unknown>): { readonly artifact: ContractArtifact | null; readonly problems: readonly string[] } {
	const app = defineApp(vocabulary, tables)
	const signups = app.group({}, (r) => ({
		register: r.mutation({
			input: z.strictObject({ name: z.string(), email: z.email(), challengeToken: z.string() }),
			output: z.strictObject({ received: z.boolean() }),
			access: { public: true },
			actions: ['applications.submit'],
			admission,
		}).handle(() => ({ received: true })),
	}))
	try {
		return { artifact: compileContract(app.contract((c) => ({ api: c.rpc('/api', { signups }) })), tables), problems: [] }
	} catch (error) {
		if (error instanceof ContractError) return { artifact: null, problems: error.problems }
		throw error
	}
}

const ALTCHA = { provider: 'altcha', secret: 'ALTCHA_HMAC_KEY' }

describe('the bounds of an ALTCHA challenge', () => {
	test('a cost a slow phone cannot solve within the widget’s time or half the lifetime is refused', () => {
		expect(altchaWorstSolveMs(ALTCHA_LIMITS.cost)).toBe(25_000)
		expect(registration({ challenge: { ...ALTCHA, cost: 12_000, maxAgeMs: 60_000 } }).problems).toEqual([
			expect.stringContaining('takes a slow phone up to 60000 ms'),
		])
		expect(registration({ challenge: { ...ALTCHA, cost: 12_000, maxAgeMs: 120_000 } }).problems).toEqual([])
		expect(registration({ challenge: { ...ALTCHA, cost: 100_000 } }).problems).toEqual([
			expect.stringContaining('challenge.cost 100000 is not a whole number of iterations from 1000 to 18000'),
		])
	})

	test('the issuer admits at least twice the procedure’s buckets, and keeps its own where the procedure turned one off', () => {
		const { artifact } = registration({ challenge: ALTCHA, rate: { perClient: null, perEndpoint: 3000 } })
		// Every issue costs a PBKDF2 derivation, so the issuer is never unbounded, whatever the procedure's handler costs.
		expect(artifact?.procedures?.[challengeRowId('api.signups.register')]?.rate).toEqual({
			perClient: 30,
			perCaller: null,
			perEndpoint: 6000,
			bytesPerHour: null,
		})
	})

	test('the challenge prefix is reserved, so a path below it no row serves is a 404 and never an SPA', () => {
		expect(registration({ challenge: ALTCHA }).artifact?.reservedPrefixes).toContain(CHALLENGE_PREFIX)
		expect(registration({}).artifact?.reservedPrefixes).not.toContain(CHALLENGE_PREFIX)
	})
})
