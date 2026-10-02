import type { Sleeper } from '../collaborators'
import { apiError, ZeropsApiError } from './errors'
import { waitForProcess } from './polling'
import { arr, num, prop, readAppVersion, readIntegrationToken, readProcess, readProject, readService, readServiceEnv, str } from './readers'
import { parseServiceEnvResponse } from './service-env-response'
import type { ZeropsApi, ZeropsApiOptions, ZeropsAppVersion, ZeropsImportResult, ZeropsLogLine } from './types'

/**
 * `sensitive` on every user-data WRITE, create and update alike. Required by the platform — omitting it answers
 * `400 invalidUserInput` with `{"sensitive":["field is required"]}` (measured live, 2026-08-18) — and
 * `true` because most of what fabrika writes is a credential. It costs nothing to read: a sensitive
 * variable's `content` still comes back verbatim from `GET /service-stack/{id}/env`, also measured, so the
 * compare-before-write both `platform deploy` and the create-only credential slots depend on still works.
 */
const SENSITIVE_USER_DATA = true

/** The RFC3339 stamp the plaintext log window puts first on every line. Anchored so a bare year cannot pass. */
const LOG_LINE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

// ── default (real) implementation ───────────────────────────────────────────────

/** Base URL of the Zerops public REST API. */
export const ZEROPS_API_BASE = 'https://api.app-prg1.zerops.io/api/rest/public'

/** The platform's code for "this service stack already has a variable under that key". */
const USER_DATA_DUPLICATE_KEY = 'userDataDuplicateKey'

/** The platform's code for a service stack it cannot find — sent with a 400, not a 404. */
const ZEROPS_SERVICE_STACK_NOT_FOUND = 'serviceStackNotFound'

const timerSleep: Sleeper = (ms, signal) =>
	new Promise<void>((resolve) => {
		if (signal.aborted) {
			resolve()
			return
		}
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort)
			resolve()
		}, ms)
		const onAbort = (): void => {
			clearTimeout(timer)
			resolve()
		}
		signal.addEventListener('abort', onAbort, { once: true })
	})

