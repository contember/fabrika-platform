import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUILDER_DAEMON_HOST, builderDaemonUrl } from '../../shared/urls'
import { admitRequest } from '../src/admission'
import { type RunningDaemon, startDaemon } from '../src/index'

let daemon: RunningDaemon
let directory: string
let authority: string
let origin: string

beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), 'builder-admission-'))
	daemon = startDaemon({ port: 0, sessionsDir: join(directory, 'sessions') })
	origin = builderDaemonUrl(daemon.port)
	authority = new URL(origin).host
	daemon.sessionManager.upsert('protected', new Map([['view.jsx', '<div />']]), directory)
})

afterAll(() => {
	daemon.stop()
	rmSync(directory, { recursive: true, force: true })
})

function send(path: string, method: string, headers: Record<string, string> = {}): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = request({ hostname: BUILDER_DAEMON_HOST, port: daemon.port, path, method, headers: { Host: authority, ...headers } })
		req.on('response', (res) => {
			res.resume()
			resolve(res.statusCode ?? 0)
		})
		req.on('upgrade', (res, socket) => {
			socket.destroy()
			resolve(res.statusCode ?? 0)
		})
		req.on('error', reject)
		req.setTimeout(2000, () => req.destroy(new Error('Request timed out')))
		req.end()
	})
}

function deniedHeaders(): Record<string, string>[] {
	return [
		{ Host: `rebound.example:${daemon.port}` },
		{ Host: 'localhost:0' },
		{ Host: `localhost.evil.example:${daemon.port}` },
		{ Host: `localhost.:${daemon.port}` },
		{ Host: `127.0.0.1.evil.example:${daemon.port}` },
		{ Host: `127.1:${daemon.port}` },
		{ Host: `[::1]:${daemon.port}` },
		{ Origin: 'https://foreign.example' },
		{ Origin: 'null' },
		{ Origin: 'http://localhost:0' },
		{ Origin: `http://localhost:${daemon.port}` },
		{ Origin: `${origin}/` },
		{ Origin: origin, 'Sec-Fetch-Site': 'cross-site' },
		{ 'Sec-Fetch-Site': 'cross-site' },
		{ 'Sec-Fetch-Site': 'same-site' },
	]
}

function allowedHeaders(): Record<string, string>[] {
	return [{}, { Origin: origin, 'Sec-Fetch-Site': 'same-origin' }]
}

describe('daemon request admission on the bound dynamic port', () => {
	test('admits canonical HTTP default-port authorities without binding port 80', () => {
		for (const hostname of ['localhost', '127.0.0.1']) {
			for (const Host of [hostname, `${hostname}:80`]) {
				const url = new URL(`http://${hostname}:80/health`)
				const requests: Record<string, string>[] = [{ Host }, { Host, Origin: url.origin }]
				for (const headers of requests) {
					const req = new Request(url, { headers })
					expect(admitRequest(req, url, 80)).toBeNull()
					expect(admitRequest(req, url, 19410)?.status).toBe(403)
				}
			}
		}
		for (const Host of ['foreign.example', 'localhost.', 'localhost:81', '127.0.0.1']) {
			const url = new URL('http://localhost/health')
			expect(admitRequest(new Request(url, { headers: { Host } }), url, 80)?.status).toBe(403)
		}
		for (const Origin of ['http://127.0.0.1', 'http://localhost:81', 'null']) {
			const url = new URL('http://localhost/health')
			expect(admitRequest(new Request(url, { headers: { Host: 'localhost', Origin } }), url, 80)?.status).toBe(403)
		}
	})

	test('rejects HTTP writes before session deletion, including originless browser requests', async () => {
		for (const headers of [...deniedHeaders(), { 'Sec-Fetch-Site': 'none' }]) {
			expect(await send('/api/session/protected/reset', 'POST', headers)).toBe(403)
			expect(daemon.sessionManager.get('protected')).toBeDefined()
		}
	})

	test('rejects reads, OPTIONS, and both WebSocket handshakes before upgrade', async () => {
		for (const headers of deniedHeaders()) {
			expect(await send('/health', 'GET', headers)).toBe(403)
			expect(await send('/health', 'OPTIONS', headers)).toBe(403)
			for (const route of ['session', 'wait']) {
				expect(
					await send(`/ws/${route}/protected`, 'GET', {
						...headers,
						Connection: 'Upgrade',
						Upgrade: 'websocket',
						'Sec-WebSocket-Version': '13',
						'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
					}),
				).toBe(403)
			}
		}
		expect(daemon.sessionManager.get('protected')).toBeDefined()
	})

	test('rejects an absolute request target with a foreign authority despite a local Host', async () => {
		expect(await send(`http://foreign.example:${daemon.port}/health`, 'GET')).toBe(403)
	})

	test('allows originless CLI and exact same-origin HTTP writes', async () => {
		for (const headers of allowedHeaders()) {
			daemon.sessionManager.upsert('allowed', new Map([['view.jsx', '<div />']]), directory)
			expect(await send('/api/session/allowed/reset', 'POST', headers)).toBe(200)
			expect(daemon.sessionManager.get('allowed')).toBeUndefined()
		}
		expect(daemon.port).toBeGreaterThan(0)
		expect(await send('/health', 'GET', { 'Sec-Fetch-Site': 'none' })).toBe(200)
	})

	test('allows loopback alias only with its own exact origin', async () => {
		const Host = `localhost:${daemon.port}`
		expect(await send('/health', 'GET', { Host })).toBe(200)
		expect(await send('/health', 'GET', { Host, Origin: `http://${Host}` })).toBe(200)
		expect(await send('/health', 'GET', { Host, Origin: origin })).toBe(403)
	})

	test('allows CLI and same-origin browser upgrades on both WebSocket routes', async () => {
		for (const route of ['session', 'wait']) {
			for (const headers of allowedHeaders()) {
				expect(
					await send(`/ws/${route}/protected`, 'GET', {
						...headers,
						Connection: 'Upgrade',
						Upgrade: 'websocket',
						'Sec-WebSocket-Version': '13',
						'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
					}),
				).toBe(101)
			}
		}
	})

	test('OPTIONS grants no cross-origin access', async () => {
		for (const headers of allowedHeaders()) {
			const res = await fetch(`${origin}/health`, { method: 'OPTIONS', headers })
			expect(res.status).toBe(204)
			expect(res.headers.get('access-control-allow-origin')).toBeNull()
		}
	})
})
