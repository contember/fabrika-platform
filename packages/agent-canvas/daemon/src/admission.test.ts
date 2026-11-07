import { describe, expect, test } from 'bun:test'
import { admitRequest, CLI_TOKEN_HEADER, CLI_TOKEN_QUERY } from './admission'

const PORT = 19400
const TOKEN = 'dummy-cli-capability'

function admit(path: string, init: { method?: string; headers?: Record<string, string> } = {}): Response | null {
	const url = new URL(`http://localhost:${PORT}${path}`)
	const request = new Request(url, { method: init.method ?? 'GET', headers: { Host: `localhost:${PORT}`, ...init.headers } })
	return admitRequest(request, url, { port: PORT, cliAuthToken: TOKEN })
}

describe('daemon admission', () => {
	test('admits the loopback names of the daemon', () => {
		for (const host of [`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`, `LOCALHOST:${PORT}`]) {
			expect(admit('/api/sessions', { headers: { Host: host } })).toBeNull()
		}
	})

	test('refuses a foreign Host on every route', () => {
		for (const host of [`rebound.example:${PORT}`, 'localhost:1', 'localhost', `127.0.0.2:${PORT}`]) {
			for (const path of ['/health', '/api/file?session=s&path=/etc/hosts', '/s/demo', '/ws/session/demo', '/api/review/app/threads']) {
				expect(admit(path, { headers: { Host: host } })?.status).toBe(403)
			}
		}
	})

	test('refuses a cross-site Origin on a request that changes state, whatever its content type', () => {
		for (const contentType of ['application/json', 'text/plain']) {
			const response = admit('/api/session/demo/secrets/field/value', {
				method: 'POST',
				headers: { Origin: 'https://site.example', 'Content-Type': contentType },
			})
			expect(response?.status).toBe(403)
		}
		expect(admit('/api/session/demo/secrets/field/value', { method: 'DELETE', headers: { Origin: 'http://localhost:5173' } })?.status).toBe(403)
		expect(admit('/api/session/demo/upload', { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' } })?.status).toBe(403)
	})

	test('refuses a cross-site WebSocket upgrade', () => {
		expect(admit('/ws/session/demo', { headers: { Origin: 'https://site.example', Upgrade: 'websocket' } })?.status).toBe(403)
	})

	test("admits the daemon's own UI", () => {
		for (const origin of [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]) {
			expect(admit('/api/session/demo/secrets/field/value', { method: 'POST', headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin' } })).toBeNull()
			expect(admit('/ws/session/demo', { headers: { Origin: origin, Upgrade: 'websocket' } })).toBeNull()
		}
	})

	test('leaves review routes to their own loopback-origin check', () => {
		expect(admit('/api/review/app/threads', { method: 'POST', headers: { Origin: 'http://localhost:5173' } })).toBeNull()
		expect(admit('/ws/review/app', { headers: { Origin: 'http://localhost:5173', Upgrade: 'websocket' } })).toBeNull()
	})

	test('requires the CLI capability on CLI routes', () => {
		const cliRoutes: Array<[string, string]> = [
			['POST', '/api/session/demo/plan'],
			['POST', '/api/session/demo/feedback/consume'],
			['POST', '/api/session/demo/secrets/resolve'],
			['GET', '/ws/wait/demo'],
			['GET', '/ws/review-wait/app'],
			['POST', '/api/review/app/claim'],
			['POST', '/api/review/app/proxy'],
			['POST', '/api/review/app/threads/t1/reply'],
		]
		for (const [method, path] of cliRoutes) {
			expect(admit(path, { method })?.status).toBe(401)
			expect(admit(path, { method, headers: { [CLI_TOKEN_HEADER]: 'wrong-capability' } })?.status).toBe(401)
			expect(admit(path, { method, headers: { [CLI_TOKEN_HEADER]: TOKEN } })).toBeNull()
		}
	})

	test('takes the capability from the query only on a WebSocket upgrade', () => {
		expect(admit(`/ws/wait/demo?${CLI_TOKEN_QUERY}=${TOKEN}`, { headers: { Upgrade: 'websocket' } })).toBeNull()
		expect(admit(`/ws/wait/demo?${CLI_TOKEN_QUERY}=wrong-capability`, { headers: { Upgrade: 'websocket' } })?.status).toBe(401)
		expect(admit(`/api/session/demo/secrets/resolve?${CLI_TOKEN_QUERY}=${TOKEN}`, { method: 'POST' })?.status).toBe(401)
	})
})
