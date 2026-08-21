import { describe, expect, test } from 'bun:test'
import { createZeropsApi, type FetchLike, waitForProcess, ZEROPS_SERVICE_NOT_HTTP, ZeropsApiError, type ZeropsLogAccess } from '../api'
import type { Sleeper } from '../collaborators'

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

	test('findService reads a missing name as the platform says it: 400 serviceStackNotFound', async () => {
		const urls: string[] = []
		const fetchImpl: FetchLike = async (url) => {
			urls.push(url)
			return jsonResponse({ error: { code: 'serviceStackNotFound', message: 'Service stack not found.', meta: [] } }, 400)
		}
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl })

		await expect(api.findService({ projectId: 'project-1', hostname: 'notesapi', signal: signal() })).resolves.toBeNull()
		expect(urls).toEqual(['https://zerops.test/service-stack-by-name/project-1/notesapi'])
	})

	test('findService still treats a 404 as missing and lets every other refusal propagate', async () => {
		const notFound = createZeropsApi({
			token: 'secret',
			baseUrl: 'https://zerops.test',
			fetchImpl: async () => jsonResponse({ error: { code: 'notFound', message: 'not found' } }, 404),
		})
		await expect(notFound.findService({ projectId: 'project-1', hostname: 'notesapi', signal: signal() })).resolves.toBeNull()

		const forbidden = createZeropsApi({
			token: 'secret',
			baseUrl: 'https://zerops.test',
			fetchImpl: async () => jsonResponse({ error: { code: 'insufficientPermissions', message: 'Insufficient permissions' } }, 403),
		})
		await expect(forbidden.findService({ projectId: 'project-1', hostname: 'notesapi', signal: signal() })).rejects.toMatchObject({
			name: 'ZeropsApiError',
			status: 403,
			code: 'insufficientPermissions',
		})
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

	test('accepts every service environment entry inside the response byte bound', async () => {
		const items = Array.from({ length: 600 }, (_, index) => ({
			id: `env-${index}`,
			key: `KEY_${index}`,
			content: `value-${index}`,
			serviceStackId: 'service-1',
			type: 'SECRET',
		}))
		const api = createZeropsApi({
			token: 'secret',
			baseUrl: 'https://zerops.test',
			fetchImpl: async () => jsonResponse({ items }),
		})

		await expect(api.listServiceEnv({ serviceId: 'service-1', signal: signal() })).resolves.toHaveLength(600)
	})

	test('rejects invalid UTF-8 in a successful service environment response', async () => {
		const api = createZeropsApi({
			token: 'secret',
			baseUrl: 'https://zerops.test',
			fetchImpl: async () => new Response(new Uint8Array([0x7b, 0xff, 0x7d])),
		})

		await expect(api.listServiceEnv({ serviceId: 'service-1', signal: signal() })).rejects.toThrow(
			'zerops: list service env returned an invalid response',
		)
	})

	test('rejects invalid JSON in a successful service environment response without exposing it', async () => {
		const secret = 'invalid-json-secret-that-must-not-leak'
		const api = createZeropsApi({
			token: 'secret',
			baseUrl: 'https://zerops.test',
			fetchImpl: async () => new Response(`{"items":["${secret}"`),
		})

		const error = await api.listServiceEnv({ serviceId: 'service-1', signal: signal() }).catch((cause: unknown) => cause)
		expect(error instanceof Error ? error.message : '').toBe('zerops: list service env returned an invalid response')
		expect(error instanceof Error ? error.message : '').not.toContain(secret)
	})

	test('rejects a successful service environment response with no items field', async () => {
		const api = createZeropsApi({
			token: 'secret',
			baseUrl: 'https://zerops.test',
			fetchImpl: async () => jsonResponse({ totalCount: 0 }),
		})

		await expect(api.listServiceEnv({ serviceId: 'service-1', signal: signal() })).rejects.toThrow(
			'zerops: list service env returned an invalid response',
		)
	})

	test('rejects a successful service environment response whose items field is not an array', async () => {
		const api = createZeropsApi({
			token: 'secret',
			baseUrl: 'https://zerops.test',
			fetchImpl: async () => jsonResponse({ items: { id: 'env-1' } }),
		})

		await expect(api.listServiceEnv({ serviceId: 'service-1', signal: signal() })).rejects.toThrow(
			'zerops: list service env returned an invalid response',
		)
	})

	test('rejects an oversized declared service environment response before parsing its body', async () => {
		let cancelled = false
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new TextEncoder().encode('{"items":[]}'))
				controller.close()
			},
			cancel() {
				cancelled = true
			},
		})
		const api = createZeropsApi({
			token: 'secret',
			baseUrl: 'https://zerops.test',
			fetchImpl: async () => new Response(body, { headers: { 'content-length': String(8 * 1024 * 1024 + 1) } }),
		})

		await expect(api.listServiceEnv({ serviceId: 'service-1', signal: signal() })).rejects.toThrow(
			'zerops: list service env response exceeded its byte bound',
		)
		expect(cancelled).toBe(true)
	})

	test('stops an undeclared service environment body when streamed bytes cross the bound', async () => {
		let cancelled = false
		const chunk = new Uint8Array(1024 * 1024)
		let chunks = 0
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				chunks++
				controller.enqueue(chunk)
			},
			cancel() {
				cancelled = true
			},
		})
		const api = createZeropsApi({
			token: 'secret',
			baseUrl: 'https://zerops.test',
			fetchImpl: async () => new Response(body),
		})

		await expect(api.listServiceEnv({ serviceId: 'service-1', signal: signal() })).rejects.toThrow(
			'zerops: list service env response exceeded its byte bound',
		)
		// Streams may keep one chunk queued ahead of the reader.
		expect(chunks).toBeGreaterThanOrEqual(9)
		expect(cancelled).toBe(true)
	})

	test('cancels a hanging service environment body when the caller aborts', async () => {
		let cancelled = false
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true
			},
		})
		const api = createZeropsApi({
			token: 'secret',
			baseUrl: 'https://zerops.test',
			fetchImpl: async () => new Response(body),
		})
		const controller = new AbortController()
		const pending = api.listServiceEnv({ serviceId: 'service-1', signal: controller.signal })
		controller.abort('private abort reason')

		const error = await pending.catch((cause: unknown) => cause)
		expect(error).toBeInstanceOf(DOMException)
		expect(error instanceof Error ? error.name : '').toBe('AbortError')
		expect(error instanceof Error ? error.message : '').not.toContain('private abort reason')
		expect(cancelled).toBe(true)
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
	test('creates a variable once with the exact POST body and caller signal', async () => {
		const controller = new AbortController()
		const requests: Array<{
			readonly method: string | undefined
			readonly url: string
			readonly body: string | undefined
			readonly signal: AbortSignal | undefined
		}> = []
		const fetchImpl: FetchLike = async (url, init) => {
			requests.push({ method: init?.method, url, body: init?.body, signal: init?.signal })
			return jsonResponse({ id: 'process-1' })
		}
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl })

		await api.createServiceEnv({ serviceId: 'service-1', key: 'FABRIKA_RELEASE', value: 'v1', signal: controller.signal })

		expect(requests).toEqual([{
			method: 'POST',
			url: 'https://zerops.test/service-stack/service-1/user-data',
			body: JSON.stringify({ key: 'FABRIKA_RELEASE', content: 'v1', sensitive: true }),
			signal: controller.signal,
		}])
	})

	test('marks every user-data write sensitive, which the platform requires', async () => {
		const bodies: unknown[] = []
		const fetchImpl: FetchLike = async (_url, init) => {
			bodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : null)
			return jsonResponse({ id: 'process-1' })
		}
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl })

		await api.putServiceEnv({ serviceId: 'service-1', key: 'FABRIKA_PROXY_MANIFEST_JSON', value: '{}', signal: signal() })

		// Omitting it answers 400 `invalidUserInput` with `{"sensitive":["field is required"]}` on the live
		// platform, which is how a namespace's very first proxy variable failed to be written.
		expect(bodies).toEqual([{ key: 'FABRIKA_PROXY_MANIFEST_JSON', content: '{}', sensitive: true }])
	})

	test('waits out the user-data sync a write starts, because the next operation is refused until it ends', async () => {
		// Live: each write answers a PENDING `stack.updateUserData`, and asking for a build while one runs
		// answers `400 userDataSyncRunning`. That is exactly how a deploy that set an app's environment and
		// then triggered its build failed, one second before the sync it had started finished.
		const calls: string[] = []
		let polls = 0
		const fetchImpl: FetchLike = async (url, init) => {
			calls.push(`${init?.method ?? 'GET'} ${url.replace('https://zerops.test', '')}`)
			if (url.includes('/process/')) {
				polls += 1
				return jsonResponse({ id: 'process-1', actionName: 'stack.updateUserData', status: polls > 1 ? 'FINISHED' : 'RUNNING' })
			}
			return jsonResponse({ id: 'process-1', actionName: 'stack.updateUserData', status: 'PENDING' })
		}
		const slept: number[] = []
		const api = createZeropsApi({
			token: 'secret',
			baseUrl: 'https://zerops.test',
			fetchImpl,
			sleep: async (ms) => {
				slept.push(ms)
			},
		})

		await api.putServiceEnv({ serviceId: 'service-1', key: 'FABRIKA_IAM_ISSUER', value: 'https://iam.test', signal: signal() })

		expect(calls).toEqual([
			'POST /service-stack/service-1/user-data',
			'GET /process/process-1',
			'GET /process/process-1',
		])
		expect(slept).toEqual([2_000])
	})

	test('leaves a user-data response that is not a process alone rather than polling its record id', async () => {
		// A record carries an `id` too. Polling `/process/{recordId}` would hang, so recognition is by
		// `actionName` and an unrecognised response ends the write.
		const calls: string[] = []
		const fetchImpl: FetchLike = async (url, init) => {
			calls.push(`${init?.method ?? 'GET'} ${url.replace('https://zerops.test', '')}`)
			return jsonResponse({ id: 'env-1', key: 'FABRIKA_RELEASE', content: 'v1' })
		}
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl, sleep: async () => {} })

		await api.createServiceEnv({ serviceId: 'service-1', key: 'FABRIKA_RELEASE', value: 'v1', signal: signal() })

		expect(calls).toEqual(['POST /service-stack/service-1/user-data'])
	})

	test('keeps a duplicate generic and never reads or updates it', async () => {
		const secret = 'create-only-secret-that-must-not-leak'
		const calls: string[] = []
		const fetchImpl: FetchLike = async (url, init) => {
			calls.push(`${init?.method ?? 'GET'} ${url.replace('https://zerops.test', '')}`)
			return jsonResponse(
				{ error: { code: 'userDataDuplicateKey', message: `duplicate value ${secret}` } },
				400,
			)
		}
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl })

		const error = await api.createServiceEnv({ serviceId: 'service-1', key: 'TOKEN', value: secret, signal: signal() }).catch(
			(cause: unknown) => cause,
		)

		expect(error).toBeInstanceOf(Error)
		expect(error instanceof Error ? error.message : '').toBe('zerops: create-only service env failed')
		expect(error instanceof Error ? error.message : '').not.toContain(secret)
		expect(error instanceof Error ? error.message : '').not.toContain('userDataDuplicateKey')
		expect(calls).toEqual(['POST /service-stack/service-1/user-data'])
	})

	test('redacts transport failures and preserves caller cancellation', async () => {
		const secret = 'transport-secret-that-must-not-leak'
		let calls = 0
		const failingFetch: FetchLike = async () => {
			calls++
			throw new Error(`transport echoed ${secret}`)
		}
		const failed = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl: failingFetch })
		const failure = await failed.createServiceEnv({ serviceId: 'service-1', key: 'TOKEN', value: secret, signal: signal() }).catch(
			(cause: unknown) => cause,
		)
		expect(failure instanceof Error ? failure.message : '').toBe('zerops: create-only service env failed')
		expect(failure instanceof Error ? failure.message : '').not.toContain(secret)

		const controller = new AbortController()
		controller.abort()
		const aborted = await failed.createServiceEnv({ serviceId: 'service-1', key: 'TOKEN', value: secret, signal: controller.signal }).catch(
			(cause: unknown) => cause,
		)
		expect(aborted).toBeInstanceOf(DOMException)
		expect(aborted instanceof Error ? aborted.name : '').toBe('AbortError')
		expect(calls).toBe(1)
	})

	test('creates a variable without reading the service first', async () => {
		const log: { method: string; path: string; body: unknown }[] = []
		const fetchImpl = zeropsEnvDouble([], log)
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl })

		await api.putServiceEnv({ serviceId: 'service-1', key: 'FABRIKA_RELEASE', value: 'v1', signal: signal() })

		expect(log).toEqual([{
			method: 'POST',
			path: '/service-stack/service-1/user-data',
			body: { key: 'FABRIKA_RELEASE', content: 'v1', sensitive: true },
		}])
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
		// Zerops rejects an update that sends `content` alone, and one that omits `sensitive`.
		expect(log[2]?.body).toEqual({ key: 'FABRIKA_RELEASE', content: 'v2', sensitive: true })
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

