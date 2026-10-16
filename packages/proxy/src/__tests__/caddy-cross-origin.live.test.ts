// The cross-origin chain (ADR-0022 "Cross-origin endpoints") in a real Caddy, in front of the real decision: Caddy
// answers an admitted preflight from the auth service's 2xx without dialling the app, and writes on the app's answer
// only the origin the decision admitted. Skips without a binary, like `caddy.live.test.ts`.

import { createVerifyService, MemoryTokenCache } from '@fabrika/proxy-core'
import { parseProxyManifest } from '@fabrika/proxy-core/manifest'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { anonymousRow, contractAppWith, endpointRow, FakeIam, ISSUER, signToken } from '../../../proxy-core/src/__tests__/helpers'
import { buildCaddyConfig } from '../caddy'

const CADDY = process.env['FABRIKA_TEST_CADDY_BIN'] ?? ''
if (CADDY === '') {
	console.warn('caddy-cross-origin.live.test.ts skipped: set FABRIKA_TEST_CADDY_BIN to a caddy 2.10.2 binary to run it')
}

const PARTNER = 'https://partner.example'
const STRANGER = 'https://stranger.example'
const rules = (id: string, path: string, crossOrigin?: 'environment') =>
	endpointRow({
		id,
		kind: 'query',
		method: 'POST',
		path,
		callers: ['machine'],
		requirement: { kind: 'member' },
		admission: { contentTypes: ['application/json'], maxBytes: 65_536 },
		...(crossOrigin === undefined ? {} : { crossOrigin }),
	})
const OPEN = rules('api.me', '/api/me', 'environment')
const CLOSED = rules('api.notes.list', '/api/notes.list')
const SIGNUP = anonymousRow({
	id: 'signup',
	kind: 'form',
	method: 'POST',
	path: '/signup',
	admission: { contentTypes: ['application/json'], maxBytes: 4096 },
	crossOrigin: 'any',
})

/** What the application answers to every request: its own attempt at CORS, which the proxy must never pass on. */
const APP_ANSWER = [
	'HTTP/1.1 200 OK',
	'Access-Control-Allow-Origin: *',
	'Access-Control-Allow-Credentials: true',
	'Access-Control-Expose-Headers: X-Secret',
	'Vary: Accept-Encoding',
	'Content-Length: 2',
	'Connection: close',
	'',
	'ok',
].join('\r\n')

function freePort(): number {
	const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
	const port = listener.port
	listener.stop(true)
	return port
}

/** One HTTP/1.1 request on a raw socket; `Vary` is read as the raw fields, since `Headers` joins them. */
async function rawRequest(
	port: number,
	method: string,
	path: string,
	headers: Record<string, string>,
	body = '',
): Promise<{ status: number; headers: Headers; vary: string[] }> {
	const fields = { Host: 'notes.example', Connection: 'close', ...headers, ...(body === '' ? {} : { 'Content-Length': String(body.length) }) }
	const request = [`${method} ${path} HTTP/1.1`, ...Object.entries(fields).map(([name, value]) => `${name}: ${value}`), '', body].join('\r\n')
	let response = ''
	await new Promise<void>((resolve, reject) => {
		Bun.connect({
			hostname: '127.0.0.1',
			port,
			socket: {
				open(socket) {
					socket.write(request)
				},
				data(_socket, chunk) {
					response += new TextDecoder().decode(chunk)
				},
				close() {
					resolve()
				},
				error(_socket, error) {
					reject(error)
				},
			},
		}).catch(reject)
	})
	const [statusLine = '', ...lines] = (response.split('\r\n\r\n')[0] ?? '').split('\r\n')
	const parsed = new Headers()
	const vary: string[] = []
	for (const line of lines) {
		const separator = line.indexOf(':')
		const name = line.slice(0, separator)
		const value = line.slice(separator + 1).trim()
		parsed.append(name, value)
		if (name.toLowerCase() === 'vary') vary.push(value)
	}
	return { status: Number(statusLine.split(' ')[1]), headers: parsed, vary }
}

