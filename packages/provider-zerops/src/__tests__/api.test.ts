import { describe, expect, test } from 'bun:test'
import { createZeropsApi, type FetchLike, ZeropsApiError } from '../api'

const jsonResponse = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const signal = (): AbortSignal => new AbortController().signal

describe('Zerops API discovery', () => {
	test('lists every client project by following totalCount pages', async () => {
		const urls: string[] = []
		const fetchImpl: FetchLike = async (url) => {
			urls.push(url)
			if (url.endsWith('offset=0')) {
				return jsonResponse({
					list: [
						{ id: 'project-1', name: 'apps-prod', mode: 'SERIOUS', status: 'ACTIVE' },
						{ id: 'project-2', name: 'apps-stage', mode: 'LIGHT', status: 'STOPPED' },
					],
					totalCount: 3,
				})
			}
			return jsonResponse({
				list: [{ id: 'project-3', name: 'billing-prod', mode: 'SERIOUS', status: 'CREATING' }],
				totalCount: 3,
			})
		}
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl })

		await expect(api.listProjects({ clientId: 'client-1', signal: signal() })).resolves.toEqual([
			{ id: 'project-1', name: 'apps-prod', mode: 'SERIOUS', status: 'ACTIVE' },
			{ id: 'project-2', name: 'apps-stage', mode: 'LIGHT', status: 'STOPPED' },
			{ id: 'project-3', name: 'billing-prod', mode: 'SERIOUS', status: 'CREATING' },
		])
		expect(urls).toEqual([
			'https://zerops.test/client/client-1/project?limit=100&offset=0',
			'https://zerops.test/client/client-1/project?limit=100&offset=2',
		])
	})

	test('keeps every exact-name project match and encodes the name', async () => {
		const urls: string[] = []
		const fetchImpl: FetchLike = async (url) => {
			urls.push(url)
			return jsonResponse({
				projects: [
					{ id: 'project-1', name: 'apps prod', mode: 'SERIOUS' },
					{ id: 'project-2', name: 'apps prod', mode: 'LIGHT' },
				],
			})
		}
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl })

		await expect(api.findProjects({ clientId: 'client-1', name: 'apps prod', signal: signal() })).resolves.toEqual([
			{ id: 'project-1', name: 'apps prod', mode: 'SERIOUS', status: undefined },
			{ id: 'project-2', name: 'apps prod', mode: 'LIGHT', status: undefined },
		])
		expect(urls).toEqual(['https://zerops.test/client/client-1/projects-by-name/apps%20prod'])
	})

	test('reads project details using the documented mode field', async () => {
		const fetchImpl: FetchLike = async () =>
			jsonResponse({
				id: 'project-1',
				name: 'apps-prod',
				mode: 'SERIOUS',
				status: 'ACTIVE',
				corePackage: 'LIGHT',
				description: 'Managed by Fabrika namespace apps-prod (prod).',
				tagList: ['fabrika', 'namespace'],
			})
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl })

		await expect(api.getProject({ projectId: 'project-1', signal: signal() })).resolves.toEqual({
			id: 'project-1',
			name: 'apps-prod',
			mode: 'SERIOUS',
			status: 'ACTIVE',
			description: 'Managed by Fabrika namespace apps-prod (prod).',
			tagList: ['fabrika', 'namespace'],
		})
	})

	test('lists every service stack and preserves its base and status', async () => {
		const urls: string[] = []
		const fetchImpl: FetchLike = async (url) => {
			urls.push(url)
			if (url.endsWith('offset=0')) {
				return jsonResponse({
					list: [
						{
							id: 'service-1',
							name: 'proxy',
							projectId: 'project-1',
							base: 'alpine/caddy@2.10',
							status: 'ACTIVE',
							activeAppVersion: { id: 'version-1' },
							subdomainAccess: false,
							autoscalingProfileId: 'oltp-production',
						},
					],
					totalCount: 2,
				})
			}
			return jsonResponse({
				list: [{ id: 'service-2', name: 'postgres', projectId: 'project-1', base: 'postgresql:ha@18', status: 'CREATING' }],
				totalCount: 2,
			})
		}
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl })

		await expect(api.listProjectServices({ projectId: 'project-1', signal: signal() })).resolves.toEqual([
			{
				id: 'service-1',
				name: 'proxy',
				projectId: 'project-1',
				base: 'alpine/caddy@2.10',
				status: 'ACTIVE',
				activeAppVersionId: 'version-1',
				subdomainAccess: false,
				autoscalingProfileId: 'oltp-production',
			},
			{
				id: 'service-2',
				name: 'postgres',
				projectId: 'project-1',
				base: 'postgresql:ha@18',
				status: 'CREATING',
				activeAppVersionId: undefined,
			},
		])
		expect(urls).toEqual([
			'https://zerops.test/project/project-1/service-stack?limit=100&offset=0',
			'https://zerops.test/project/project-1/service-stack?limit=100&offset=1',
		])
	})

	test('redacts a proxy IAM key from service-env write failures but keeps the platform code', async () => {
		const secret = 'proxy-key-that-must-not-leak'
		const fetchImpl: FetchLike = async () => jsonResponse({ error: { code: 'userDataInvalid', message: `invalid value ${secret}` } }, 422)
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl })

		let thrown: unknown
		try {
			await api.putServiceEnv({ serviceId: 'proxy', key: 'FABRIKA_IAM_KEY', value: secret, signal: signal() })
		} catch (error) {
			thrown = error
		}
		expect(thrown).toBeInstanceOf(ZeropsApiError)
		const message = thrown instanceof Error ? thrown.message : String(thrown)
		expect(message).toContain('create service env failed (422)')
		expect(message).toContain('userDataInvalid')
		expect(message).not.toContain(secret)
		expect(thrown instanceof ZeropsApiError ? thrown.status : 0).toBe(422)
		expect(thrown instanceof ZeropsApiError ? thrown.code : '').toBe('userDataInvalid')
	})

	test('reads a service environment from /env, not from the list endpoint that always 400s', async () => {
		const urls: string[] = []
		const fetchImpl: FetchLike = async (url) => {
			urls.push(url)
			return jsonResponse({
				items: [
					{ id: 'env-1', key: 'FABRIKA_RELEASE', content: 'v1', serviceStackId: 'service-1', type: 'SECRET' },
					{ id: 'env-2', key: 'hostname', content: 'notesapi', serviceStackId: 'service-1', type: 'READ_ONLY' },
				],
			})
		}
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl })

		await expect(api.listServiceEnv({ serviceId: 'service-1', signal: signal() })).resolves.toEqual([
			{ id: 'env-1', key: 'FABRIKA_RELEASE', content: 'v1', serviceStackId: 'service-1', type: 'SECRET' },
			{ id: 'env-2', key: 'hostname', content: 'notesapi', serviceStackId: 'service-1', type: 'READ_ONLY' },
		])
		expect(urls).toEqual(['https://zerops.test/service-stack/service-1/env'])
	})

	test('fails when pagination ends before the documented totalCount', async () => {
		let calls = 0
		const fetchImpl: FetchLike = async () => {
			calls++
			return calls === 1
				? jsonResponse({ list: [{ id: 'project-1', name: 'apps-prod' }], totalCount: 2 })
				: jsonResponse({ list: [], totalCount: 2 })
		}
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl })

		await expect(api.listProjects({ clientId: 'client-1', signal: signal() })).rejects.toThrow(
			'zerops: list projects ended before totalCount',
		)
	})
})