describe('Zerops subdomain access', () => {
	test('publishes a service with a bodiless PUT', async () => {
		const log: { method: string; url: string; body: string | undefined; contentType: string | undefined }[] = []
		const fetchImpl: FetchLike = async (url, init) => {
			log.push({ method: init?.method ?? 'GET', url, body: init?.body, contentType: init?.headers?.['content-type'] })
			return jsonResponse({ id: 'process-1', status: 'PENDING', actionName: 'stack.enableSubdomainAccess' })
		}
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl })

		await api.enableSubdomainAccess({ serviceId: 'service-1', signal: signal() })

		expect(log).toEqual([{
			method: 'PUT',
			url: 'https://zerops.test/service-stack/service-1/enable-subdomain-access',
			body: undefined,
			contentType: undefined,
		}])
	})

	test('keeps the platform code for a service that publishes no HTTP port', async () => {
		const fetchImpl: FetchLike = async () =>
			jsonResponse({ error: { code: ZEROPS_SERVICE_NOT_HTTP, message: 'Service stack is not http or https' } }, 400)
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl })

		const error = await api.enableSubdomainAccess({ serviceId: 'service-1', signal: signal() }).catch((cause: unknown) => cause)

		expect(error).toBeInstanceOf(ZeropsApiError)
		expect(error instanceof ZeropsApiError ? error.code : '').toBe(ZEROPS_SERVICE_NOT_HTTP)
	})
})

