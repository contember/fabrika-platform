// The proxy secret (ADR-0022 rule 5): on Zerops a namespace is one private network, so the application refuses every
// request that does not carry the secret of its proxy, before any other check. Only the health endpoint, which the
// platform's probe dials directly and which answers a constant, is exempt.

import { boot, BootError } from '@fabrika/app/implement'
import { FABRIKA_PROXY_SECRET, PROXY_SECRET_HEADER } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { notesApp } from './fixtures/implement/app'
import { echoAssets, endpointHeaderFor, environment, frameworkEnvFor, grant, keySource, resultOf, send, token } from './fixtures/implement/harness'

const SECRET = 'a-proxy-secret-of-the-required-length-0123456789'

function problemsOf(start: () => unknown): readonly string[] {
	try {
		start()
	} catch (error) {
		if (error instanceof BootError) {
			return error.problems
		}
		throw error
	}
	throw new Error('expected the application not to boot')
}

describe('the proxy secret at boot', () => {
	const implementation = notesApp(new Map())

	test('an application that requires it does not start without it', () => {
		const problems = problemsOf(() =>
			boot(implementation, { environment: environment(frameworkEnvFor(implementation)), iam: keySource, assets: echoAssets, requireProxySecret: true })
		)
		expect(problems).toEqual([`${FABRIKA_PROXY_SECRET} is not set; the proxy authenticates itself to the application with it`])
	})

	test('a short secret does not start, and the message does not quote it', () => {
		const problems = problemsOf(() =>
			boot(implementation, {
				environment: environment({ ...frameworkEnvFor(implementation), [FABRIKA_PROXY_SECRET]: 'short-secret' }),
				iam: keySource,
				assets: echoAssets,
				requireProxySecret: true,
			})
		)
		expect(problems).toEqual([`${FABRIKA_PROXY_SECRET} is shorter than 32 characters`])
		expect(problems.join('\n')).not.toContain('short-secret')
	})
})

describe('a request without the proxy secret', () => {
	const implementation = notesApp(new Map())
	const app = boot(implementation, {
		environment: environment({ ...frameworkEnvFor(implementation), [FABRIKA_PROXY_SECRET]: SECRET }),
		iam: keySource,
		assets: echoAssets,
		requireProxySecret: true,
	})
	const meHeader = endpointHeaderFor(implementation, 'POST', '/api/me') ?? ''
	const proxied = (secret: string | null) => ({
		'Sec-Fetch-Site': 'same-origin',
		'Content-Type': 'application/json',
		'X-Fabrika-Endpoint': meHeader,
		...(secret === null ? {} : { [PROXY_SECRET_HEADER]: secret }),
	})
	const REFUSED = { error: { type: 'forbidden', message: 'This application answers only its proxy' } }

	test('is served when it carries the secret', async () => {
		const sent = await send(app, '/api/me', { token: await token('user', [grant('notes.read')]), body: {}, headers: proxied(SECRET) })
		expect(resultOf(sent)).toEqual({ id: 'user-1', label: 'user@notes.test' })
	})

	test.each<[string, string | null]>([
		['no secret: a sibling service dialled the application directly', null],
		['an empty secret: the proxy has no variable for this application', ''],
		['another secret', `${SECRET}x`],
	])('%s is refused before the token, the endpoint and the input are read', async (_name, secret) => {
		const sent = await send(app, '/api/me', { token: await token('user', [grant('notes.read')]), body: {}, headers: proxied(secret) })
		expect(sent.status).toBe(403)
		expect(sent.body).toEqual(REFUSED)
	})

	test('learns nothing about the paths: an unknown path and a non-canonical one get the same refusal', async () => {
		for (const path of ['/api/unknown', '/api//me']) {
			const sent = await send(app, path, { body: {}, headers: proxied(null) })
			expect(sent.status).toBe(403)
			expect(sent.body).toEqual(REFUSED)
		}
	})

	test('still reaches the health endpoint, which the platform probe dials directly', async () => {
		expect((await send(app, '/healthz')).status).toBe(200)
	})

	test('is refused on every response with the header policy', async () => {
		const sent = await send(app, '/api/me', { body: {}, headers: proxied(null) })
		expect(sent.headers.get('X-Content-Type-Options')).toBe('nosniff')
	})
})

describe('without a proxy secret', () => {
	test('an application that does not require one serves the service binding', async () => {
		const implementation = notesApp(new Map())
		const app = boot(implementation, { environment: environment(frameworkEnvFor(implementation)), iam: keySource, assets: echoAssets })
		const meHeader = endpointHeaderFor(implementation, 'POST', '/api/me') ?? ''
		const sent = await send(app, '/api/me', {
			token: await token('user', [grant('notes.read')]),
			body: {},
			headers: { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-Fabrika-Endpoint': meHeader },
		})
		expect(resultOf(sent)).toEqual({ id: 'user-1', label: 'user@notes.test' })
	})
})
