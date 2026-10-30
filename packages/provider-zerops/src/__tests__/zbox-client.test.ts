import { describe, expect, test } from 'bun:test'
import {
	createZboxClient,
	isZboxNotFound,
	isZboxTooLarge,
	isZboxWorkspaceFull,
	ZboxApiError,
	type ZboxBody,
	type ZboxCreateSandboxInput,
	type ZboxFetch,
	ZboxOperationFailed,
	type ZboxSandbox,
} from '../zbox'

const SECRET = 'postgresql://postgres:hunter2-fake-secret@db:5432/app'

interface Call {
	url: string
	method: string
	headers: Record<string, string>
	body: string | ZboxBody | undefined
	signal: AbortSignal
}

const jsonResponse = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const boxError = (status: number, code: string): Response => jsonResponse({ error: { code, message: `refused: ${SECRET}`, meta: [] } }, status)

const operation = (overrides: Record<string, unknown> = {}) => ({
	id: 'op-1',
	sandboxId: 'sb-1',
	parentId: null,
	kind: 'CREATE',
	status: 'FINISHED',
	result: null,
	error: null,
	created: '2026-10-28T11:14:04.102319Z',
	finished: null,
	...overrides,
})

const sandbox = (overrides: Record<string, unknown> = {}) => ({
	id: 'sb-1',
	lineageId: 'lin-1',
	name: 'ws-1',
	baseDigest: 'sha256:abc',
	status: 'RUNNING',
	networkMode: 'INTERNET',
	policy: { ingress: { ports: [] } },
	policyGeneration: 1,
	launchContract: { envNames: ['FABRIKA_APP_DATABASE_URL'] },
	memoryBytes: 2147483648,
	cpus: 2,
	secretBearing: false,
	secretsStale: false,
	hosts: [{ port: 3000, access: 'PROJECT', url: 'https://3000-sb-1.box.test' }],
	lastActivity: '2026-10-28T11:14:04Z',
	created: '2026-10-28T11:14:04Z',
	updated: '2026-10-28T11:14:04Z',
	...overrides,
})

const expectedSandbox: ZboxSandbox = {
	id: 'sb-1',
	name: 'ws-1',
	status: 'RUNNING',
	baseDigest: 'sha256:abc',
	hosts: [{ port: 3000, access: 'PROJECT', url: 'https://3000-sb-1.box.test' }],
	policyGeneration: 1,
}

/** A fake Box: answers each call in turn with the next responder and records the request. */
const fakeBox = (...responders: Array<(call: Call) => Response | Promise<Response>>) => {
	const calls: Call[] = []
	const fetch: ZboxFetch = async (url, init) => {
		const call: Call = { url, method: init.method, headers: init.headers, body: init.body, signal: init.signal }
		calls.push(call)
		const responder = responders[calls.length - 1]
		if (responder === undefined) throw new Error(`unexpected request ${init.method} ${url}`)
		return responder(call)
	}
	let keys = 0
	const client = createZboxClient({
		baseUrl: 'https://zbox.test/',
		apiKey: 'box-api-key',
		fetch,
		idempotencyKey: () => {
			keys += 1
			return `generated-${keys}`
		},
	})
	return { client, calls }
}

const jsonBody = (call: Call | undefined): unknown => {
	if (typeof call?.body !== 'string') throw new Error('expected a JSON body')
	return JSON.parse(call.body)
}

const caught = async (promise: Promise<unknown>): Promise<unknown> => {
	try {
		await promise
	} catch (error) {
		return error
	}
	throw new Error('expected a rejection')
}

const expectNoBodyText = (error: unknown): void => {
	expect(error).toBeInstanceOf(Error)
	if (!(error instanceof Error)) return
	for (const text of [String(error), error.message, JSON.stringify(error)]) {
		expect(text).not.toContain('hunter2')
		expect(text).not.toContain('refused')
		expect(text).not.toContain('<html')
	}
}