describe('Zerops integration tokens', () => {
	test('mints a project-scoped token and states the client role even when it is the schema default', async () => {
		const log: { method: string; url: string; body: unknown }[] = []
		const fetchImpl: FetchLike = async (url, init) => {
			log.push({ method: init?.method ?? 'GET', url, body: init?.body === undefined ? undefined : JSON.parse(init.body) })
			return jsonResponse({
				id: 'token-1',
				name: 'fabrika-control',
				token: 'zi-minted-value',
				roleCode: 'NO_ACCESS',
				projects: [{ projectId: 'project-1', roleCode: 'ADMIN' }],
				created: '2026-08-10T00:00:00Z',
				lastUpdate: '2026-08-10T00:00:00Z',
			})
		}
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl })

		await expect(
			api.createIntegrationToken({
				clientId: 'client-1',
				name: 'fabrika-control',
				projects: [{ projectId: 'project-1', roleCode: 'ADMIN' }],
				signal: signal(),
			}),
		).resolves.toEqual({
			id: 'token-1',
			name: 'fabrika-control',
			token: 'zi-minted-value',
			roleCode: 'NO_ACCESS',
			projects: [{ projectId: 'project-1', roleCode: 'ADMIN' }],
		})
		expect(log).toEqual([{
			method: 'POST',
			url: 'https://zerops.test/client/client-1/integration-token',
			// `roleCode` and `canCreateProjects` are both on the wire although each is what the schema would
			// have defaulted to: a security-relevant field nobody can see is a field nobody can review.
			body: {
				name: 'fabrika-control',
				roleCode: 'NO_ACCESS',
				canCreateProjects: false,
				projects: [{ projectId: 'project-1', roleCode: 'ADMIN' }],
			},
		}])
	})

	test('sends an explicitly requested client role and asks for project creation only when told to', async () => {
		const bodies: unknown[] = []
		const fetchImpl: FetchLike = async (_url, init) => {
			bodies.push(init?.body === undefined ? undefined : JSON.parse(init.body))
			return jsonResponse({ id: 'token-1', name: 'ci', token: 'zi-x', projects: [] })
		}
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl })

		await api.createIntegrationToken({
			clientId: 'client-1',
			name: 'ci',
			projects: [{ projectId: 'project-1', roleCode: 'BASIC_USER' }],
			roleCode: 'READ_ONLY',
			signal: signal(),
		})

		expect(bodies).toEqual([{
			name: 'ci',
			roleCode: 'READ_ONLY',
			canCreateProjects: false,
			projects: [{ projectId: 'project-1', roleCode: 'BASIC_USER' }],
		}])
		expect(JSON.stringify(bodies)).not.toContain('canViewFinances')
	})

	test('reports a role this build does not know as absent rather than guessing one', async () => {
		const fetchImpl: FetchLike = async () =>
			jsonResponse({ id: 'token-1', name: 'ci', token: 'zi-x', roleCode: 'ARCHITECT', projects: [{ projectId: 'project-1' }] })
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl })

		await expect(
			api.createIntegrationToken({ clientId: 'client-1', name: 'ci', projects: [{ projectId: 'project-1', roleCode: 'ADMIN' }], signal: signal() }),
		).resolves.toEqual({
			id: 'token-1',
			name: 'ci',
			token: 'zi-x',
			roleCode: undefined,
			// The response omitted this grant's `roleCode`; the schema's `NO_ACCESS` default is not substituted.
			projects: [{ projectId: 'project-1', roleCode: undefined }],
		})
	})

	test('drops a server message that quotes the minted token and keeps the platform code', async () => {
		const minted = 'zi-token-that-must-not-leak'
		const fetchImpl: FetchLike = async () => jsonResponse({ error: { code: 'invalidUserInput', message: `token ${minted} could not be stored` } }, 422)
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl })

		const error = await api
			.createIntegrationToken({ clientId: 'client-1', name: 'ci', projects: [{ projectId: 'project-1', roleCode: 'ADMIN' }], signal: signal() })
			.catch((cause: unknown) => cause)

		expect(error).toBeInstanceOf(ZeropsApiError)
		const message = error instanceof Error ? error.message : String(error)
		expect(message).toBe('zerops: create integration token failed (422) — invalidUserInput')
		expect(message).not.toContain(minted)
		expect(error instanceof ZeropsApiError ? error.status : 0).toBe(422)
		expect(error instanceof ZeropsApiError ? error.code : '').toBe('invalidUserInput')
	})

	test('propagates a non-2xx that carries no error envelope', async () => {
		const fetchImpl: FetchLike = async () => new Response('nope', { status: 503 })
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl })

		const error = await api
			.createIntegrationToken({ clientId: 'client-1', name: 'ci', projects: [{ projectId: 'project-1', roleCode: 'ADMIN' }], signal: signal() })
			.catch((cause: unknown) => cause)

		expect(error).toBeInstanceOf(ZeropsApiError)
		expect(error instanceof ZeropsApiError ? error.status : 0).toBe(503)
		expect(error instanceof Error ? error.message : '').toBe('zerops: create integration token failed (503)')
	})
})