describe.skipIf(CADDY === '')('the cross-origin chain in a running Caddy', () => {
	let appRequests = 0
	const manifest = parseProxyManifest({
		apps: [contractAppWith([OPEN, CLOSED, SIGNUP], ['/api'], { hosts: ['notes.example'], crossOrigins: [PARTNER] })],
	})
	if (manifest === null) throw new Error('the manifest does not parse')
	const app = Bun.listen<{ received: string }>({
		hostname: '127.0.0.1',
		port: 0,
		socket: {
			open(socket) {
				socket.data = { received: '' }
			},
			data(socket, chunk) {
				socket.data.received += new TextDecoder().decode(chunk)
				if (!socket.data.received.includes('\r\n\r\n')) return
				appRequests++
				socket.end(APP_ANSWER)
			},
		},
	})
	let auth: ReturnType<typeof Bun.serve> | undefined
	const port = freePort()
	const dir = mkdtempSync(join(tmpdir(), 'fabrika-caddy-cors-'))
	let caddy: ReturnType<typeof Bun.spawn> | undefined

	beforeAll(async () => {
		const token = await signToken({ type: 'service', permissions: [{ action: 'notes.read', scope: null, source: 'grant' }] })
		const iam = new FakeIam({ mintFromKey: { ok: true, token, expiresAt: Math.floor(Date.now() / 1000) + 300 } })
		const verify = createVerifyService({
			manifest: { apps: manifest.apps.map((entry) => ({ ...entry, upstream: `127.0.0.1:${app.port}` })) },
			iam,
			issuer: ISSUER,
			cache: new MemoryTokenCache(),
		})
		auth = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: verify })
		const config = buildCaddyConfig({ apps: manifest.apps.map((entry) => ({ ...entry, upstream: `127.0.0.1:${app.port}` })) }, {
			authUpstream: `127.0.0.1:${auth.port}`,
			listen: [`127.0.0.1:${port}`],
			healthListen: [`127.0.0.1:${freePort()}`],
		})
		writeFileSync(join(dir, 'caddy.json'), JSON.stringify(config))
		caddy = Bun.spawn([CADDY, 'run', '--config', join(dir, 'caddy.json')], {
			env: { ...process.env, HOME: dir, XDG_DATA_HOME: dir, XDG_CONFIG_HOME: dir },
			stdout: 'ignore',
			stderr: 'ignore',
		})
		for (let attempt = 0; attempt < 100; attempt++) {
			try {
				await rawRequest(port, 'GET', '/healthz', {})
				break
			} catch {
				await Bun.sleep(50)
			}
		}
		appRequests = 0
	}, 15_000)

	afterAll(() => {
		caddy?.kill()
		void auth?.stop(true)
		app.stop(true)
		rmSync(dir, { recursive: true, force: true })
	})

	const preflight = (origin: string) => ({
		Origin: origin,
		'Access-Control-Request-Method': 'POST',
		'Access-Control-Request-Headers': 'authorization,content-type',
	})

	test('an admitted preflight is answered by Caddy from the decision, and never reaches the app', async () => {
		const answer = await rawRequest(port, 'OPTIONS', '/api/me', preflight(PARTNER))
		expect(answer.status).toBe(204)
		expect(answer.headers.get('Access-Control-Allow-Origin')).toBe(PARTNER)
		expect(answer.headers.get('Access-Control-Allow-Methods')).toBe('POST')
		expect(answer.headers.get('Access-Control-Allow-Headers')).toBe('Authorization, Content-Type')
		expect(answer.headers.get('Access-Control-Max-Age')).toBe('600')
		expect(answer.vary).toEqual(['Origin'])
		expect(answer.headers.get('Content-Security-Policy')).toContain("default-src 'self'")
		expect(answer.headers.get('X-Fabrika-Preflight')).toBeNull()
		expect(appRequests).toBe(0)
	})

	test('a refused preflight is the decision 403, with no origin, and never reaches the app', async () => {
		for (const [path, origin] of [['/api/me', STRANGER], ['/api/notes.list', PARTNER]] satisfies [string, string][]) {
			const answer = await rawRequest(port, 'OPTIONS', path, preflight(origin))
			expect(answer.status).toBe(403)
			expect(answer.headers.get('Access-Control-Allow-Origin')).toBeNull()
		}
		expect(appRequests).toBe(0)
	})

	test("the app's answer carries only the origin the decision admitted, never the app's own CORS", async () => {
		const answer = await rawRequest(port, 'POST', '/api/me', {
			Origin: PARTNER,
			Authorization: 'Bearer px_machine',
			'Content-Type': 'application/json',
		}, '{}')
		expect(answer.status).toBe(200)
		expect(appRequests).toBe(1)
		expect(answer.headers.get('Access-Control-Allow-Origin')).toBe(PARTNER)
		expect(answer.headers.get('Access-Control-Allow-Credentials')).toBeNull()
		expect(answer.headers.get('Access-Control-Expose-Headers')).toBeNull()
		expect(answer.vary).toEqual(['Accept-Encoding', 'Origin'])
	})

	test("an endpoint the contract keeps closed loses the app's CORS and gains none", async () => {
		const answer = await rawRequest(port, 'POST', '/api/notes.list', {
			Origin: PARTNER,
			Authorization: 'Bearer px_machine',
			'Content-Type': 'application/json',
		}, '{}')
		expect(answer.status).toBe(200)
		expect(answer.headers.get('Access-Control-Allow-Origin')).toBeNull()
		expect(answer.headers.get('Access-Control-Allow-Credentials')).toBeNull()
		expect(answer.vary).toEqual(['Accept-Encoding'])
	})

	test('a form open to any origin answers `*` to a stranger, without Vary: Origin', async () => {
		const preflighted = await rawRequest(port, 'OPTIONS', '/signup', preflight(STRANGER))
		expect(preflighted.status).toBe(204)
		expect(preflighted.headers.get('Access-Control-Allow-Origin')).toBe('*')
		const answer = await rawRequest(port, 'POST', '/signup', { Origin: STRANGER, 'Content-Type': 'application/json' }, '{}')
		expect(answer.status).toBe(200)
		expect(answer.headers.get('Access-Control-Allow-Origin')).toBe('*')
		expect(answer.vary).toEqual(['Accept-Encoding'])
	})
})