/** Build the real client. Every request carries the bearer and the run's signal. */
export const createZeropsApi = (options: ZeropsApiOptions): ZeropsApi => {
	const base = (options.baseUrl ?? ZEROPS_API_BASE).replace(/\/+$/, '')
	const doFetch = options.fetchImpl ?? fetch
	// Its own, rather than `collaborators`' — that module imports this one, so taking the value back would close a cycle.
	const sleep = options.sleep ?? timerSleep
	const abortError = (): DOMException => new DOMException('The operation was aborted', 'AbortError')
	const isAbortError = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError'
	const SERVICE_ENV_RESPONSE_MAX_BYTES = 8 * 1024 * 1024
	class ResponseByteBoundError extends Error {}

	const boundedJson = async (response: Response, label: string, maxBytes: number, signal: AbortSignal): Promise<unknown> => {
		if (signal.aborted) {
			void response.body?.cancel().catch(() => {})
			throw abortError()
		}
		const contentLength = response.headers.get('content-length')
		if (contentLength !== null) {
			const declaredBytes = Number(contentLength)
			if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
				void response.body?.cancel().catch(() => {})
				throw new ResponseByteBoundError(`zerops: ${label} response exceeded its byte bound`)
			}
		}
		if (response.body === null) return null
		const reader = response.body.getReader()
		let abortRead = (): void => {}
		const aborted = new Promise<never>((_resolve, reject) => {
			abortRead = (): void => {
				void reader.cancel().catch(() => {})
				reject(abortError())
			}
			signal.addEventListener('abort', abortRead, { once: true })
			if (signal.aborted) abortRead()
		})
		const chunks: Uint8Array[] = []
		let receivedBytes = 0
		try {
			while (true) {
				const next = await Promise.race([reader.read(), aborted])
				if (signal.aborted) throw abortError()
				if (next.done) break
				receivedBytes += next.value.byteLength
				if (receivedBytes > maxBytes) {
					void reader.cancel().catch(() => {})
					throw new ResponseByteBoundError(`zerops: ${label} response exceeded its byte bound`)
				}
				chunks.push(next.value)
			}
		} finally {
			signal.removeEventListener('abort', abortRead)
		}
		const bytes = new Uint8Array(receivedBytes)
		let offset = 0
		for (const chunk of chunks) {
			bytes.set(chunk, offset)
			offset += chunk.byteLength
		}
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
	}

	const request = async (
		label: string,
		method: string,
		path: string,
		/**
		 * `redactDetail` drops the server's message from the thrown error, keeping only its code. Set it on
		 * any call whose BODY carries a secret value: a validation error can quote what it rejected, and an
		 * error that echoes a secret into a deploy log is a leak whichever end wrote it.
		 * `omitErrorResponseDetails` also drops the code for upload flows whose response may carry a
		 * credential; nothing from that response body may reach an error.
		 */
		init: {
			body?: unknown
			signal: AbortSignal
			redactDetail?: boolean
			omitErrorResponseDetails?: boolean
			/** Pretrigger reservation cleanup needs verified absence, never arbitrary response text or codes. */
			preserveAppVersionNotFound?: boolean
			responseMaxBytes?: number
		},
	): Promise<unknown> => {
		if (init.signal.aborted) {
			throw abortError()
		}
		const headers: Record<string, string> = { authorization: `Bearer ${options.token}`, accept: 'application/json' }
		if (init.body !== undefined) {
			headers['content-type'] = 'application/json'
		}
		let response: Response
		try {
			response = await doFetch(`${base}${path}`, {
				method,
				headers,
				body: init.body === undefined ? undefined : JSON.stringify(init.body),
				signal: init.signal,
			})
		} catch (error) {
			if (init.signal.aborted || isAbortError(error)) throw abortError()
			throw error
		}
		let payload: unknown
		try {
			payload = init.responseMaxBytes === undefined
				? await response.json()
				: await boundedJson(response, label, init.responseMaxBytes, init.signal)
		} catch (error) {
			if (init.signal.aborted || isAbortError(error)) throw abortError()
			if (error instanceof ResponseByteBoundError) throw error
			payload = null
		}
		if (!response.ok) {
			if (init.omitErrorResponseDetails === true) {
				if (init.preserveAppVersionNotFound === true && response.status === 400) {
					const error = prop(payload, 'error')
					const metadata = [...arr(payload, 'meta'), ...arr(error, 'meta')]
					if (
						str(error, 'code') === 'appVersionNotFound' || str(payload, 'code') === 'appVersionNotFound'
						|| (metadata.length === 1 && str(metadata[0], 'code') === 'appVersionNotFound')
					) {
						throw new ZeropsApiError(`zerops: ${label} failed (400) — appVersionNotFound`, 400, 'appVersionNotFound')
					}
				}
				throw new ZeropsApiError(`zerops: ${label} failed (${response.status})`, response.status, '')
			}
			throw apiError(label, response.status, payload, init.redactDetail === true)
		}
		return payload
	}

	const invalidResponse = (label: string): Error => new Error(`zerops: ${label} returned an invalid response`)

	const requiredString = (payload: unknown, key: string, label: string): string => {
		const value = str(payload, key)
		if (value === undefined || value.trim() === '') {
			throw invalidResponse(label)
		}
		return value
	}

	const readImportResult = (payload: unknown): ZeropsImportResult => ({
		projectId: str(payload, 'projectId') ?? '',
		projectName: str(payload, 'projectName'),
		services: arr(payload, 'serviceStacks').map((entry) => ({
			id: str(entry, 'id') ?? '',
			name: str(entry, 'name') ?? '',
			processes: arr(entry, 'processes').map(readProcess),
		})),
	})

	const PAGE_SIZE = 100
	const readAllPages = async <Item>(
		label: string,
		path: string,
		signal: AbortSignal,
		readItem: (value: unknown) => Item,
	): Promise<Item[]> => {
		const items: Item[] = []
		let offset = 0
		while (true) {
			const separator = path.includes('?') ? '&' : '?'
			const payload = await request(label, 'GET', `${path}${separator}limit=${PAGE_SIZE}&offset=${offset}`, { signal })
			const page = arr(payload, 'list')
			const totalCount = num(payload, 'totalCount')
			if (totalCount === undefined || !Number.isInteger(totalCount) || totalCount < 0) {
				throw new Error(`zerops: ${label} returned an invalid totalCount`)
			}
			items.push(...page.map(readItem))
			if (items.length >= totalCount) {
				return items
			}
			if (page.length === 0) {
				throw new Error(`zerops: ${label} ended before totalCount`)
			}
			offset += page.length
		}
	}

	/**
	 * Named so `putServiceEnv` can reach it: the conflict path needs the record id, and the ONE endpoint
	 * that hands it over on every service is `/env` (`/user-data` answers 400 unconditionally).
	 */
	const listServiceEnv: ZeropsApi['listServiceEnv'] = async ({ serviceId, signal }) => {
		const payload = await request('list service env', 'GET', `/service-stack/${serviceId}/env`, {
			signal,
			responseMaxBytes: SERVICE_ENV_RESPONSE_MAX_BYTES,
		})
		try {
			return parseServiceEnvResponse(payload, serviceId)
		} catch {
			throw invalidResponse('list service env')
		}
	}

	const getProcess: ZeropsApi['getProcess'] = async ({ processId, signal }) =>
		readProcess(await request('get process', 'GET', `/process/${processId}`, { signal }))

	/**
	 * Wait out the `stack.updateUserData` process every user-data write answers with.
	 *
	 * While one runs the platform refuses the NEXT operation on that service with `400
	 * userDataSyncRunning` — which is how a deploy that wrote an app's environment and then asked for a
	 * build failed, one second before the sync it had started finished. Measured live: PENDING → RUNNING →
	 * FINISHED in about three seconds, on a deployed service and on one that has never had code alike.
	 *
	 * The response is recognised by `actionName`, not by having an `id`: a user-data RECORD carries an id
	 * too, and polling `/process/{recordId}` would hang instead of failing. An unrecognised response is
	 * left alone — nothing then says the write is still settling.
	 */
	const awaitUserDataSync = async (payload: unknown, label: string, signal: AbortSignal): Promise<void> => {
		const processId = str(payload, 'id')
		const action = str(payload, 'actionName')
		if (processId === undefined || processId.trim() === '' || action === undefined || action.trim() === '') {
			return
		}
		await waitForProcess({ api: { getProcess }, processId, sleep, signal, label })
	}

	return {
		importServices: async ({ projectId, yaml, signal }) =>
			readImportResult(await request('service-stack import', 'POST', `/project/${projectId}/service-stack/import`, { body: { yaml }, signal })),

		importProject: async ({ clientId, yaml, signal }) =>
			readImportResult(await request('project import', 'POST', `/client/${clientId}/project/import`, { body: { yaml }, signal })),

		triggerPipeline: async ({ serviceId, buildFromGit, zeropsYaml, zeropsSetup, signal }) => {
			const body: Record<string, unknown> = {}
			if (buildFromGit !== undefined) {
				body['buildFromGit'] = buildFromGit
			}
			if (zeropsYaml !== undefined) {
				body['zeropsYaml'] = zeropsYaml
			}
			if (zeropsSetup !== undefined) {
				body['zeropsSetup'] = zeropsSetup
			}
			const payload = await request('trigger-pipeline', 'PUT', `/service-stack/${serviceId}/trigger-pipeline`, { body, signal })
			const process = prop(payload, 'process')
			return process === undefined || process === null ? null : readProcess(process)
		},

		createAppVersion: async ({ serviceId, name, signal }) => {
			const body = name === undefined ? {} : { name }
			const payload = await request('create app-version', 'POST', `/service-stack/${serviceId}/app-version`, {
				body,
				signal,
				omitErrorResponseDetails: true,
			})
			const responseServiceId = requiredString(payload, 'serviceStackId', 'create app-version')
			if (responseServiceId !== serviceId) {
				throw invalidResponse('create app-version')
			}
			return {
				id: requiredString(payload, 'id', 'create app-version'),
				uploadUrl: requiredString(payload, 'uploadUrl', 'create app-version'),
			}
		},

		buildAndDeployAppVersion: async ({ appVersionId, zeropsYaml, zeropsYamlSetup, signal }) => {
			const body = zeropsYamlSetup === undefined ? { zeropsYaml } : { zeropsYaml, zeropsYamlSetup }
			// `redactDetail`, not `omitErrorResponseDetails`: this request body is the app's COMMITTED
			// descriptor and this response carries no upload URL, so there is nothing here to protect by
			// dropping the code as well — and a bare `(400)` is what made `userDataSyncRunning` cost a day.
			const payload = await request('build and deploy app-version', 'PUT', `/app-version/${appVersionId}/build-and-deploy`, {
				body,
				signal,
				redactDetail: true,
			})
			const processId = requiredString(payload, 'id', 'build and deploy app-version')
			const responseAppVersionId = str(prop(payload, 'appVersion'), 'id')
			if (responseAppVersionId !== undefined && (responseAppVersionId.trim() === '' || responseAppVersionId !== appVersionId)) {
				throw invalidResponse('build and deploy app-version')
			}
			return { ...readProcess(payload), id: processId, appVersionId }
		},

		deleteAppVersion: async ({ appVersionId, signal }) => {
			const payload = await request('delete app-version', 'DELETE', `/app-version/${appVersionId}`, {
				signal,
				omitErrorResponseDetails: true,
				preserveAppVersionNotFound: true,
			})
			if (prop(payload, 'success') !== true) {
				throw invalidResponse('delete app-version')
			}
		},

		getAppVersion: async ({ appVersionId, signal }) =>
			readAppVersion(await request('get app-version', 'GET', `/app-version/${appVersionId}`, { signal })),

		latestAppVersion: async ({ serviceId, signal }) => {
			const payload = await request('list app-versions', 'GET', `/service-stack/${serviceId}/app-version?limit=25`, { signal })
			const versions = arr(payload, 'list').map(readAppVersion)
			// Highest `sequence` wins — the list's order is not documented, the sequence's meaning is.
			return versions.reduce<ZeropsAppVersion | null>(
				(best, version) => (best === null || (version.sequence ?? -1) > (best.sequence ?? -1) ? version : best),
				null,
			)
		},

		cancelBuild: async ({ appVersionId, signal }) => {
			await request('cancel-build', 'PUT', `/app-version/${appVersionId}/cancel-build`, { signal })
		},

		getProcess,

		enableSubdomainAccess: async ({ serviceId, signal }) => {
			// No body: the operation takes none, and sending one would add a content-type the platform did not ask for.
			await request('enable subdomain access', 'PUT', `/service-stack/${serviceId}/enable-subdomain-access`, { signal })
		},

		getService: async ({ serviceId, signal }) => readService(await request('get service', 'GET', `/service-stack/${serviceId}`, { signal })),

		findService: async ({ projectId, hostname, signal }) => {
			try {
				return readService(await request('find service', 'GET', `/service-stack-by-name/${projectId}/${encodeURIComponent(hostname)}`, { signal }))
			} catch (error) {
				// A missing service is an answer, not a failure; anything else propagates. The live platform
				// says it as 400 `serviceStackNotFound` (docs/reference/zerops-platform.md), not as a 404.
				if (error instanceof ZeropsApiError && (error.status === 404 || error.code === ZEROPS_SERVICE_STACK_NOT_FOUND)) {
					return null
				}
				throw error
			}
		},

		getProject: async ({ projectId, signal }) => {
			const payload = await request('get project', 'GET', `/project/${projectId}`, { signal })
			return readProject(payload)
		},

		listProjects: async ({ clientId, signal }) => readAllPages('list projects', `/client/${clientId}/project`, signal, readProject),

		findProjects: async ({ clientId, name, signal }) => {
			const payload = await request(
				'find projects',
				'GET',
				`/client/${clientId}/projects-by-name/${encodeURIComponent(name)}`,
				{ signal },
			)
			return arr(payload, 'projects').map(readProject)
		},

		listProjectServices: async ({ projectId, signal }) =>
			readAllPages('list project services', `/project/${projectId}/service-stack`, signal, readService),

		listServiceEnv,

		createServiceEnv: async ({ serviceId, key, value, signal }) => {
			let started: unknown
			try {
				started = await request('create-only service env', 'POST', `/service-stack/${serviceId}/user-data`, {
					body: { key, content: value, sensitive: SENSITIVE_USER_DATA },
					signal,
					omitErrorResponseDetails: true,
				})
			} catch (error) {
				if (error instanceof Error && error.name === 'AbortError') throw error
				throw new Error('zerops: create-only service env failed')
			}
			await awaitUserDataSync(started, `the user-data sync on service ${serviceId}`, signal)
		},

		putServiceEnv: async ({ serviceId, key, value, signal }) => {
			const label = `the user-data sync on service ${serviceId}`
			// `redactDetail` on both writes: this is the one place a secret VALUE is in the request body.
			try {
				const created = await request('create service env', 'POST', `/service-stack/${serviceId}/user-data`, {
					body: { key, content: value, sensitive: SENSITIVE_USER_DATA },
					signal,
					redactDetail: true,
				})
				await awaitUserDataSync(created, label, signal)
				return
			} catch (error) {
				if (!(error instanceof ZeropsApiError) || error.code !== USER_DATA_DUPLICATE_KEY) {
					throw error
				}
			}
			// Only the conflict reads, and only then: the create must work on a service that has never been
			// deployed, which is the whole of ADR-0004's bring-up order.
			const existing = (await listServiceEnv({ serviceId, signal })).find((entry) => entry.key === key)
			if (existing === undefined || existing.id === '') {
				// The service declares the key in its own `zerops.yaml` (`type: ENV`), which conflicts on create
				// yet never appears in the env list. Replacing it here would be undone by the next deploy.
				throw new Error(
					`zerops: service ${serviceId} already defines \`${key}\` outside the environment API — it cannot be written`,
				)
			}
			const updated = await request('update service env', 'PUT', `/user-data/${existing.id}`, {
				body: { key, content: value, sensitive: SENSITIVE_USER_DATA },
				signal,
				redactDetail: true,
			})
			await awaitUserDataSync(updated, label, signal)
		},

		deleteServiceEnv: async ({ envId, signal }) => {
			const deleted = await request('delete service env', 'DELETE', `/user-data/${envId}`, { signal })
			await awaitUserDataSync(deleted, `the user-data sync for record ${envId}`, signal)
		},

		getProjectEnv: async ({ projectEnvId, signal }) =>
			readServiceEnv(await request('get project env', 'GET', `/project-env/${projectEnvId}`, { signal })),

		createIntegrationToken: async ({ clientId, name, projects, roleCode, canCreateProjects, signal }) =>
			// `redactDetail`: unlike every other write here the SECRET is in the RESPONSE, not the request, so
			// this is the one error envelope that could quote a minted token back at us.
			readIntegrationToken(
				await request('create integration token', 'POST', `/client/${clientId}/integration-token`, {
					body: {
						name,
						roleCode: roleCode ?? 'NO_ACCESS',
						// Always sent, like `roleCode`: a security-relevant field that never reaches the wire is a
						// field nobody can review.
						canCreateProjects: canCreateProjects ?? false,
						projects: projects.map((grant) => ({ projectId: grant.projectId, roleCode: grant.roleCode })),
					},
					signal,
					redactDetail: true,
				}),
			),

		getLogAccess: async ({ projectId, signal }) => {
			const payload = await request('get log access', 'GET', `/project/${projectId}/log`, { signal })
			return {
				url: str(payload, 'url') ?? '',
				urlPlain: str(payload, 'urlPlain') ?? '',
				urlInfo: str(payload, 'urlInfo') ?? '',
				urlUi: str(payload, 'urlUi') ?? '',
				accessToken: str(payload, 'accessToken') ?? '',
				expiration: str(payload, 'expiration') ?? '',
			}
		},

		readBuildLog: async ({ access, serviceId, appVersionId, since, limit, signal }) => {
			if (access.urlPlain === '') {
				return []
			}
			const separator = access.urlPlain.includes('?') ? '&' : '?'
			const readWindow = async (terms: string): Promise<{ lines: ZeropsLogLine[]; error: unknown }> => {
				try {
					const url = `${access.urlPlain}${separator}${terms}&limit=${limit ?? 200}`
					const response = await doFetch(url, { headers: { authorization: `Bearer ${access.accessToken}` }, signal })
					if (!response.ok) {
						throw new Error(`zerops: read build log failed (${response.status})`)
					}
					const text = await response.text()
					const lines = text.split('\n').filter((line) => line.trim() !== '').map((line) => {
						const head = line.slice(0, Math.max(line.indexOf(' '), 0))
						return LOG_LINE_TIMESTAMP.test(head) ? { timestamp: head, message: line } : { message: line }
					})
					return { lines, error: undefined }
				} catch (error) {
					return { lines: [], error }
				}
			}
			// Selected by tag alone: the build runs on a builder stack, so pairing the tag with the runtime
			// service id matches nothing (see the interface).
			const build = appVersionId === undefined ? undefined : await readWindow(`tags=${encodeURIComponent(`zbuilder@${appVersionId}`)}`)
			const runtime = since === undefined ? undefined : await readWindow(`serviceStackId=${encodeURIComponent(serviceId)}`)
			const attempted = [build, runtime].filter((result) => result !== undefined)
			if (attempted.length === 0) {
				return []
			}
			// Independent windows: only a failure of every one attempted is worth raising.
			const failure = attempted.find((result) => result.error !== undefined)
			if (failure !== undefined && attempted.every((result) => result.error !== undefined)) {
				throw failure.error
			}
			const boundary = since === undefined ? Number.NaN : Date.parse(since)
			// The runtime window carries every version that ever ran, so a line the driver cannot date is dropped.
			const runtimeLines = runtime === undefined || Number.isNaN(boundary)
				? runtime?.lines ?? []
				: runtime.lines.filter((line) => line.timestamp !== undefined && Date.parse(line.timestamp) >= boundary)
			return [...build?.lines ?? [], ...runtimeLines]
		},
	}
}