describe('Zerops upload-backed app versions', () => {
	test('creates named and unnamed versions with the exact request shape', async () => {
		const requests: { method: string; url: string; body: unknown; signal: AbortSignal | undefined }[] = []
		let sequence = 0
		const fetchImpl: FetchLike = async (url, init) => {
			sequence++
			requests.push({
				method: init?.method ?? 'GET',
				url,
				body: init?.body === undefined ? undefined : JSON.parse(init.body),
				signal: init?.signal,
			})
			return jsonResponse({
				id: `version-${sequence}`,
				serviceStackId: 'service-1',
				uploadUrl: `https://upload.test/archive-${sequence}?signature=secret`,
			})
		}
		const api = createZeropsApi({ token: 'zerops-secret', baseUrl: 'https://zerops.test', fetchImpl })
		const controller = new AbortController()

		await expect(api.createAppVersion({ serviceId: 'service-1', signal: controller.signal })).resolves.toEqual({
			id: 'version-1',
			uploadUrl: 'https://upload.test/archive-1?signature=secret',
		})
		await expect(api.createAppVersion({ serviceId: 'service-1', name: 'release 42', signal: controller.signal })).resolves.toEqual({
			id: 'version-2',
			uploadUrl: 'https://upload.test/archive-2?signature=secret',
		})
		expect(requests).toEqual([
			{
				method: 'POST',
				url: 'https://zerops.test/service-stack/service-1/app-version',
				body: {},
				signal: controller.signal,
			},
			{
				method: 'POST',
				url: 'https://zerops.test/service-stack/service-1/app-version',
				body: { name: 'release 42' },
				signal: controller.signal,
			},
		])
	})

	test('builds an uploaded version with zeropsYamlSetup on the documented wire key', async () => {
		const requests: { method: string; url: string; body: unknown }[] = []
		const fetchImpl: FetchLike = async (url, init) => {
			requests.push({
				method: init?.method ?? 'GET',
				url,
				body: init?.body === undefined ? undefined : JSON.parse(init.body),
			})
			return jsonResponse({
				id: 'process-1',
				status: 'PENDING',
				actionName: 'stack.build',
				serviceStackId: 'service-1',
				appVersion: { id: 'version-1' },
			})
		}
		const api = createZeropsApi({ token: 'zerops-secret', baseUrl: 'https://zerops.test', fetchImpl })

		await expect(
			api.buildAndDeployAppVersion({
				appVersionId: 'version-1',
				zeropsYaml: 'zerops:\n  - setup: app\n',
				zeropsYamlSetup: 'app',
				signal: signal(),
			}),
		).resolves.toEqual({
			id: 'process-1',
			status: 'PENDING',
			actionName: 'stack.build',
			serviceStackId: 'service-1',
			appVersionId: 'version-1',
		})
		expect(requests).toEqual([{
			method: 'PUT',
			url: 'https://zerops.test/app-version/version-1/build-and-deploy',
			body: { zeropsYaml: 'zerops:\n  - setup: app\n', zeropsYamlSetup: 'app' },
		}])
	})

	test('accepts a documented process without appVersion, omits zeropsYamlSetup, and deletes with a bodiless request', async () => {
		const requests: { method: string; url: string; body: unknown }[] = []
		const fetchImpl: FetchLike = async (url, init) => {
			requests.push({
				method: init?.method ?? 'GET',
				url,
				body: init?.body === undefined ? undefined : JSON.parse(init.body),
			})
			return init?.method === 'DELETE'
				? jsonResponse({ success: true })
				: jsonResponse({ id: 'process-1' })
		}
		const api = createZeropsApi({ token: 'zerops-secret', baseUrl: 'https://zerops.test', fetchImpl })

		await api.buildAndDeployAppVersion({ appVersionId: 'version-1', zeropsYaml: 'zerops: []\n', signal: signal() })
		await expect(api.deleteAppVersion({ appVersionId: 'version-1', signal: signal() })).resolves.toBeUndefined()
		expect(requests).toEqual([
			{
				method: 'PUT',
				url: 'https://zerops.test/app-version/version-1/build-and-deploy',
				body: { zeropsYaml: 'zerops: []\n' },
			},
			{ method: 'DELETE', url: 'https://zerops.test/app-version/version-1', body: undefined },
		])
	})

	test('rejects missing create fields and mismatched response coordinates without exposing the upload URL', async () => {
		const uploadUrl = 'https://upload.test/archive?signature=must-not-leak'
		const responses = [
			{ serviceStackId: 'service-1', uploadUrl },
			{ id: 'version-2', serviceStackId: 'different-service', uploadUrl },
		]
		let call = 0
		const fetchImpl: FetchLike = async () => jsonResponse(responses[call++])
		const api = createZeropsApi({ token: 'zerops-secret', baseUrl: 'https://zerops.test', fetchImpl })

		for (let attempt = 0; attempt < responses.length; attempt++) {
			const error = await api.createAppVersion({ serviceId: 'service-1', signal: signal() }).catch((cause: unknown) => cause)
			expect(error instanceof Error ? error.message : '').toBe('zerops: create app-version returned an invalid response')
			expect(error instanceof Error ? error.message : '').not.toContain(uploadUrl)
		}
	})

	test('rejects a malformed build process and a different app-version coordinate without exposing the response', async () => {
		const responseSecret = 'response-value-that-must-not-leak'
		const responses = [
			{ id: '', message: responseSecret },
			{ id: 'process-2', appVersion: { id: 'version-other' }, message: responseSecret },
		]
		let call = 0
		const fetchImpl: FetchLike = async () => jsonResponse(responses[call++])
		const api = createZeropsApi({ token: 'zerops-secret', baseUrl: 'https://zerops.test', fetchImpl })

		for (let attempt = 0; attempt < responses.length; attempt++) {
			const error = await api
				.buildAndDeployAppVersion({ appVersionId: 'version-1', zeropsYaml: 'zerops: []\n', signal: signal() })
				.catch((cause: unknown) => cause)
			expect(error instanceof Error ? error.message : '').toBe('zerops: build and deploy app-version returned an invalid response')
			expect(error instanceof Error ? error.message : '').not.toContain(responseSecret)
		}
	})

	test('requires an explicit successful delete response without exposing malformed content', async () => {
		const responseSecret = 'delete-response-that-must-not-leak'
		const responses = [{ success: false, message: responseSecret }, { message: responseSecret }, null]
		let call = 0
		const fetchImpl: FetchLike = async () => jsonResponse(responses[call++])
		const api = createZeropsApi({ token: 'zerops-secret', baseUrl: 'https://zerops.test', fetchImpl })

		for (let attempt = 0; attempt < responses.length; attempt++) {
			const error = await api.deleteAppVersion({ appVersionId: 'version-1', signal: signal() }).catch((cause: unknown) => cause)
			expect(error instanceof Error ? error.message : '').toBe('zerops: delete app-version returned an invalid response')
			expect(error instanceof Error ? error.message : '').not.toContain(responseSecret)
		}
	})

	test('preserves a sanitized AbortError before fetch, during fetch, and while reading the response body', async () => {
		const abortDetail = 'credential-bearing abort detail that must not leak'
		const before = new AbortController()
		before.abort(new Error(abortDetail))
		let beforeFetchCalls = 0
		const beforeApi = createZeropsApi({
			token: 'zerops-secret',
			baseUrl: 'https://zerops.test',
			fetchImpl: async () => {
				beforeFetchCalls++
				return jsonResponse({ success: true })
			},
		})

		const duringApi = createZeropsApi({
			token: 'zerops-secret',
			baseUrl: 'https://zerops.test',
			fetchImpl: async () => {
				throw new DOMException(abortDetail, 'AbortError')
			},
		})

		class AbortingJsonResponse extends Response {
			override json(): Promise<never> {
				return Promise.reject(new DOMException(abortDetail, 'AbortError'))
			}
		}
		const bodyApi = createZeropsApi({
			token: 'zerops-secret',
			baseUrl: 'https://zerops.test',
			fetchImpl: async () => new AbortingJsonResponse(null, { status: 200 }),
		})

		const errors = await Promise.all([
			beforeApi.deleteAppVersion({ appVersionId: 'version-1', signal: before.signal }).catch((cause: unknown) => cause),
			duringApi.deleteAppVersion({ appVersionId: 'version-1', signal: signal() }).catch((cause: unknown) => cause),
			bodyApi.deleteAppVersion({ appVersionId: 'version-1', signal: signal() }).catch((cause: unknown) => cause),
		])
		expect(beforeFetchCalls).toBe(0)
		for (const error of errors) {
			expect(error instanceof Error ? error.name : '').toBe('AbortError')
			expect(error instanceof Error ? error.message : '').toBe('The operation was aborted')
			expect(error instanceof Error ? error.message : '').not.toContain(abortDetail)
		}
	})

	test('keeps the code of a refused build and drops every response body', async () => {
		const responseSecret = 'response-value-that-must-not-leak'
		const uploadUrl = 'https://upload.test/archive?signature=must-not-leak'
		const token = 'zerops-token-that-must-not-leak'
		const fetchImpl: FetchLike = async () => jsonResponse({ error: { code: 'platformCode', message: `${responseSecret} ${uploadUrl} ${token}` } }, 503)
		const api = createZeropsApi({ token, baseUrl: 'https://zerops.test', fetchImpl })

		const errors = await Promise.all([
			api
				.buildAndDeployAppVersion({ appVersionId: 'version-1', zeropsYaml: 'zerops: []\n', signal: signal() })
				.catch((cause: unknown) => cause),
			api.deleteAppVersion({ appVersionId: 'version-1', signal: signal() }).catch((cause: unknown) => cause),
		])
		// The build keeps the CODE — a refusal an operator can act on, `userDataSyncRunning` above all —
		// and the delete keeps nothing, because its response is the one that can carry an upload URL.
		expect(errors.map((error) => error instanceof Error ? error.message : '')).toEqual([
			'zerops: build and deploy app-version failed (503) — platformCode',
			'zerops: delete app-version failed (503)',
		])
		expect(errors.map((error) => error instanceof ZeropsApiError ? error.code : 'unexpected')).toEqual(['platformCode', ''])
		for (const error of errors) {
			const message = error instanceof Error ? error.message : ''
			expect(message).not.toContain(responseSecret)
			expect(message).not.toContain(uploadUrl)
			expect(message).not.toContain(token)
		}
	})
})

