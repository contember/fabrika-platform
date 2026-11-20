// The shared provider request never follows a redirect: a followed one would carry the credential headers and the
// message to wherever it points. Real Bun servers on two ports stand in for the provider and the redirect's target.

import { afterAll, describe, expect, test } from 'bun:test'
import { BrevoEmailSender } from '../brevo.js'
import { EmailDeliveryError, type EmailFetch, mayRetryDelivery } from '../email.js'
import { postToProvider } from '../http.js'
import { PLATFORM_MAIL_CAPABILITIES, PlatformEmailSender } from '../platform.js'
import { PostmarkEmailSender } from '../postmark.js'

const message = { to: 'ada@example.test', subject: 'Welcome', text: 'Private body', idempotencyKey: 'welcome/user-1' }
const from = { address: 'auth@example.test' }

interface Arrival {
	readonly method: string
	readonly headers: Readonly<Record<string, string>>
	readonly body: string
}

/** The redirect's target: it records what arrives and answers as an accepting provider would. */
const arrivals: Arrival[] = []
const target = Bun.serve({
	hostname: '127.0.0.1',
	port: 0,
	async fetch(request) {
		arrivals.push({ method: request.method, headers: Object.fromEntries(request.headers), body: await request.text() })
		return Response.json({ messageId: 'stolen', MessageID: 'stolen', status: 'accepted' })
	},
})
// `localhost` against `127.0.0.1`: the same machine, another origin.
const targetUrl = `http://localhost:${target.port}/collect`

/** The configured endpoint: it answers every request with `status` to the target. */
let redirectStatus = 307
const endpoint = Bun.serve({
	hostname: '127.0.0.1',
	port: 0,
	fetch: () => new Response('moved', { status: redirectStatus, headers: { Location: targetUrl } }),
})
const endpointOrigin = `http://127.0.0.1:${endpoint.port}`

afterAll(() => {
	endpoint.stop(true)
	target.stop(true)
})

async function caught(promise: Promise<unknown>): Promise<EmailDeliveryError> {
	const error = await promise.then(() => undefined, (reason: unknown) => reason)
	if (!(error instanceof EmailDeliveryError)) throw new Error(`Expected EmailDeliveryError, got ${String(error)}`)
	return error
}

/** The real fetch, aimed at the local endpoint instead of the provider's fixed URL. */
const toEndpoint: EmailFetch = (input, init) => {
	const url = new URL(input instanceof Request ? input.url : input.toString())
	return globalThis.fetch(`${endpointOrigin}${url.pathname}`, init)
}

const REDIRECTS = [301, 302, 303, 307, 308] as const

describe('postToProvider', () => {
	test.each(REDIRECTS)('does not follow a cross-origin %d and forwards nothing to its target', async (status) => {
		redirectStatus = status
		arrivals.length = 0
		const error = await caught(postToProvider({
			label: 'Test',
			fetch: (input, init) => globalThis.fetch(input, init),
			url: `${endpointOrigin}/send`,
			headers: { 'api-key': 'secret-key', Authorization: 'Bearer secret-token' },
			body: { text: 'Private body' },
			signal: new AbortController().signal,
			timeoutMs: 5_000,
		}))
		expect(arrivals).toEqual([])
		expect([error.code, error.httpStatus, error.retryable, error.outcome]).toEqual(['provider_rejected', status, false, 'not_sent'])
		expect(error.message).toBe(`Test answered with a redirect (HTTP ${status}), which is not followed`)
	})

	test('sends every request with redirect: manual', async () => {
		const modes: (RequestRedirect | undefined)[] = []
		await postToProvider({
			label: 'Test',
			fetch: (_input, init) => {
				modes.push(init?.redirect)
				return Promise.resolve(Response.json({}))
			},
			url: 'https://provider.example/send',
			headers: {},
			body: {},
			signal: new AbortController().signal,
			timeoutMs: 5_000,
		})
		expect(modes).toEqual(['manual'])
	})

	test("classifies a browser's opaque redirect as a redirect, without a status", async () => {
		const opaque = { type: 'opaqueredirect', status: 0, ok: false, body: null } as unknown as Response
		const error = await caught(postToProvider({
			label: 'Test',
			fetch: () => Promise.resolve(opaque),
			url: 'https://provider.example/send',
			headers: {},
			body: {},
			signal: new AbortController().signal,
			timeoutMs: 5_000,
		}))
		expect([error.code, error.httpStatus, error.message]).toEqual([
			'provider_rejected',
			undefined,
			'Test answered with a redirect, which is not followed',
		])
	})
})

describe('a provider adapter behind a redirect', () => {
	test('Brevo keeps its api-key and the message at the configured endpoint', async () => {
		redirectStatus = 307
		arrivals.length = 0
		const sender = new BrevoEmailSender({ apiKey: 'xkeysib-secret', from, fetch: toEndpoint })
		const error = await caught(sender.send(message, new AbortController().signal))
		expect(arrivals).toEqual([])
		expect([error.code, error.httpStatus]).toEqual(['provider_rejected', 307])
	})

	test('Postmark keeps its server token and the message at the configured endpoint', async () => {
		redirectStatus = 308
		arrivals.length = 0
		const sender = new PostmarkEmailSender({ serverToken: 'postmark-secret', from, fetch: toEndpoint })
		const error = await caught(sender.send(message, new AbortController().signal))
		expect(arrivals).toEqual([])
		expect([error.code, error.httpStatus]).toEqual(['provider_rejected', 308])
	})
})

describe('the platform relay behind a redirect', () => {
	test.each([307, 308])('a %d from the relay URL is refused for good, and the bearer key stays put', async (status) => {
		redirectStatus = status
		arrivals.length = 0
		const sender = new PlatformEmailSender({ url: endpointOrigin, key: 'px_relay_secret' })
		const error = await caught(sender.send(message, new AbortController().signal))
		expect(arrivals).toEqual([])
		expect([error.code, error.httpStatus]).toEqual(['provider_rejected', status])
		expect(error.message).toBe(`Platform mail answered with a redirect (HTTP ${status}), which is not followed`)
		// Not retried even over the idempotent relay: the same URL answers the same redirect.
		expect(mayRetryDelivery(error, PLATFORM_MAIL_CAPABILITIES)).toBe(false)
	})
})