const createInput: ZboxCreateSandboxInput = {
	name: 'ws-1',
	baseDigest: 'sha256:abc',
	cpus: 2,
	memoryBytes: 2147483648,
	networkMode: 'INTERNET',
	launch: { entrypoint: ['/bin/sh', '-c'], cmd: ['sleep infinity'], workingDir: '/app' },
	ports: [{ port: 3000, access: 'PROJECT', wakeOnRequest: true }],
	idempotencyKey: 'create-key-1',
}

describe('zbox client requests', () => {
	test('every request carries the bearer; idempotency keys go only where Box requires them', async () => {
		const { client, calls } = fakeBox(
			() => jsonResponse({ version: '1', domains: [], capacity: {} }),
			() => jsonResponse({ items: [] }),
			() => jsonResponse(sandbox()),
			() => jsonResponse(operation({ kind: 'PULL_BASE' })),
			() => jsonResponse(operation({ kind: 'PARK' })),
			() => jsonResponse(operation({ kind: 'WAKE' })),
			() => jsonResponse(operation({ kind: 'TERMINATE' })),
			() => jsonResponse({ sessionId: 's', stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, timedOut: false, exitCode: 0 }),
			() => jsonResponse(operation({ kind: 'BUILD_BASE' })),
		)

		await client.getWorkspace()
		await client.listBases()
		await client.getSandbox('sb-1')
		await client.pullBase({ imageRef: 'ghcr.io/x/y:1', name: 'dev' })
		await client.park('sb-1', { memory: true })
		await client.wake('sb-1')
		await client.deleteSandbox('sb-1', 'delete-key-1')
		await client.exec('sb-1', { command: ['true'] })
		await client.buildBase({ context: new Uint8Array([1, 2, 3]), name: 'dev' })

		expect(calls.map((call) => `${call.method} ${call.url} ${call.headers['idempotency-key'] ?? '-'}`)).toEqual([
			'GET https://zbox.test/api/rest/workspace -',
			'GET https://zbox.test/api/rest/base-list -',
			'GET https://zbox.test/api/rest/sandbox/sb-1 -',
			'POST https://zbox.test/api/rest/base generated-1',
			'POST https://zbox.test/api/rest/sandbox/sb-1/park generated-2',
			'POST https://zbox.test/api/rest/sandbox/sb-1/wake generated-3',
			'DELETE https://zbox.test/api/rest/sandbox/sb-1 delete-key-1',
			'POST https://zbox.test/api/rest/sandbox/sb-1/exec -',
			'POST https://zbox.test/api/rest/base-build?name=dev -',
		])
		for (const call of calls) {
			expect(call.headers['authorization']).toBe('Bearer box-api-key')
		}
		expect(jsonBody(calls[4])).toEqual({ memory: true })
		expect(calls[8]?.headers['content-type']).toBe('application/octet-stream')
	})

	test('createSandbox always pins secrets to NONE, builds the ingress ports, and sends the caller key', async () => {
		const { client, calls } = fakeBox(() => jsonResponse({ operation: operation(), sandboxes: [sandbox()] }))

		const result = await client.createSandbox(createInput)

		expect(result).toEqual({
			operation: { id: 'op-1', sandboxId: 'sb-1', kind: 'CREATE', status: 'FINISHED', error: null },
			sandbox: expectedSandbox,
		})
		expect(calls[0]?.headers['idempotency-key']).toBe('create-key-1')
		expect(jsonBody(calls[0])).toEqual({
			name: 'ws-1',
			baseDigest: 'sha256:abc',
			cpus: 2,
			memoryBytes: 2147483648,
			networkMode: 'INTERNET',
			integrations: [],
			launch: { entrypoint: ['/bin/sh', '-c'], cmd: ['sleep infinity'], workingDir: '/app' },
			policy: {
				ingress: { ports: [{ port: 3000, access: 'PROJECT', protocol: 'HTTP', wakeOnRequest: true }] },
				secrets: { mode: 'NONE' },
			},
			waitSeconds: 30,
		})
	})

	test('createSandbox still running after the wait polls the operation and reads the final sandbox', async () => {
		const { client, calls } = fakeBox(
			() => jsonResponse({ operation: operation({ status: 'RUNNING' }), sandboxes: [sandbox({ status: 'CREATING' })] }),
			() => jsonResponse(operation()),
			() => jsonResponse(sandbox()),
		)

		const result = await client.createSandbox(createInput)

		expect(result.sandbox).toEqual(expectedSandbox)
		expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
			'POST https://zbox.test/api/rest/sandbox',
			'GET https://zbox.test/api/rest/operation/op-1?waitSeconds=30',
			'GET https://zbox.test/api/rest/sandbox/sb-1',
		])
		expect(calls[1]?.headers['idempotency-key']).toBeUndefined()
	})

	test('findSandboxByName reads the live list and matches the name', async () => {
		const { client, calls } = fakeBox(
			() => jsonResponse({ items: [sandbox({ id: 'sb-0', name: 'other' }), sandbox()] }),
			() => jsonResponse({ items: [sandbox({ id: 'sb-0', name: 'other' })] }),
		)

		await expect(client.findSandboxByName('ws-1')).resolves.toEqual(expectedSandbox)
		await expect(client.findSandboxByName('ws-1')).resolves.toBeNull()
		expect(calls[0]?.url).toBe('https://zbox.test/api/rest/sandbox-list')
	})

	test('exec sends no env and maps the result', async () => {
		const { client, calls } = fakeBox(() =>
			jsonResponse({ sessionId: 's-1', stdout: 'ok', stderr: '', stdoutTruncated: false, stderrTruncated: true, timedOut: false, exitCode: 3 })
		)

		await expect(client.exec('sb-1', { command: ['sh', '-c', 'echo ok'], workingDir: '/app', timeoutSeconds: 50 })).resolves.toEqual({
			stdout: 'ok',
			stderr: '',
			exitCode: 3,
			timedOut: false,
			stdoutTruncated: false,
			stderrTruncated: true,
		})
		expect(jsonBody(calls[0])).toEqual({ command: ['sh', '-c', 'echo ok'], workingDir: '/app', timeoutSeconds: 50 })
	})

	test('processes, sessions and their recorded output', async () => {
		const session = {
			id: 'sess-1',
			sandboxId: 'sb-1',
			kind: 'EXEC',
			status: 'OPEN',
			hasOutput: true,
			created: 'x',
			command: { command: ['x'], envNames: ['K'] },
		}
		const { client, calls } = fakeBox(
			() => jsonResponse(session),
			() => jsonResponse({ ...session, status: 'CLOSED', exitCode: 0 }),
			() => new Response('line one\nline two\n'),
		)

		await expect(client.startProcess('sb-1', { command: ['sh', '-c', 'build'] })).resolves.toEqual({
			id: 'sess-1',
			status: 'OPEN',
			exitCode: null,
			hasOutput: true,
		})
		await expect(client.getSession('sess-1')).resolves.toEqual({ id: 'sess-1', status: 'CLOSED', exitCode: 0, hasOutput: true })
		expect(new TextDecoder().decode(await client.sessionOutput('sess-1'))).toBe('line one\nline two\n')
		expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
			'POST https://zbox.test/api/rest/sandbox/sb-1/process',
			'GET https://zbox.test/api/rest/session/sess-1',
			'GET https://zbox.test/api/rest/session/sess-1/output',
		])
		expect(jsonBody(calls[0])).toEqual({ command: ['sh', '-c', 'build'] })
	})
})