/** Answer `GET /process/{id}` with one status per call, holding the last one once the script runs out. */
const processStatuses = (statuses: readonly string[], urls: string[]): FetchLike => {
	let poll = 0
	return async (url) => {
		urls.push(url)
		const status = statuses[Math.min(poll, statuses.length - 1)]
		poll++
		return jsonResponse({ id: 'process-1', status, actionName: 'stack.updateUserData', serviceStackId: 'service-1' })
	}
}

const recordingSleep = (slept: number[]): Sleeper => async (ms) => {
	slept.push(ms)
}

describe('Zerops processes', () => {
	test('reads one process by id and lifts the app-version id out of its nested object', async () => {
		const urls: string[] = []
		const fetchImpl: FetchLike = async (url) => {
			urls.push(url)
			return jsonResponse({
				id: 'process-1',
				status: 'FINISHED',
				actionName: 'stack.deploy',
				serviceStackId: 'service-1',
				appVersion: { id: 'version-9', sequence: 3 },
			})
		}
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl })

		await expect(api.getProcess({ processId: 'process-1', signal: signal() })).resolves.toEqual({
			id: 'process-1',
			status: 'FINISHED',
			actionName: 'stack.deploy',
			serviceStackId: 'service-1',
			appVersionId: 'version-9',
		})
		expect(urls).toEqual(['https://zerops.test/process/process-1'])
	})

	test('keeps the platform code when a process cannot be read', async () => {
		const fetchImpl: FetchLike = async () => jsonResponse({ error: { code: 'processNotFound', message: 'Process not found.' } }, 404)
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl })

		const error = await api.getProcess({ processId: 'process-1', signal: signal() }).catch((cause: unknown) => cause)

		expect(error).toBeInstanceOf(ZeropsApiError)
		expect(error instanceof ZeropsApiError ? error.status : 0).toBe(404)
		expect(error instanceof ZeropsApiError ? error.code : '').toBe('processNotFound')
	})

	test('polls until the process reports FINISHED and returns it', async () => {
		const urls: string[] = []
		const slept: number[] = []
		const api = createZeropsApi({
			token: 'secret',
			baseUrl: 'https://zerops.test',
			fetchImpl: processStatuses(['PENDING', 'RUNNING', 'FINISHED'], urls),
		})

		const finished = await waitForProcess({ api, processId: 'process-1', sleep: recordingSleep(slept), signal: signal(), intervalMs: 7 })

		expect(finished.id).toBe('process-1')
		expect(finished.status).toBe('FINISHED')
		expect(urls).toHaveLength(3)
		expect(slept).toEqual([7, 7])
	})

	test('throws naming the terminal status a failed process ended on', async () => {
		const urls: string[] = []
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl: processStatuses(['RUNNING', 'FAILED'], urls) })

		await expect(
			waitForProcess({ api, processId: 'process-1', sleep: recordingSleep([]), signal: signal(), intervalMs: 1, label: 'the import' }),
		).rejects.toThrow('zerops: the import finished as FAILED')
	})

	test('treats a status this build has never seen as "keep waiting", so it times out instead of succeeding', async () => {
		const urls: string[] = []
		const slept: number[] = []
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl: processStatuses(['SOMETHING_NEW'], urls) })

		await expect(
			waitForProcess({ api, processId: 'process-1', sleep: recordingSleep(slept), signal: signal(), intervalMs: 1, attempts: 3 }),
		).rejects.toThrow('zerops: process-1 did not finish in time')
		expect(urls).toHaveLength(4)
		expect(slept).toEqual([1, 1, 1])
	})

	test('stops on a cancelled run instead of spending its whole budget against an early-resolving sleeper', async () => {
		const urls: string[] = []
		const controller = new AbortController()
		controller.abort()
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl: processStatuses(['PENDING'], urls) })

		await expect(
			waitForProcess({ api, processId: 'process-1', sleep: recordingSleep([]), signal: controller.signal, intervalMs: 1 }),
		).rejects.toThrow('zerops: waiting for process-1 was cancelled')
		expect(urls).toEqual([])
	})
})

