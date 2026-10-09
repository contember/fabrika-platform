// The generated chain run by a real Caddy, because the order of Caddy's header operations is a property of its code,
// not of the JSON: a named delete runs after a set in one HeaderOps, and reverse_proxy deletes what `Connection`
// names. Skips without a binary; `FABRIKA_TEST_CADDY_BIN` names one, for example the one in the pinned image:
//   id=$(docker create caddy:2.10.2-alpine) && docker cp "$id":/usr/bin/caddy ./caddy && docker rm "$id"

import { proxySecretVariable } from '@fabrika/auth-core'
import { FILE_TREATMENT, headerPolicy, NO_CSP_ORIGINS } from '@fabrika/proxy-core/headers'
import type { ContractProxyApp, InstallationProxyApp } from '@fabrika/proxy-core/manifest'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { endpointRow, installationRow } from '../../../proxy-core/src/__tests__/helpers'
import { buildCaddyConfig } from '../caddy'

const CADDY = process.env['FABRIKA_TEST_CADDY_BIN'] ?? ''
if (CADDY === '') {
	console.warn('caddy.live.test.ts skipped: set FABRIKA_TEST_CADDY_BIN to a caddy 2.10.2 binary to run it')
}

const SECRET = 'live-proxy-secret-0123456789abcdef0123456789'
const ENDPOINT = `api.me@sha256:${'a'.repeat(64)}`
const DOWNLOAD = endpointRow({
	id: 'files.avatar.download',
	kind: 'download',
	method: 'GET',
	path: '/api/files.avatar/:fileId',
	callers: ['human'],
	requirement: { kind: 'member' },
	admission: null,
})
const DOWNLOAD_ENDPOINT = `${DOWNLOAD.id}@${DOWNLOAD.digest}`

/** Headers that would send reports to an origin the policy never approved; the app sends them, the proxy drops them. */
const REPORTING: [string, string][] = [
	['Content-Security-Policy-Report-Only', "default-src 'none'; report-uri https://collector.example/csp"],
	['Report-To', '{"group":"x","max_age":60,"endpoints":[{"url":"https://collector.example/r"}]}'],
	['Reporting-Endpoints', 'x="https://collector.example/r"'],
	['NEL', '{"report_to":"x","max_age":60}'],
]
const EARLY_HINTS =
	'HTTP/1.1 103 Early Hints\r\nLink: <https://cdn.example/x.js>; rel=preload; as=script\r\nContent-Security-Policy: default-src *\r\n\r\n'

/**
 * What the application answers per path, as raw fields so a field can repeat: a weaker policy than the proxy's,
 * reporting headers, an early hint, and downloads of every disposition.
 */
const APP_ANSWERS: Record<string, { readonly fields: [string, string][]; readonly informational?: string }> = {
	'/api/me': {
		fields: [
			['Content-Security-Policy', "default-src * 'unsafe-inline' 'unsafe-eval'"],
			['Cache-Control', 'public, max-age=3600'],
			['Permissions-Policy', 'camera=*'],
			['X-App', 'kept'],
			...REPORTING,
		],
	},
	'/api/early': { fields: [['Content-Type', 'text/html']], informational: EARLY_HINTS },
	'/api/files.avatar/page': { fields: [['Content-Type', 'text/html'], ['Content-Disposition', "inline; filename*=UTF-8''page.html"], ...REPORTING] },
	'/api/files.avatar/drawing': { fields: [['Content-Type', 'image/svg+xml'], ['Content-Disposition', 'inline']] },
	'/api/files.avatar/photo': { fields: [['Content-Type', 'image/png'], ['Content-Disposition', "attachment; filename*=UTF-8''photo.png"]] },
	'/api/files.avatar/blob': { fields: [['Content-Type', 'application/octet-stream'], ['Cache-Control', 'public, max-age=3600']] },
	'/api/files.avatar/mixed': { fields: [['Content-Type', 'image/png'], ['Content-Type', 'text/html'], ['Content-Disposition', 'inline']] },
	'/api/files.avatar/early': { fields: [['Content-Type', 'image/png']], informational: EARLY_HINTS },
}