describe('zbox client files', () => {
	test('putFile streams the body as octet-stream with the path and mode in the query', async () => {
		const chunks = [new TextEncoder().encode('KEY='), new TextEncoder().encode('value\n')]
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk)
				controller.close()
			},
		})
		let received = ''
		const { client, calls } = fakeBox(async (call) => {
			received = await new Response(call.body).text()
			return jsonResponse({ success: true })
		})

		await client.putFile('sb-1', '/app/.env file', stream, { mode: '0600' })

		expect(calls[0]?.method).toBe('PUT')
		expect(calls[0]?.url).toBe('https://zbox.test/api/rest/sandbox/sb-1/file?path=%2Fapp%2F.env%20file&mode=0600')
		expect(calls[0]?.body).toBe(stream)
		expect(calls[0]?.headers['content-type']).toBe('application/octet-stream')
		expect(calls[0]?.headers['idempotency-key']).toBeUndefined()
		expect(received).toBe('KEY=value\n')
	})

	test('an upload over the limit is TooLarge, and the nginx page stays out of the error', async () => {
		const { client } = fakeBox(() => new Response(`<html><body>413 Request Entity Too Large ${SECRET}</body></html>`, { status: 413 }))

		const error = await caught(client.putFile('sb-1', '/app/source.tgz', new Uint8Array(4)))

		expect(isZboxTooLarge(error)).toBe(true)
		expect(error).toMatchObject({ status: 413, code: 'http_413' })
		expectNoBodyText(error)
	})

	test('getFile answers the bytes, null for a missing path, and an error for a missing sandbox', async () => {
		const { client, calls } = fakeBox(
			() => new Response(new Uint8Array([1, 2, 3])),
			() => boxError(404, 'pathNotFound'),
			() => boxError(404, 'sandboxNotFound'),
		)

		expect(await client.getFile('sb-1', '/tmp/booted')).toEqual(new Uint8Array([1, 2, 3]))
		await expect(client.getFile('sb-1', '/tmp/booted')).resolves.toBeNull()
		const error = await caught(client.getFile('sb-1', '/tmp/booted'))
		expect(isZboxNotFound(error)).toBe(true)
		expect(error).toMatchObject({ code: 'sandboxNotFound' })
		expect(calls[0]?.url).toBe('https://zbox.test/api/rest/sandbox/sb-1/file?path=%2Ftmp%2Fbooted')
	})
})

