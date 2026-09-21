import { describe, expect, test } from 'bun:test'
import type { BuilderPlatformStatus } from '../../shared'
import { createPlatformClient } from '../src/lib/platformClient'

export const status: BuilderPlatformStatus = {
	sessionId: 'project',
	projectRoot: '/workspace/project',
	connection: null,
	credential: { available: false, expiresAt: null },
	pairing: null,
	previewUrl: null,
	deployment: null,
}

function client(response: () => Response) {
	const calls: { url: string; init?: RequestInit }[] = []
	const request: typeof fetch = Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), ...(init ? { init } : {}) })
		return response()
	}, { preconnect: fetch.preconnect })
	return { api: createPlatformClient(request), calls }
}

describe('builder platform HTTP client', () => {
	test('uses parsed local responses and relative same-origin POSTs with redirects refused', async () => {
		const { api, calls } = client(() => Response.json(status))
		expect(await api.act('project', { kind: 'preview', url: 'http://localhost:4321/app' })).toEqual(status)
		expect(calls[0]?.url).toBe('/api/project/project/preview')
		expect(calls[0]?.init?.redirect).toBe('error')
		expect(calls[0]?.init?.body).toBe('{"url":"http://localhost:4321/app"}')
	})
	test('rejects malformed and mismatched successes', async () => {
		for (const response of [{}, { ...status, sessionId: 'other' }, { ...status, previewUrl: 'javascript:alert(1)' }]) {
			await expect(client(() => Response.json(response)).api.status('project')).rejects.toThrow('invalid status')
		}
		await expect(client(() => new Response('<html>secret</html>')).api.status('project')).rejects.toThrow('invalid response')
	})
	test('renders only recognized safe local errors, never arbitrary non-2xx bodies', async () => {
		await expect(
			client(() => Response.json({ error: { code: 'builder_platform', message: 'Commit must be pushed' } }, { status: 400 })).api.status('project'),
		).rejects.toThrow('Commit must be pushed')
		await expect(client(() => Response.json({ error: { code: 'upstream', message: 'secret' } }, { status: 500 })).api.status('project')).rejects
			.toThrow('Local builder rejected')
	})
	test('invalid connection origin fails before any request', () => {
		const { api, calls } = client(() => Response.json(status))
		expect(() => api.act('project', { kind: 'connect', controlOrigin: 'https://user:secret@example.com' })).toThrow('valid URL')
		expect(calls).toHaveLength(0)
	})
})
