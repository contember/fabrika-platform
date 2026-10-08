// The generated chain run by a real Caddy, because the order of Caddy's header operations is a property of its code,
// not of the JSON: a named delete runs after a set in one HeaderOps, and reverse_proxy deletes what `Connection`
// names. Skips without a binary; `FABRIKA_TEST_CADDY_BIN` names one, for example the one in the pinned image:
//   id=$(docker create caddy:2.10.2-alpine) && docker cp "$id":/usr/bin/caddy ./caddy && docker rm "$id"

import { proxySecretVariable } from '@fabrika/auth-core'
import type { ContractProxyApp } from '@fabrika/proxy-core/manifest'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCaddyConfig } from '../caddy'

const CADDY = process.env['FABRIKA_TEST_CADDY_BIN'] ?? ''
if (CADDY === '') {
	console.warn('caddy.live.test.ts skipped: set FABRIKA_TEST_CADDY_BIN to a caddy 2.10.2 binary to run it')
}

const SECRET = 'live-proxy-secret-0123456789abcdef0123456789'
const ENDPOINT = `api.me@sha256:${'a'.repeat(64)}`

function freePort(): number {
	const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
	const port = listener.port
	listener.stop(true)
	return port
}

/** One HTTP/1.1 request on a raw socket, so no client library rewrites `Connection`. */
async function rawRequest(port: number, headers: Record<string, string>): Promise<number> {
	const lines = ['GET /api/me HTTP/1.1', 'Host: 127.0.0.1', ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`), '', '']
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
	return Number(response.split(' ')[1])
}

describe.skipIf(CADDY === '')('the generated chain in a running Caddy', () => {
	const seenByAuth: Headers[] = []
	const seenByApp: Headers[] = []
	const auth = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request) {
			seenByAuth.push(request.headers)
			return new Response(null, {
				status: 200,
				headers: { 'X-Fabrika-Token': 'proxy-token', 'X-Request-Id': 'proxy-request', 'X-Fabrika-Endpoint': ENDPOINT },
			})
		},
	})
	const app = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request) {
			seenByApp.push(request.headers)
			return new Response('ok')
		},
	})
	const port = freePort()
	const contract: ContractProxyApp = {
		id: 'notes@prod',
		hosts: ['127.0.0.1'],
		upstream: `127.0.0.1:${app.port}`,
		scheme: 'https',
		endpoints: [],
		reservedPrefixes: [],
		snapshot: `sha256:${'0'.repeat(64)}`,
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
		void app.stop(true)
		rmSync(dir, { recursive: true, force: true })
	})

	test('a client cannot assert a hop header; the proxy sets the client address, the decision and the secret', async () => {
		const status = await rawRequest(port, {
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
			expect(await rawRequest(port, { Connection: `close, ${nominated}` })).toBe(400)
		}
		expect(seenByAuth).toHaveLength(0)
		expect(seenByApp).toHaveLength(0)
	})

	test('an ordinary Connection header still passes', async () => {
		expect(await rawRequest(port, { Connection: 'close' })).toBe(200)
		expect(seenByApp.splice(0)[0]?.get('X-Fabrika-Client-Ip')).toBe('127.0.0.1')
	})
})