const LOG_ACCESS: ZeropsLogAccess = {
	url: 'https://logs.test/api/rest/log?accessToken=grant',
	urlPlain: 'https://logs.test/api/rest/log/plaintext?accessToken=grant',
	urlInfo: 'https://logs.test/api/rest/log/info?accessToken=grant',
	urlUi: 'https://logs.test/ui',
	accessToken: 'grant',
	expiration: '2099-01-01T00:00:00Z',
}

const BUILD_LINES = [
	'2026-08-21T10:00:02.100000000Z zbuilder@version-2 bun install --frozen-lockfile',
	'2026-08-21T10:00:09.200000000Z zbuilder@version-2 build finished',
].join('\n')

const RUNTIME_LINES = [
	'2026-08-21T09:30:00.000000000Z zerops@zerops notes-api listening (an earlier version)',
	'2026-08-21T09:59:59.999000000Z init starting supervise-daemon (an earlier version)',
	'2026-08-21T10:00:11.000000000Z zerops@zerops notes-api listening',
	'an undated line the relay cannot place',
].join('\n')

const logFetch = (urls: string[]): FetchLike => async (url) => {
	urls.push(url)
	if (url.includes('tags=')) return new Response(url.includes('zbuilder%40version-2') ? `${BUILD_LINES}\n` : '')
	return new Response(`${RUNTIME_LINES}\n`)
}

