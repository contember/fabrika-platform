// The part of a public procedure's admission that needs no database: how strictly a Turnstile answer is read. The
// Postgres half runs through boot in the public procedures' suites. The client a request counts as is
// `clientAddressKey`, tested in `@fabrika/auth-core`.

import { describe, expect, test } from 'bun:test'
import { CHALLENGE_LIMITS, type ChallengeFetch, TURNSTILE_VERIFY_URL, turnstileVerifier } from '../implement/challenge'
import { passingChallenge } from '../testing/challenge'

const NOW = Date.parse('2026-10-12T10:00:00.000Z')
const CHECK = { token: 'XXXX.DUMMY.TOKEN', hostname: 'apply.example.com', action: 'apply' }

function answering(answer: () => Response | Promise<Response>, seen: Request[] = []): ChallengeFetch {
	return (request) => {
		seen.push(request)
		return Promise.resolve(answer())
	}
}

const passed = (overrides: Record<string, unknown> = {}) =>
	Response.json({ success: true, challenge_ts: new Date(NOW - 1000).toISOString(), hostname: 'apply.example.com', action: 'apply', ...overrides })

describe('a Turnstile verification', () => {
	test('posts the secret and the token to siteverify, and passes a fresh token of this host and action', async () => {
		const seen: Request[] = []
		const verifier = turnstileVerifier('secret-1', answering(() => passed(), seen), () => NOW)
		expect((await verifier.verify(CHECK)).outcome).toBe('passed')
		const [request] = seen
		expect(request?.url).toBe(TURNSTILE_VERIFY_URL)
		expect(request?.method).toBe('POST')
		expect(Object.fromEntries(new URLSearchParams(await request?.text()))).toEqual({ secret: 'secret-1', response: CHECK.token })
	})

	test('a token that is no widget token is refused without asking the provider', async () => {
		const seen: Request[] = []
		const verifier = turnstileVerifier('secret-1', answering(() => passed(), seen), () => NOW)
		for (const token of ['', 'with space', 'x'.repeat(CHALLENGE_LIMITS.maxTokenLength + 1), 'line\nbreak']) {
			expect((await verifier.verify({ ...CHECK, token })).outcome).toBe('failed')
		}
		expect(seen).toEqual([])
	})

	test.each<[string, Record<string, unknown>]>([
		['another host', { hostname: 'evil.example' }],
		['another action', { action: 'contact' }],
		['no action', { action: undefined }],
		['a token older than its validity', { challenge_ts: new Date(NOW - CHALLENGE_LIMITS.maxAgeMs - 1000).toISOString() }],
		['a token from the future', { challenge_ts: new Date(NOW + CHALLENGE_LIMITS.maxSkewMs + 1000).toISOString() }],
		['no issue time', { challenge_ts: undefined }],
	])('fails %s', async (_name, overrides) => {
		expect((await turnstileVerifier('secret-1', answering(() => passed(overrides)), () => NOW).verify(CHECK)).outcome).toBe('failed')
	})

	test("the visitor's refusal fails; a refused secret is misconfigured; the provider's own error is unavailable", async () => {
		const refusing = (codes: string[]) =>
			turnstileVerifier('secret-1', answering(() => Response.json({ success: false, 'error-codes': codes })), () => NOW)
		expect((await refusing(['timeout-or-duplicate']).verify(CHECK)).outcome).toBe('failed')
		expect((await refusing(['invalid-input-response']).verify(CHECK)).outcome).toBe('failed')
		expect((await refusing(['invalid-input-secret']).verify(CHECK)).outcome).toBe('misconfigured')
		expect((await refusing(['missing-input-secret']).verify(CHECK)).outcome).toBe('misconfigured')
		expect((await refusing(['internal-error']).verify(CHECK)).outcome).toBe('unavailable')
	})

	test.each<[string, () => Response | Promise<Response>]>([
		['a 5xx', () => new Response('down', { status: 503 })],
		['a redirect', () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example' } })],
		['another content type', () => new Response('{"success":true}', { headers: { 'Content-Type': 'text/plain' } })],
		['no JSON', () => new Response('{', { headers: { 'Content-Type': 'application/json' } })],
		['a shape it does not document', () => Response.json({ success: 'yes' })],
		['an answer over its byte budget', () => Response.json({ success: true, padding: 'x'.repeat(CHALLENGE_LIMITS.maxAnswerBytes) })],
		['a network failure', () => Promise.reject(new TypeError('connection refused'))],
	])('is unavailable on %s', async (_name, answer) => {
		expect((await turnstileVerifier('secret-1', answering(answer), () => NOW).verify(CHECK)).outcome).toBe('unavailable')
	})

	test('a provider that does not answer within the deadline is unavailable, and the wait is bounded', async () => {
		const hanging: ChallengeFetch = (request) =>
			new Promise((_resolve, reject) => {
				request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
			})
		const started = Date.now()
		expect((await turnstileVerifier('secret-1', hanging, () => NOW).verify(CHECK)).outcome).toBe('unavailable')
		expect(Date.now() - started).toBeLessThan(CHALLENGE_LIMITS.timeoutMs + 1000)
	}, CHALLENGE_LIMITS.timeoutMs + 3000)
})

describe("the kits' passing challenge", () => {
	test('passes every widget token for the host and the action the check names, and no other', async () => {
		const verifier = turnstileVerifier('dev-secret', passingChallenge)
		expect((await verifier.verify(CHECK)).outcome).toBe('passed')
		expect((await verifier.verify({ ...CHECK, hostname: 'other.example', action: 'contact' })).outcome).toBe('passed')
		expect((await verifier.verify({ ...CHECK, token: 'with space' })).outcome).toBe('failed')
	})
})