function rawAnswer(path: string): string {
	const answer = APP_ANSWERS[path] ?? { fields: [] }
	const fields = [...answer.fields, ['Content-Length', '2'], ['Connection', 'close']].map(([name, value]) => `${name}: ${value}\r\n`)
	return `${answer.informational ?? ''}HTTP/1.1 200 OK\r\n${fields.join('')}\r\nok`
}

function headerBlock(block: string): { status: number; headers: Headers } {
	const [statusLine = '', ...lines] = block.split('\r\n')
	const headers = new Headers()
	for (const line of lines) {
		const separator = line.indexOf(':')
		headers.append(line.slice(0, separator), line.slice(separator + 1).trim())
	}
	return { status: Number(statusLine.split(' ')[1]), headers }
}

function freePort(): number {
	const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
	const port = listener.port
	listener.stop(true)
	return port
}

/** One HTTP/1.1 request on a raw socket, so no client library rewrites `Connection`. */
async function rawRequest(
	port: number,
	headers: Record<string, string>,
	path = '/api/me',
	host = '127.0.0.1',
): Promise<{ status: number; headers: Headers; informational: { status: number; headers: Headers }[]; contentTypes: string[] }> {
	const lines = [`GET ${path} HTTP/1.1`, `Host: ${host}`, ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`), '', '']
	let response = ''
	await new Promise<void>((resolve, reject) => {
		Bun.connect({
			hostname: '127.0.0.1',
			port,
			socket: {
				open(socket) {
					socket.write(lines.join('\r\n'))
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
	const informational: { status: number; headers: Headers }[] = []
	for (const block of response.split('\r\n\r\n')) {
		const answer = headerBlock(block)
		if (answer.status >= 200) {
			// `Headers` joins a repeated field, so the raw lines say how many `Content-Type` fields arrived.
			const contentTypes = block.split('\r\n').filter((line) => line.toLowerCase().startsWith('content-type:'))
			return { ...answer, informational, contentTypes }
		}
		informational.push(answer)
	}
	throw new Error('no final answer')
}

describe.skipIf(CADDY === '')('the generated chain in a running Caddy', () => {
	const seenByAuth: Headers[] = []
	const seenByApp: Headers[] = []
	const auth = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request) {
			seenByAuth.push(request.headers)
			const download = request.headers.get('X-Forwarded-Uri')?.startsWith('/api/files.avatar/') === true
			return new Response(null, {
				status: 200,
				headers: { 'X-Fabrika-Token': 'proxy-token', 'X-Request-Id': 'proxy-request', 'X-Fabrika-Endpoint': download ? DOWNLOAD_ENDPOINT : ENDPOINT },
			})
		},
	})
	// A raw socket, because an HTTP library would neither send a 1xx nor repeat a field.
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
				const [requestLine = '', ...lines] = (socket.data.received.split('\r\n\r\n')[0] ?? '').split('\r\n')
				seenByApp.push(headerBlock(['HTTP/1.1 0', ...lines].join('\r\n')).headers)
				socket.end(rawAnswer(requestLine.split(' ')[1] ?? '/'))
			},
		},
	})
	const port = freePort()
	const contract: ContractProxyApp = {
		id: 'notes@prod',
		hosts: ['127.0.0.1'],
		upstream: `127.0.0.1:${app.port}`,
		scheme: 'https',
		endpoints: [DOWNLOAD],
		reservedPrefixes: [],
		snapshot: `sha256:${'0'.repeat(64)}`,
		csp: { ...NO_CSP_ORIGINS, connectSrc: ['https://api.maps.example'] },
		operationsOrigin: 'https://operations.example.com',
	}
	const dir = mkdtempSync(join(tmpdir(), 'fabrika-caddy-'))
	let caddy: ReturnType<typeof Bun.spawn> | undefined

	beforeAll(async () => {
		const config = buildCaddyConfig({ apps: [contract] }, {
			authUpstream: `127.0.0.1:${auth.port}`,
			listen: [`127.0.0.1:${port}`],
			healthListen: [`127.0.0.1:${freePort()}`],
		})
		writeFileSync(join(dir, 'caddy.json'), JSON.stringify(config))
		caddy = Bun.spawn([CADDY, 'run', '--config', join(dir, 'caddy.json')], {
			env: { ...process.env, HOME: dir, XDG_DATA_HOME: dir, XDG_CONFIG_HOME: dir, [proxySecretVariable('notes@prod')]: SECRET },
			stdout: 'ignore',
			stderr: 'pipe',
		})
		for (let attempt = 0; attempt < 100; attempt++) {
			try {
				await rawRequest(port, { Connection: 'close' })
				break
			} catch {
				await Bun.sleep(50)
			}
		}
		seenByAuth.length = 0
		seenByApp.length = 0
	}, 15_000)

	afterAll(() => {
		caddy?.kill()
		void auth.stop(true)
		app.stop(true)
		rmSync(dir, { recursive: true, force: true })
	})

	test('a client cannot assert a hop header; the proxy sets the client address, the decision and the secret', async () => {
		const { status } = await rawRequest(port, {
			Connection: 'close',
			'X-Fabrika-Token': 'forged',
			'X-Fabrika-Client-Ip': '203.0.113.9',
			'X-Fabrika-Endpoint': 'forged@sha256:0',
			'X-Fabrika-Delegation': 'forged',
			'X-Fabrika-Proxy-Secret': 'forged',
			'X-Request-Id': 'forged',
			'X-Forwarded-For': '203.0.113.9',
		})
		expect(status).toBe(200)
		const [atAuth] = seenByAuth.splice(0)
		const [atApp] = seenByApp.splice(0)
		expect(atAuth?.get('X-Fabrika-Client-Ip')).toBe('127.0.0.1')
		expect(atAuth?.get('X-Fabrika-Endpoint')).toBeNull()
		expect(atAuth?.get('X-Fabrika-Proxy-Secret')).toBeNull()
		expect(atApp?.get('X-Fabrika-Client-Ip')).toBe('127.0.0.1')
		expect(atApp?.get('X-Fabrika-Token')).toBe('proxy-token')
		expect(atApp?.get('X-Fabrika-Endpoint')).toBe(ENDPOINT)
		expect(atApp?.get('X-Fabrika-Delegation')).toBeNull()
		expect(atApp?.get('X-Request-Id')).toBe('proxy-request')
		expect(atApp?.get('X-Fabrika-Proxy-Secret')).toBe(SECRET)
	})

	test('a Connection header naming an asserted header is a 400 that reaches neither service', async () => {
		for (const nominated of ['X-Fabrika-Client-Ip', 'x-fabrika-token', 'X-Fabrika-Endpoint', 'X-Fabrika-Proxy-Secret', 'X-Request-Id']) {
			expect((await rawRequest(port, { Connection: `close, ${nominated}` })).status).toBe(400)
		}
		expect(seenByAuth).toHaveLength(0)
		expect(seenByApp).toHaveLength(0)
	})

	test('an ordinary Connection header still passes', async () => {
		expect((await rawRequest(port, { Connection: 'close' })).status).toBe(200)
		expect(seenByApp.splice(0)[0]?.get('X-Fabrika-Client-Ip')).toBe('127.0.0.1')
	})

	test('an app that sends a weaker policy still answers the proxy policy, once per header', async () => {
		const answer = await rawRequest(port, { Connection: 'close' })
		expect(answer.status).toBe(200)
		for (const [name, value] of headerPolicy(contract.csp, 'https://operations.example.com')) {
			expect(answer.headers.get(name)).toBe(value)
		}
		expect(answer.headers.get('Content-Security-Policy')).toContain("connect-src 'self' https://operations.example.com https://api.maps.example;")
		// A header outside the policy is the application's.
		expect(answer.headers.get('X-App')).toBe('kept')
	})

	test('a Connection refusal carries the policy as well', async () => {
		const answer = await rawRequest(port, { Connection: 'close, X-Fabrika-Token' })
		expect(answer.status).toBe(400)
		expect(answer.headers.get('Permissions-Policy')).toContain('camera=()')
	})

	test('a download endpoint gets the file treatment from the proxy, whatever disposition the app chose', async () => {
		const cases: [path: string, disposition: string][] = [
			['/api/files.avatar/page', "attachment; filename*=UTF-8''page.html"],
			['/api/files.avatar/drawing', 'attachment'],
			['/api/files.avatar/photo', "inline; filename*=UTF-8''photo.png"],
			['/api/files.avatar/blob', 'attachment'],
		]
		seenByApp.length = 0
		for (const [path, disposition] of cases) {
			const answer = await rawRequest(port, { Connection: 'close' }, path)
			expect(answer.status).toBe(200)
			expect(answer.headers.get('Content-Disposition')).toBe(disposition)
			for (const [name, value] of FILE_TREATMENT) {
				expect(answer.headers.get(name)).toBe(value)
			}
			expect(answer.headers.get('Permissions-Policy')).toBeNull()
		}
		expect(seenByApp.splice(0).map((headers) => headers.get('X-Fabrika-Proxy-Secret'))).toEqual([SECRET, SECRET, SECRET, SECRET])
	})

	test('the reporting headers an application sends never reach the client, on an answer or a download', async () => {
		for (const path of ['/api/me', '/api/files.avatar/page']) {
			const answer = await rawRequest(port, { Connection: 'close' }, path)
			expect(answer.status).toBe(200)
			for (const [name] of REPORTING) {
				expect(answer.headers.get(name)).toBeNull()
			}
		}
	})

	test('two Content-Type fields, one of them an inert image, are one ambiguous value and an attachment', async () => {
		const answer = await rawRequest(port, { Connection: 'close' }, '/api/files.avatar/mixed')
		expect(answer.status).toBe(200)
		expect(answer.contentTypes).toEqual(['Content-Type: image/png,text/html'])
		expect(answer.headers.get('Content-Disposition')).toBe('attachment')
		expect(answer.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'")
	})

	test("an application's 103 Early Hints leaves with no header, so neither its preload nor its policy arrives", async () => {
		for (const path of ['/api/early', '/api/files.avatar/early']) {
			const answer = await rawRequest(port, { Connection: 'close' }, path)
			expect(answer.informational.map((hint) => [hint.status, [...hint.headers.keys()]])).toEqual([[103, []]])
			expect(answer.status).toBe(200)
			expect(answer.headers.get('Link')).toBeNull()
		}
		const page = await rawRequest(port, { Connection: 'close' }, '/api/early')
		expect(page.headers.get('Content-Security-Policy')).toBe(headerPolicy(contract.csp, 'https://operations.example.com')[0]?.[1] ?? '')
	})
})

describe.skipIf(CADDY === '')('an installation entry beside an application in a running Caddy', () => {
	const PROTOCOL = installationRow({
		id: 'admin',
		kind: 'protocol',
		method: '*',
		path: '/admin/*',
		callers: [],
		requirement: null,
		admission: null,
		oauth: null,
	})
	const PROTOCOL_ENDPOINT = `${PROTOCOL.id}@${PROTOCOL.digest}`
	const SERVICE_CSP = "default-src 'self'; form-action https://return.example"
	const seenByApp: { host: string | null; headers: Headers }[] = []
	// Both decisions are anonymous allows: an endpoint, no token.
	const auth = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request) {
			const installation = request.headers.get('X-Forwarded-Host')?.startsWith('iam.') === true
			return new Response(null, {
				status: 200,
				headers: { 'X-Request-Id': 'proxy-request', 'X-Fabrika-Endpoint': installation ? PROTOCOL_ENDPOINT : ENDPOINT },
			})
		},
	})
	const upstream = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request) {
			seenByApp.push({ host: request.headers.get('Host'), headers: request.headers })
			return new Response('ok', { headers: { 'Content-Security-Policy': SERVICE_CSP, 'Connection': 'close' } })
		},
	})
	const port = freePort()
	const entry: InstallationProxyApp = {
		id: 'propustka',
		hosts: ['iam.example.com'],
		upstream: `127.0.0.1:${upstream.port}`,
		scheme: 'https',
		installation: true,
		endpoints: [PROTOCOL],
		reservedPrefixes: [],
	}
	const application: ContractProxyApp = {
		id: 'notes@prod',
		hosts: ['notes.example.com'],
		upstream: `127.0.0.1:${upstream.port}`,
		scheme: 'https',
		endpoints: [],
		reservedPrefixes: [],
		snapshot: `sha256:${'0'.repeat(64)}`,
		csp: NO_CSP_ORIGINS,
	}
	const dir = mkdtempSync(join(tmpdir(), 'fabrika-caddy-'))
	let caddy: ReturnType<typeof Bun.spawn> | undefined

	beforeAll(async () => {
		const config = buildCaddyConfig({ apps: [entry, application] }, {
			authUpstream: `127.0.0.1:${auth.port}`,
			listen: [`127.0.0.1:${port}`],
			healthListen: [`127.0.0.1:${freePort()}`],
		})
		writeFileSync(join(dir, 'caddy.json'), JSON.stringify(config))
		caddy = Bun.spawn([CADDY, 'run', '--config', join(dir, 'caddy.json')], {
			env: { ...process.env, HOME: dir, XDG_DATA_HOME: dir, XDG_CONFIG_HOME: dir, [proxySecretVariable('notes@prod')]: SECRET },
			stdout: 'ignore',
			stderr: 'pipe',
		})
		for (let attempt = 0; attempt < 100; attempt++) {
			try {
				await rawRequest(port, { Connection: 'close' }, '/admin/x', 'iam.example.com')
				break
			} catch {
				await Bun.sleep(50)
			}
		}
		seenByApp.length = 0
	}, 15_000)

	afterAll(() => {
		caddy?.kill()
		void auth.stop(true)
		void upstream.stop(true)
		rmSync(dir, { recursive: true, force: true })
	})

	test('a protocol row reaches the service with its Authorization, the endpoint and no proxy secret', async () => {
		const answer = await rawRequest(port, { Connection: 'close', Authorization: 'Bearer px_provisioning' }, '/admin/apps', 'iam.example.com')
		expect(answer.status).toBe(200)
		const [seen] = seenByApp.splice(0)
		expect(seen?.headers.get('Authorization')).toBe('Bearer px_provisioning')
		expect(seen?.headers.get('X-Fabrika-Endpoint')).toBe(PROTOCOL_ENDPOINT)
		expect(seen?.headers.get('X-Fabrika-Token')).toBeNull()
		expect(seen?.headers.get('X-Fabrika-Proxy-Secret')).toBeNull()
	})

	test("the service's own policy passes through untouched", async () => {
		const answer = await rawRequest(port, { Connection: 'close' }, '/admin/apps', 'iam.example.com')
		seenByApp.splice(0)
		expect(answer.headers.get('Content-Security-Policy')).toBe(SERVICE_CSP)
	})

	test("an application's anonymous endpoint loses the Authorization the proxy did not read, and gets the secret", async () => {
		const answer = await rawRequest(port, { Connection: 'close', Authorization: 'Bearer px_key' }, '/healthz', 'notes.example.com')
		expect(answer.status).toBe(200)
		const [seen] = seenByApp.splice(0)
		expect(seen?.headers.get('Authorization')).toBeNull()
		expect(seen?.headers.get('X-Fabrika-Proxy-Secret')).toBe(SECRET)
		expect(answer.headers.get('Content-Security-Policy')).not.toBe(SERVICE_CSP)
	})
})
