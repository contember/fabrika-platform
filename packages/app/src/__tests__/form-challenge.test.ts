// The parts of a form's admission that need no database: which client a request counts as, and how strictly a
// Turnstile answer is read. The Postgres half, through boot, is form-admission.test.ts.

import { describe, expect, test } from 'bun:test'
import { CHALLENGE_LIMITS, type ChallengeFetch, TURNSTILE_VERIFY_URL, turnstileVerifier } from '../implement/challenge'
import { clientKey } from '../implement/form-admission'
import { passingChallenge } from '../testing/challenge'

describe('the client a request counts as', () => {
	test.each<[string | null, string]>([
		['203.0.113.7', '203.0.113.7'],
		[' 203.0.113.7 ', '203.0.113.7'],
		['203.0.113.7, 198.51.100.1', '203.0.113.7'],
		['2001:DB8:1:2::1', '2001:db8:1:2::/64'],
		['2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:db8:1:2::/64'],
		['[2001:db8::1]', '2001:db8:0:0::/64'],
		['fe80::1%eth0', 'fe80:0:0:0::/64'],
		['::ffff:192.0.2.1', '192.0.2.1'],
		[null, 'unknown'],
		['', 'unknown'],
		['not-an-address', 'unknown'],
		['256.1.1.1', 'unknown'],
		['01.2.3.4', 'unknown'],
		['1::2::3', 'unknown'],
		['1:2:3:4:5:6:7:8:9', 'unknown'],
		['a'.repeat(65), 'unknown'],
	])('%p counts as %p', (header, key) => {
		expect(clientKey(header)).toBe(key)
	})
})

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
		expect(await verifier.verify(CHECK)).toBe('passed')
		const [request] = seen
		expect(request?.url).toBe(TURNSTILE_VERIFY_URL)
		expect(request?.method).toBe('POST')
		expect(Object.fromEntries(new URLSearchParams(await request?.text()))).toEqual({ secret: 'secret-1', response: CHECK.token })
	})

	test('a token that is no widget token is refused without asking the provider', async () => {
		const seen: Request[] = []
		const verifier = turnstileVerifier('secret-1', answering(() => passed(), seen), () => NOW)
		for (const token of ['', 'with space', 'x'.repeat(CHALLENGE_LIMITS.maxTokenLength + 1), 'line\nbreak']) {
			expect(await verifier.verify({ ...CHECK, token })).toBe('failed')
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
		expect(await turnstileVerifier('secret-1', answering(() => passed(overrides)), () => NOW).verify(CHECK)).toBe('failed')
	})

	test("the visitor's refusal fails; a refused secret is misconfigured; the provider's own error is unavailable", async () => {
		const refusing = (codes: string[]) =>
			turnstileVerifier('secret-1', answering(() => Response.json({ success: false, 'error-codes': codes })), () => NOW)
		expect(await refusing(['timeout-or-duplicate']).verify(CHECK)).toBe('failed')
		expect(await refusing(['invalid-input-response']).verify(CHECK)).toBe('failed')
		expect(await refusing(['invalid-input-secret']).verify(CHECK)).toBe('misconfigured')
		expect(await refusing(['missing-input-secret']).verify(CHECK)).toBe('misconfigured')
		expect(await refusing(['internal-error']).verify(CHECK)).toBe('unavailable')
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
		expect(await turnstileVerifier('secret-1', answering(answer), () => NOW).verify(CHECK)).toBe('unavailable')
	})

	test('a provider that does not answer within the deadline is unavailable, and the wait is bounded', async () => {
		const hanging: ChallengeFetch = (request) =>
			new Promise((_resolve, reject) => {
				request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
			})
		const started = Date.now()
		expect(await turnstileVerifier('secret-1', hanging, () => NOW).verify(CHECK)).toBe('unavailable')
		expect(Date.now() - started).toBeLessThan(CHALLENGE_LIMITS.timeoutMs + 1000)
	}, CHALLENGE_LIMITS.timeoutMs + 3000)
})

describe("the kits' passing challenge", () => {
	test('passes every widget token for the host and the form the check names, and no other', async () => {
		const verifier = turnstileVerifier('dev-secret', passingChallenge)
		expect(await verifier.verify(CHECK)).toBe('passed')
		expect(await verifier.verify({ ...CHECK, hostname: 'other.example', action: 'contact' })).toBe('passed')
		expect(await verifier.verify({ ...CHECK, token: 'with space' })).toBe('failed')
	})
})