describe('Zerops build-log window', () => {
	test('reads build lines by tag alone and cuts the runtime window at the pipeline start', async () => {
		const urls: string[] = []
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl: logFetch(urls) })

		const lines = await api.readBuildLog({
			access: LOG_ACCESS,
			serviceId: 'service-1',
			appVersionId: 'version-2',
			since: '2026-08-21T10:00:00.000000000Z',
			signal: signal(),
		})

		expect(urls).toEqual([
			'https://logs.test/api/rest/log/plaintext?accessToken=grant&tags=zbuilder%40version-2&limit=200',
			'https://logs.test/api/rest/log/plaintext?accessToken=grant&serviceStackId=service-1&limit=200',
		])
		expect(lines).toEqual([
			{ timestamp: '2026-08-21T10:00:02.100000000Z', message: '2026-08-21T10:00:02.100000000Z zbuilder@version-2 bun install --frozen-lockfile' },
			{ timestamp: '2026-08-21T10:00:09.200000000Z', message: '2026-08-21T10:00:09.200000000Z zbuilder@version-2 build finished' },
			{ timestamp: '2026-08-21T10:00:11.000000000Z', message: '2026-08-21T10:00:11.000000000Z zerops@zerops notes-api listening' },
		])
	})

	test('reads no runtime line at all until the platform reports a pipeline start', async () => {
		const urls: string[] = []
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl: logFetch(urls) })

		const lines = await api.readBuildLog({ access: LOG_ACCESS, serviceId: 'service-1', appVersionId: 'version-2', limit: 50, signal: signal() })

		expect(urls).toEqual(['https://logs.test/api/rest/log/plaintext?accessToken=grant&tags=zbuilder%40version-2&limit=50'])
		expect(lines.map((line) => line.message)).toEqual(BUILD_LINES.split('\n'))
	})

	test('selects a different version by its own tag', async () => {
		const urls: string[] = []
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl: logFetch(urls) })

		const lines = await api.readBuildLog({ access: LOG_ACCESS, serviceId: 'service-1', appVersionId: 'version-1', signal: signal() })

		expect(urls).toEqual(['https://logs.test/api/rest/log/plaintext?accessToken=grant&tags=zbuilder%40version-1&limit=200'])
		expect(lines).toEqual([])
	})

	test('relays an undatable runtime line only when the pipeline start is unusable', async () => {
		const urls: string[] = []
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl: logFetch(urls) })

		const lines = await api.readBuildLog({ access: LOG_ACCESS, serviceId: 'service-1', since: 'not-a-date', signal: signal() })

		expect(urls).toEqual(['https://logs.test/api/rest/log/plaintext?accessToken=grant&serviceStackId=service-1&limit=200'])
		expect(lines.map((line) => line.timestamp)).toEqual([
			'2026-08-21T09:30:00.000000000Z',
			'2026-08-21T09:59:59.999000000Z',
			'2026-08-21T10:00:11.000000000Z',
			undefined,
		])
	})

	test('asks for nothing when the grant carries no plaintext url', async () => {
		const urls: string[] = []
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl: logFetch(urls) })

		await expect(
			api.readBuildLog({ access: { ...LOG_ACCESS, urlPlain: '' }, serviceId: 'service-1', appVersionId: 'version-2', signal: signal() }),
		).resolves.toEqual([])
		expect(urls).toEqual([])
	})

	test('reports the status when every window it attempted was refused', async () => {
		const api = createZeropsApi({
			token: 'secret',
			baseUrl: 'https://zerops.test',
			fetchImpl: async () => new Response('nope', { status: 400 }),
		})

		await expect(api.readBuildLog({ access: LOG_ACCESS, serviceId: 'service-1', appVersionId: 'version-2', signal: signal() }))
			.rejects.toThrow('zerops: read build log failed (400)')
		await expect(
			api.readBuildLog({ access: LOG_ACCESS, serviceId: 'service-1', appVersionId: 'version-2', since: '2026-08-21T10:00:00Z', signal: signal() }),
		).rejects.toThrow('zerops: read build log failed (400)')
	})

	test('keeps the build lines when only the runtime window fails, so a last poll does not lose them', async () => {
		const api = createZeropsApi({
			token: 'secret',
			baseUrl: 'https://zerops.test',
			fetchImpl: async (url) => url.includes('tags=') ? new Response(`${BUILD_LINES}\n`) : new Response('nope', { status: 503 }),
		})

		const lines = await api.readBuildLog({
			access: LOG_ACCESS,
			serviceId: 'service-1',
			appVersionId: 'version-2',
			since: '2026-08-21T10:00:00.000000000Z',
			signal: signal(),
		})

		expect(lines.map((line) => line.message)).toEqual(BUILD_LINES.split('\n'))
	})

	test('keeps the runtime lines when only the build window fails', async () => {
		const api = createZeropsApi({
			token: 'secret',
			baseUrl: 'https://zerops.test',
			fetchImpl: async (url) => url.includes('tags=') ? new Response('nope', { status: 503 }) : new Response(`${RUNTIME_LINES}\n`),
		})

		const lines = await api.readBuildLog({
			access: LOG_ACCESS,
			serviceId: 'service-1',
			appVersionId: 'version-2',
			since: '2026-08-21T10:00:00.000000000Z',
			signal: signal(),
		})

		expect(lines.map((line) => line.message)).toEqual(['2026-08-21T10:00:11.000000000Z zerops@zerops notes-api listening'])
	})
})
