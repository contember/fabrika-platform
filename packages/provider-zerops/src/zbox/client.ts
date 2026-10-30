import type { z } from 'zod'
import { isZboxNotFound, ZboxApiError, zboxErrorCode, zboxOperationErrorCode, ZboxOperationFailed } from './errors'
import {
	type ZboxAwaitOptions,
	zboxBaseListSchema,
	type ZboxBody,
	type ZboxClient,
	type ZboxClientOptions,
	zboxExecResultSchema,
	type ZboxOperation,
	zboxOperationSchema,
	type ZboxSandbox,
	zboxSandboxListSchema,
	zboxSandboxSchema,
	zboxSessionSchema,
	zboxSpawnSchema,
	zboxSuccessSchema,
	zboxWorkspaceSchema,
} from './types'

/** Box cuts a request off at 60 s; giving up first leaves the error ours to name. */
const REQUEST_TIMEOUT_MS = 55_000

/** The longest `waitSeconds` Box honours. */
const MAX_WAIT_SECONDS = 30

/** How long a create, park, wake or delete may take before the client stops waiting. Measured: all under 2 s. */
const OPERATION_DEADLINE_MS = 120_000

interface CallInit {
	json?: unknown
	body?: ZboxBody
	idempotencyKey?: string
	signal: AbortSignal | undefined
}