/**
 * A fake shaped like the live platform: the `user-data` LIST always answers 400 `serviceStackNotFound`,
 * a create conflicts on an existing key, and `/env` is the only reading that works.
 */
const zeropsEnvDouble = (
	stored: { id: string; key: string; content: string }[],
	log: { method: string; path: string; body: unknown }[],
): FetchLike =>
async (url, init) => {
	const path = url.replace('https://zerops.test', '')
	const raw = init?.body
	const body: unknown = raw === undefined ? undefined : JSON.parse(raw)
	log.push({ method: init?.method ?? 'GET', path, body })
	if (init?.method === 'GET' && path.endsWith('/user-data')) {
		return jsonResponse({ error: { code: 'serviceStackNotFound', message: 'Service stack not found.' } }, 400)
	}
	if (init?.method === 'GET' && path.endsWith('/env')) {
		return jsonResponse({ items: stored.map((entry) => ({ ...entry, serviceStackId: 'service-1', type: 'SECRET' })) })
	}
	if (init?.method === 'POST' && path.endsWith('/user-data')) {
		const key = typeof body === 'object' && body !== null && 'key' in body ? String(Reflect.get(body, 'key')) : ''
		if (stored.some((entry) => entry.key === key)) {
			return jsonResponse(
				{ error: { code: 'userDataDuplicateKey', message: `UserData key '${key}' is not unique in service stack frame of reference.` } },
				400,
			)
		}
		stored.push({ id: `env-${stored.length + 1}`, key, content: 'created' })
		return jsonResponse({ id: 'process-1' })
	}
	if (init?.method === 'PUT' && path.startsWith('/user-data/')) {
		return jsonResponse({ id: 'process-2' })
	}
	return jsonResponse({ error: { code: 'unexpected', message: path } }, 500)
}