describe('zbox client errors', () => {
	test('a Box error JSON maps to its code and nothing of its message', async () => {
		const { client } = fakeBox(() => boxError(409, 'workspaceFull'))

		const error = await caught(client.createSandbox(createInput))

		expect(error).toBeInstanceOf(ZboxApiError)
		expect(isZboxWorkspaceFull(error)).toBe(true)
		expect(error).toMatchObject({ status: 409, code: 'workspaceFull', message: 'zbox: create sandbox failed (409 workspaceFull)' })
		expectNoBodyText(error)
	})

	test('the bare OpenAPI error shape is read too, and a code that is not an identifier is not trusted', async () => {
		const { client } = fakeBox(
			() => jsonResponse({ code: 'invalidUserInput', message: SECRET }, 400),
			() => jsonResponse({ error: { code: `bad ${SECRET}` } }, 400),
		)

		const bare = await caught(client.getSandbox('sb-1'))
		expect(bare).toMatchObject({ status: 400, code: 'invalidUserInput' })
		const prose = await caught(client.getSandbox('sb-1'))
		expect(prose).toMatchObject({ status: 400, code: 'http_400' })
		expectNoBodyText(bare)
		expectNoBodyText(prose)
	})

	test('deleteSandbox resolves on sandboxNotFound and rejects any other 404', async () => {
		const { client, calls } = fakeBox(() => boxError(404, 'sandboxNotFound'), () => new Response('not found', { status: 404 }))

		await expect(client.deleteSandbox('sb-1', 'delete-key-1')).resolves.toBeUndefined()
		const error = await caught(client.deleteSandbox('sb-1', 'delete-key-2'))
		expect(error).toMatchObject({ status: 404, code: 'http_404' })
		expect(calls.map((call) => call.headers['idempotency-key'])).toEqual(['delete-key-1', 'delete-key-2'])
	})

	test('a success body that is not JSON, or does not match, is unreadable', async () => {
		const { client } = fakeBox(
			() => new Response(`not json ${SECRET}`),
			() => jsonResponse({ id: 'sb-1', status: 'RUNNING', note: SECRET }),
		)

		const notJson = await caught(client.getSandbox('sb-1'))
		expect(notJson).toMatchObject({ name: 'ZboxApiError', status: 200, code: 'unreadable' })
		const mismatch = await caught(client.getSandbox('sb-1'))
		expect(mismatch).toMatchObject({ status: 200, code: 'unreadable' })
		expectNoBodyText(notJson)
		expectNoBodyText(mismatch)
	})

	test('a network failure names the operation, not the runtime error', async () => {
		const { client } = fakeBox(() => {
			throw new Error(`connect failed ${SECRET}`)
		})

		const error = await caught(client.getWorkspace())
		expect(error).toMatchObject({ status: 0, code: 'unreachable', message: 'zbox: get workspace failed (unreachable)' })
		expectNoBodyText(error)
	})
})