export const createZboxClient = (options: ZboxClientOptions): ZboxClient => {
	const base = `${options.baseUrl.replace(/\/+$/, '')}/api/rest`
	const doFetch = options.fetch ?? fetch
	const nextIdempotencyKey = options.idempotencyKey ?? (() => crypto.randomUUID())

	const errorBody = async (response: Response): Promise<unknown> => {
		try {
			return JSON.parse(await response.text())
		} catch {
			return null
		}
	}

	const call = async <Result>(
		operation: string,
		method: string,
		path: string,
		init: CallInit,
		read: (response: Response) => Promise<Result>,
	): Promise<Result> => {
		init.signal?.throwIfAborted()
		const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		const signal = init.signal === undefined ? timeout : AbortSignal.any([init.signal, timeout])
		const headers: Record<string, string> = { authorization: `Bearer ${options.apiKey}`, accept: 'application/json' }
		if (init.idempotencyKey !== undefined) {
			headers['idempotency-key'] = init.idempotencyKey
		}
		let body: string | ZboxBody | undefined
		if (init.json !== undefined) {
			headers['content-type'] = 'application/json'
			body = JSON.stringify(init.json)
		} else if (init.body !== undefined) {
			headers['content-type'] = 'application/octet-stream'
			body = init.body
		}
		try {
			const response = await doFetch(`${base}${path}`, { method, headers, body, signal })
			if (!response.ok) {
				throw new ZboxApiError(operation, response.status, zboxErrorCode(response.status, await errorBody(response)))
			}
			return await read(response)
		} catch (error) {
			if (error instanceof ZboxApiError) throw error
			init.signal?.throwIfAborted()
			// The fetch error is dropped: its text is the runtime's, and nothing here may echo a request.
			throw new ZboxApiError(operation, 0, timeout.aborted ? 'timeout' : 'unreachable')
		}
	}

	const json = <Output>(operation: string, schema: z.ZodType<Output, z.ZodTypeDef, unknown>) => async (response: Response): Promise<Output> => {
		let value: unknown
		try {
			value = JSON.parse(await response.text())
		} catch {
			throw new ZboxApiError(operation, response.status, 'unreadable')
		}
		const parsed = schema.safeParse(value)
		if (!parsed.success) {
			throw new ZboxApiError(operation, response.status, 'unreadable')
		}
		return parsed.data
	}

	const bytes = async (response: Response): Promise<Uint8Array> => new Uint8Array(await response.arrayBuffer())

	const sandboxPath = (id: string, suffix = ''): string => `/sandbox/${encodeURIComponent(id)}${suffix}`

	const getOperation = (id: string, waitSeconds: number, signal?: AbortSignal): Promise<ZboxOperation> => {
		const wait = Math.max(0, Math.min(MAX_WAIT_SECONDS, Math.floor(waitSeconds)))
		return call(
			'get operation',
			'GET',
			`/operation/${encodeURIComponent(id)}?waitSeconds=${wait}`,
			{ signal },
			json('get operation', zboxOperationSchema),
		)
	}

	const awaitOperation = async (operation: ZboxOperation, awaitOptions: ZboxAwaitOptions): Promise<ZboxOperation> => {
		const startedAt = Date.now()
		let current = operation
		while (true) {
			if (current.status === 'FINISHED') return current
			if (current.status === 'FAILED') {
				throw new ZboxOperationFailed(current.kind, current.id, zboxOperationErrorCode(current.error))
			}
			awaitOptions.signal?.throwIfAborted()
			const remainingMs = awaitOptions.deadlineMs - (Date.now() - startedAt)
			if (remainingMs <= 0) {
				throw new ZboxApiError(`await ${current.kind} operation`, 0, 'timeout')
			}
			current = await getOperation(current.id, Math.max(1, Math.min(MAX_WAIT_SECONDS, Math.floor(remainingMs / 1000))), awaitOptions.signal)
		}
	}

	const getSandbox = (id: string, signal?: AbortSignal): Promise<ZboxSandbox> =>
		call('get sandbox', 'GET', sandboxPath(id), { signal }, json('get sandbox', zboxSandboxSchema))

	const sandboxOperation = async (operation: string, id: string, suffix: string, payload: unknown, signal?: AbortSignal): Promise<ZboxOperation> => {
		const started = await call(
			operation,
			'POST',
			sandboxPath(id, suffix),
			{ json: payload, idempotencyKey: nextIdempotencyKey(), signal },
			json(operation, zboxOperationSchema),
		)
		return awaitOperation(started, { signal, deadlineMs: OPERATION_DEADLINE_MS })
	}

	return {
		getWorkspace: (signal) => call('get workspace', 'GET', '/workspace', { signal }, json('get workspace', zboxWorkspaceSchema)),

		pullBase: ({ imageRef, name }, signal) =>
			call(
				'pull base',
				'POST',
				'/base',
				{ json: { imageRef, name }, idempotencyKey: nextIdempotencyKey(), signal },
				json('pull base', zboxOperationSchema),
			),

		buildBase: ({ context, name }, signal) =>
			call('build base', 'POST', `/base-build?name=${encodeURIComponent(name)}`, { body: context, signal }, json('build base', zboxOperationSchema)),

		listBases: async (signal) => (await call('list bases', 'GET', '/base-list', { signal }, json('list bases', zboxBaseListSchema))).items,

		getOperation,

		awaitOperation,

		createSandbox: async (input, signal) => {
			const spawn = await call(
				'create sandbox',
				'POST',
				'/sandbox',
				{
					json: {
						name: input.name,
						baseDigest: input.baseDigest,
						cpus: input.cpus,
						memoryBytes: input.memoryBytes,
						networkMode: input.networkMode,
						integrations: [],
						launch: { entrypoint: input.launch.entrypoint, cmd: input.launch.cmd, workingDir: input.launch.workingDir },
						policy: {
							ingress: {
								ports: input.ports.map(({ port, access, wakeOnRequest }) => ({ port, access, protocol: 'HTTP', wakeOnRequest })),
							},
							secrets: { mode: 'NONE' },
						},
						waitSeconds: MAX_WAIT_SECONDS,
					},
					idempotencyKey: input.idempotencyKey,
					signal,
				},
				json('create sandbox', zboxSpawnSchema),
			)
			const [created, ...others] = spawn.sandboxes
			if (created === undefined || others.length > 0) {
				throw new ZboxApiError('create sandbox', 200, 'unreadable')
			}
			const operation = await awaitOperation(spawn.operation, { signal, deadlineMs: OPERATION_DEADLINE_MS })
			// A create answered before it finished carries the CREATING row; read the final one.
			const sandbox = spawn.operation.status === 'FINISHED' ? created : await getSandbox(created.id, signal)
			return { operation, sandbox }
		},

		getSandbox,

		findSandboxByName: async (name, signal) => {
			const list = await call('list sandboxes', 'GET', '/sandbox-list', { signal }, json('list sandboxes', zboxSandboxListSchema))
			// Box refuses a create whose name a live sandbox holds, so at most one live sandbox matches.
			return list.items.find((sandbox) => sandbox.name === name) ?? null
		},

		deleteSandbox: async (id, idempotencyKey, signal) => {
			let started: ZboxOperation
			try {
				started = await call('delete sandbox', 'DELETE', sandboxPath(id), { idempotencyKey, signal }, json('delete sandbox', zboxOperationSchema))
			} catch (error) {
				if (isZboxNotFound(error) && error.code === 'sandboxNotFound') return
				throw error
			}
			await awaitOperation(started, { signal, deadlineMs: OPERATION_DEADLINE_MS })
		},

		park: (id, { memory }, signal) => sandboxOperation('park sandbox', id, '/park', { memory }, signal),

		wake: (id, signal) => sandboxOperation('wake sandbox', id, '/wake', {}, signal),

		exec: (id, { command, workingDir, timeoutSeconds }, signal) =>
			call('exec', 'POST', sandboxPath(id, '/exec'), { json: { command, workingDir, timeoutSeconds }, signal }, json('exec', zboxExecResultSchema)),

		startProcess: (id, { command, workingDir }, signal) =>
			call('start process', 'POST', sandboxPath(id, '/process'), { json: { command, workingDir }, signal }, json('start process', zboxSessionSchema)),

		getSession: (id, signal) => call('get session', 'GET', `/session/${encodeURIComponent(id)}`, { signal }, json('get session', zboxSessionSchema)),

		sessionOutput: (id, signal) => call('get session output', 'GET', `/session/${encodeURIComponent(id)}/output`, { signal }, bytes),

		putFile: async (id, path, body, putOptions) => {
			const mode = putOptions?.mode === undefined ? '' : `&mode=${encodeURIComponent(putOptions.mode)}`
			await call(
				'put file',
				'PUT',
				sandboxPath(id, `/file?path=${encodeURIComponent(path)}${mode}`),
				{ body, signal: putOptions?.signal },
				json('put file', zboxSuccessSchema),
			)
		},

		getFile: async (id, path, signal) => {
			try {
				return await call('get file', 'GET', sandboxPath(id, `/file?path=${encodeURIComponent(path)}`), { signal }, bytes)
			} catch (error) {
				// Only a missing PATH is an absent file; a missing sandbox stays an error.
				if (isZboxNotFound(error) && error.code === 'pathNotFound') return null
				throw error
			}
		},
	}
}