describe('Zerops service-level environment writes', () => {
	test('creates a variable without reading the service first', async () => {
		const log: { method: string; path: string; body: unknown }[] = []
		const fetchImpl = zeropsEnvDouble([], log)
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl })

		await api.putServiceEnv({ serviceId: 'service-1', key: 'FABRIKA_RELEASE', value: 'v1', signal: signal() })

		expect(log).toEqual([{ method: 'POST', path: '/service-stack/service-1/user-data', body: { key: 'FABRIKA_RELEASE', content: 'v1' } }])
	})

	test('updates an existing key through its record id after the create conflicts', async () => {
		const log: { method: string; path: string; body: unknown }[] = []
		const fetchImpl = zeropsEnvDouble([{ id: 'env-7', key: 'FABRIKA_RELEASE', content: 'v1' }], log)
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl })

		await api.putServiceEnv({ serviceId: 'service-1', key: 'FABRIKA_RELEASE', value: 'v2', signal: signal() })

		expect(log.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
			'POST /service-stack/service-1/user-data',
			'GET /service-stack/service-1/env',
			'PUT /user-data/env-7',
		])
		// Zerops rejects an update that sends `content` alone.
		expect(log[2]?.body).toEqual({ key: 'FABRIKA_RELEASE', content: 'v2' })
	})

	test('refuses a key the service declares outside the environment API, without echoing the value', async () => {
		const secret = 'value-that-must-not-leak'
		const log: { method: string; path: string; body: unknown }[] = []
		// The conflicting key is invisible to `/env` — what a `type: ENV` variable from `zerops.yaml` looks like.
		const fetchImpl: FetchLike = async (url, init) => {
			if (init?.method === 'POST') {
				return jsonResponse({ error: { code: 'userDataDuplicateKey', message: "UserData key 'PORT' is not unique" } }, 400)
			}
			return zeropsEnvDouble([], log)(url, init)
		}
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl })

		let message = ''
		try {
			await api.putServiceEnv({ serviceId: 'service-1', key: 'PORT', value: secret, signal: signal() })
		} catch (error) {
			message = error instanceof Error ? error.message : String(error)
		}
		expect(message).toBe('zerops: service service-1 already defines `PORT` outside the environment API — it cannot be written')
		expect(message).not.toContain(secret)
	})

	test('propagates a create failure that is not a duplicate key, without reading', async () => {
		const log: { method: string; path: string; body: unknown }[] = []
		const fetchImpl: FetchLike = async (_url, init) => {
			log.push({ method: init?.method ?? 'GET', path: '', body: undefined })
			return jsonResponse({ error: { code: 'userDataZeropsPrefixForbidden', message: 'reserved prefix' } }, 400)
		}
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl })

		await expect(api.putServiceEnv({ serviceId: 'service-1', key: 'ZEROPS_X', value: 'v', signal: signal() })).rejects.toThrow(
			'zerops: create service env failed (400) — userDataZeropsPrefixForbidden',
		)
		expect(log).toHaveLength(1)
	})
})