describe('zbox operations', () => {
	test('awaitOperation long-polls until FINISHED', async () => {
		const { client, calls } = fakeBox(
			() => jsonResponse(operation({ status: 'RUNNING' })),
			() => jsonResponse(operation({ status: 'FINISHED' })),
		)

		const done = await client.awaitOperation(
			{ id: 'op-1', sandboxId: 'sb-1', kind: 'WAKE', status: 'PENDING', error: null },
			{ deadlineMs: 120_000 },
		)

		expect(done.status).toBe('FINISHED')
		expect(calls.map((call) => call.url)).toEqual([
			'https://zbox.test/api/rest/operation/op-1?waitSeconds=30',
			'https://zbox.test/api/rest/operation/op-1?waitSeconds=30',
		])
	})

	test('a FAILED operation throws with its kind, id and code only', async () => {
		const { client } = fakeBox(
			() => jsonResponse(operation({ kind: 'PARK', status: 'FAILED', error: 'guestFailed' })),
			() => jsonResponse(operation({ kind: 'PARK', status: 'FAILED', error: `guest died: ${SECRET}` })),
		)

		const coded = await caught(client.park('sb-1', { memory: true }))
		expect(coded).toBeInstanceOf(ZboxOperationFailed)
		expect(coded).toMatchObject({ kind: 'PARK', operationId: 'op-1', code: 'guestFailed', message: 'zbox: PARK operation op-1 failed (guestFailed)' })
		const prose = await caught(client.park('sb-1', { memory: true }))
		expect(prose).toMatchObject({ code: null, message: 'zbox: PARK operation op-1 failed' })
		expectNoBodyText(prose)
	})

	test('awaitOperation stops at its deadline', async () => {
		const client = createZboxClient({
			baseUrl: 'https://zbox.test',
			apiKey: 'box-api-key',
			fetch: async () => jsonResponse(operation({ status: 'RUNNING' })),
		})

		const error = await caught(
			client.awaitOperation({ id: 'op-1', sandboxId: 'sb-1', kind: 'CREATE', status: 'RUNNING', error: null }, { deadlineMs: 20 }),
		)

		expect(error).toMatchObject({ name: 'ZboxApiError', status: 0, code: 'timeout' })
	})

	test('aborting the caller signal ends the wait with the abort, mid-poll included', async () => {
		const controller = new AbortController()
		const { client, calls } = fakeBox(
			() => jsonResponse(operation({ status: 'RUNNING' })),
			(call) =>
				new Promise<Response>((_resolve, reject) => {
					call.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
					controller.abort()
				}),
		)

		const error = await caught(
			client.awaitOperation({ id: 'op-1', sandboxId: 'sb-1', kind: 'CREATE', status: 'RUNNING', error: null }, {
				signal: controller.signal,
				deadlineMs: 120_000,
			}),
		)

		expect(error).toMatchObject({ name: 'AbortError' })
		expect(calls).toHaveLength(2)
		expect(calls[1]?.signal).not.toBe(controller.signal)
	})
})
