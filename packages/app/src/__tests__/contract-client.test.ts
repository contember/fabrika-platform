// The typed client of a contract mount, through the test kit: one path per procedure, the input as the body, the
// answer checked against the output schema, and the error envelope as an `RpcError`. A link mount's client presents
// its share key as a bearer; the framework does not serve link mounts yet, so that case is read off the request.

import { createClient, RpcError, type RpcFetch } from '@fabrika/app/client'
import { testKit } from '@fabrika/app/testing'
import { describe, expect, test } from 'bun:test'
import { notesApp } from './fixtures/implement/app'
import { contract } from './fixtures/implement/fabrika.contract'
import { contract as linkContract } from './fixtures/notes-app/fabrika.contract'

const N1 = '0190a0a0-0000-7000-8000-000000000001'
const W1 = { type: 'workspace', value: 'w1' } as const

interface Sent {
	readonly url: string
	readonly method: string
	readonly headers: Headers
	readonly credentials: RequestCredentials | undefined
	readonly body: string
}

/** Records every request, then hands it to `next`. */
function recording(next: RpcFetch): { readonly sent: Sent[]; readonly fetch: RpcFetch } {
	const sent: Sent[] = []
	return {
		sent,
		fetch: async (input, init) => {
			const request = new Request(new URL(String(input), 'https://notes.test'), init)
			sent.push({
				url: request.url,
				method: request.method,
				headers: request.headers,
				credentials: init?.credentials,
				body: await request.clone().text(),
			})
			return next(input, init)
		},
	}
}

function answering(body: unknown, status = 200): RpcFetch {
	return () => Promise.resolve(Response.json(body, { status }))
}

async function failure(call: Promise<unknown>): Promise<RpcError> {
	try {
		await call
	} catch (error) {
		if (error instanceof RpcError) {
			return error
		}
		throw error
	}
	throw new Error('expected the call to fail')
}

function kitWithNote() {
	const kit = testKit(notesApp(new Map([[N1, { id: N1, workspaceId: 'w1', title: 'first', internalScore: 7 }]])))
	const owner = kit.testCaller([{ role: 'owner', scope: W1 }])
	return { kit, owner }
}

describe('an RPC mount client', () => {
	test('api.notes.remove({ id }) POSTs the input to /api/notes.remove', async () => {
		const { kit, owner } = kitWithNote()
		const { sent, fetch } = recording(kit.browser(owner))
		const api = createClient(contract, 'api', { fetch })
		expect(await api.notes.remove({ id: N1 })).toEqual({ deleted: N1 })
		expect(sent.map(({ url, method, body }) => ({ url, method, body }))).toEqual([
			{ url: 'https://notes.test/api/notes.remove', method: 'POST', body: JSON.stringify({ id: N1 }) },
		])
		expect(sent[0]?.headers.get('Content-Type')).toBe('application/json')
		expect(sent[0]?.credentials).toBe('same-origin')
		expect((await failure(api.notes.get({ id: N1 }))).httpStatus).toBe(404)
	})

	test('a procedure without input sends {}', async () => {
		const { kit, owner } = kitWithNote()
		const { sent, fetch } = recording(kit.browser(owner))
		const api = createClient(contract, 'api', { fetch })
		expect(await api.notes.list()).toEqual({ items: [{ id: N1, title: 'first' }] })
		expect(sent[0]?.body).toBe('{}')
	})

	test('baseUrl is the origin the paths join', async () => {
		const { kit, owner } = kitWithNote()
		const { sent, fetch } = recording(kit.browser(owner))
		await createClient(contract, 'api', { fetch, baseUrl: 'https://notes.test/' }).me()
		expect(sent[0]?.url).toBe('https://notes.test/api/me')
	})

	test('an error envelope is an RpcError with its type, status and issues', async () => {
		const { kit, owner } = kitWithNote()
		const api = createClient(contract, 'api', { fetch: kit.browser(owner) })
		const invalid = await failure(api.notes.get({ id: 'not-a-uuid' }))
		expect(invalid.type).toBe('validation')
		expect(invalid.httpStatus).toBe(400)
		expect(Array.isArray(invalid.issues)).toBe(true)
	})

	test('a proxy refusal is an RpcError with the status', async () => {
		const { kit } = kitWithNote()
		const reader = kit.testCaller([{ action: 'notes.read', scope: W1 }])
		const refused = await failure(createClient(contract, 'api', { fetch: kit.browser(reader) }).notes.remove({ id: N1 }))
		expect(refused.httpStatus).toBe(403)
	})

	test('an unauthenticated call carries the login URL', async () => {
		const { kit } = kitWithNote()
		const refused = await failure(createClient(contract, 'api', { fetch: kit.browser() }).me())
		expect(refused).toMatchObject({ type: 'auth', httpStatus: 401, loginUrl: expect.stringMatching(/^https:\/\/iam\.test\/auth\/login\?/) })
	})

	test('a key client sends the key as a bearer and no cookie', async () => {
		const { kit } = kitWithNote()
		const bot = kit.testCaller([{ action: 'notes.write', scope: W1 }], { kind: 'machine' })
		const { sent, fetch } = recording(kit.fetch)
		const machine = createClient(contract, 'machine', { fetch, key: bot.key ?? '' })
		expect(await machine.importNotes({ workspaceId: 'w1', titles: ['a', 'b'] })).toEqual({ imported: 2 })
		expect(sent[0]?.headers.get('Authorization')).toBe(`Bearer ${bot.key}`)
		expect(sent[0]?.credentials).toBe('omit')
	})

	test('an answer that is not 2xx is an RpcError, even a JSON one with no error field', async () => {
		const api = createClient(contract, 'api', { fetch: answering({ result: { id: 'u', label: 'x' } }, 502) })
		expect(await failure(api.me())).toMatchObject({ type: 'error', message: 'HTTP 502', httpStatus: 502 })
		const bare = createClient(contract, 'api', { fetch: answering({ received: true }, 400) })
		expect(await failure(bare.me())).toMatchObject({ type: 'error', message: 'HTTP 400', httpStatus: 400 })
	})

	test('an answer the output schema refuses is an RpcError, never a value', async () => {
		const api = createClient(contract, 'api', { fetch: answering({ result: { id: 'u', label: 7 } }) })
		const refused = await failure(api.me())
		expect(refused.type).toBe('invalid-response')
		expect(refused.message).toBe("'api.me' answered a value its output schema refuses")
	})

	test('only declared procedures exist on the client', () => {
		const api = createClient(contract, 'api', { fetch: answering({}) })
		expect(Object.keys(api)).toEqual(['me', 'notes'])
		expect(Object.keys(api.notes)).toEqual(['list', 'get', 'create', 'remove'])
		expect(Object.isFrozen(api.notes)).toBe(true)
	})
})

describe('a link mount client', () => {
	test('POSTs to <prefix>/api/<procedure> with its share key as a bearer', async () => {
		const note = { id: N1, title: 'shared', body: null, version: 1, sku: 'N-1', updatedAt: '2026-10-08T12:00:00Z' }
		const { sent, fetch } = recording(answering({ result: note }))
		const shared = createClient(linkContract, 'shared', { fetch, key: 'px_link_key' })
		expect(await shared.note()).toEqual(note)
		expect(sent.map(({ url, method }) => ({ url, method }))).toEqual([{ url: 'https://notes.test/s/api/note', method: 'POST' }])
		expect(sent[0]?.headers.get('Authorization')).toBe('Bearer px_link_key')
		expect(sent[0]?.credentials).toBe('omit')
	})

	test('needs its key', () => {
		expect(() => createClient(linkContract, 'shared', { key: '' })).toThrow("'shared' is a link mount; its client needs the share key")
	})
})

describe('serialization and destinations', () => {
	test('an input that does not serialize rejects with an RpcError', async () => {
		const cyclic: Record<string, unknown> = { workspaceId: 'w1', title: 'x' }
		cyclic['self'] = cyclic
		const api = createClient(contract, 'api', { fetch: answering({ result: {} }) })
		const pending = Reflect.apply(api.notes.create, undefined, [cyclic])
		expect(pending).toBeInstanceOf(Promise)
		expect((await failure(pending)).type).toBe('transport')
	})

	test('outside a browser, an explicit baseUrl names the application a script calls', async () => {
		const { sent, fetch } = recording(answering({ result: { id: 'm', label: 'machine' } }))
		await createClient(contract, 'api', { fetch, key: 'px_script', baseUrl: 'https://other.test' }).me()
		expect(sent[0]?.url).toBe('https://other.test/api/me')
	})

	test('in a browser, a key goes only to the page origin', async () => {
		const { sent, fetch } = recording(answering({ result: { id: 'm', label: 'machine' } }))
		Reflect.set(globalThis, 'location', new URL('https://notes.test/app/'))
		try {
			expect(() => createClient(contract, 'api', { fetch, key: 'px_page', baseUrl: 'https://unrelated.test' })).toThrow(
				"a client with a key in a browser calls only https://notes.test; baseUrl 'https://unrelated.test' is another origin",
			)
			await createClient(contract, 'api', { fetch, key: 'px_page', baseUrl: 'https://notes.test' }).me()
			await createClient(contract, 'api', { fetch, key: 'px_page' }).me()
		} finally {
			Reflect.deleteProperty(globalThis, 'location')
		}
		expect(sent.map(({ url }) => url)).toEqual(['https://notes.test/api/me', 'https://notes.test/api/me'])
	})
})
