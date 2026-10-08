// The test kit: the proxy's decision in front of the real dispatcher, the header stripping of the hop, and test
// callers resolved from the contract's roles. It imports only `@fabrika/app/testing`, `@fabrika/app/client` and the
// fixture application, as an application's own tests do.

import { createClient, RpcError } from '@fabrika/app/client'
import { testKit } from '@fabrika/app/testing'
import { MAX_ACCESS_TOKEN_BYTES } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { notesApp } from './fixtures/implement/app'
import { contract } from './fixtures/implement/fabrika.contract'
import type { NoteRow } from './fixtures/implement/stores'

const N1 = '0190a0a0-0000-7000-8000-000000000001'
const N2 = '0190a0a0-0000-7000-8000-000000000002'

function seed(): Map<string, NoteRow> {
	return new Map([
		[N1, { id: N1, workspaceId: 'w1', title: 'first', internalScore: 7 }],
		[N2, { id: N2, workspaceId: 'w2', title: 'second', internalScore: 9 }],
	])
}

const W1 = { type: 'workspace', value: 'w1' } as const

function post(body: unknown, headers: Record<string, string> = {}): RequestInit {
	return { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }
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

describe('the production proxy decision refuses before the application', () => {
	const kit = testKit(notesApp(seed()))

	test('a non-canonical path is 400', async () => {
		const response = await kit.fetch('/api//notes.list', post({}))
		expect(response.status).toBe(400)
		expect(await response.text()).toBe('bad request')
	})

	test('a bearer the test IAM never issued is 401, and the denial carries the header policy', async () => {
		const response = await kit.fetch('/machine/importNotes', post({ workspaceId: 'w1', titles: [] }, { Authorization: 'Bearer px_forged' }))
		expect(response.status).toBe(401)
		expect(await response.text()).toBe('unauthorized')
		expect(response.headers.get('Cache-Control')).toBe('no-store')
		expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'self'")
	})

	test('no session on a human endpoint answers the login URL: 401 to a fetch, 302 to a navigation', async () => {
		const fetched = await kit.browser()('/api/me', post({}))
		expect(fetched.status).toBe(401)
		expect(await fetched.json()).toEqual({
			error: { type: 'auth', message: 'Authentication required', loginUrl: expect.stringMatching(/^https:\/\/iam\.test\/auth\/login\?/) },
		})
		const navigated = await kit.fetch('/')
		expect(navigated.status).toBe(302)
		expect(navigated.headers.get('Location')).toStartWith('https://iam.test/auth/login?')
	})

	test('an unknown session is a login, not a caller', async () => {
		const response = await kit.browser()('/api/me', post({}, { Cookie: '__Host-px_session=stale' }))
		expect(response.status).toBe(401)
	})
})

describe('the proxy decides per endpoint, as in production', () => {
	const kit = testKit(notesApp(seed()))

	test('a key whose principal kind is not a caller of the mount is 403 at the proxy', async () => {
		const person = kit.testCaller([{ action: 'notes.write' }], { via: 'key' })
		const link = kit.testCaller([{ action: 'notes.write' }], { kind: 'link' })
		for (const caller of [person, link]) {
			const response = await kit.fetch('/machine/importNotes', post({ workspaceId: 'w1', titles: [] }, { Authorization: `Bearer ${caller.key}` }))
			expect([response.status, await response.text()]).toEqual([403, 'forbidden'])
		}
	})

	test('a session on a machine mount is 401 at the proxy, never a login bounce', async () => {
		const alice = kit.testCaller([{ action: 'notes.write' }])
		const response = await kit.browser(alice)('/machine/importNotes', post({ workspaceId: 'w1', titles: [] }))
		expect([response.status, await response.text()]).toEqual([401, 'unauthorized'])
	})

	test('a path no endpoint serves is 403 at the proxy', async () => {
		const member = kit.testCaller([{ action: 'notes.read', scope: W1 }])
		expect([(await kit.fetch('/nothing/here', post({}))).status]).toEqual([403])
		expect((await kit.browser(member)('/nothing/here', post({}))).status).toBe(403)
	})

	test('a caller without the required action, or with no permission at all, is 403 at the proxy', async () => {
		const reader = kit.testCaller([{ action: 'notes.read', scope: W1 }])
		const refused = await kit.browser(reader)('/api/notes.create', post({ workspaceId: 'w1', title: 'x' }))
		expect([refused.status, await refused.text()]).toEqual([403, 'forbidden'])
		const stranger = kit.testCaller([])
		expect((await kit.browser(stranger)('/api/me', post({}))).status).toBe(403)
		expect((await kit.browser(stranger)('/')).status).toBe(403)
	})

	test('a human key reaches a human mount as that person', async () => {
		const alice = kit.testCaller([{ action: 'notes.read', scope: W1 }], { via: 'key', id: 'alice', label: 'alice@notes.test' })
		const api = createClient(contract, 'api', { fetch: kit.fetch, key: alice.key ?? '' })
		expect(await api.me()).toEqual({ id: 'alice', label: 'alice@notes.test' })
	})

	test('the object an action is granted on is the application’s check: a writer in w2 reaches the proxy and is 403 in w1', async () => {
		const writer = kit.testCaller([{ action: 'notes.write', scope: { type: 'workspace', value: 'w2' } }])
		const response = await kit.browser(writer)('/api/notes.create', post({ workspaceId: 'w1', title: 'x' }))
		expect(response.status).toBe(403)
		expect(await response.json()).toMatchObject({ error: { type: 'forbidden' } })
	})
})

describe('a forwarded request reaches the real dispatcher', () => {
	test('the proxy refuses a cross-site POST with a session before the application sees it', async () => {
		const kit = testKit(notesApp(seed()))
		const alice = kit.testCaller([{ role: 'editor', scope: W1 }])
		const cookie = alice.cookie ?? ''
		const response = await kit.fetch('/api/notes.create', post({ workspaceId: 'w1', title: 'x' }, { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' }))
		expect([response.status, await response.text()]).toEqual([403, 'forbidden'])
	})

	test('object access is the application’s: a note in another workspace is 404', async () => {
		const kit = testKit(notesApp(seed()))
		const api = createClient(contract, 'api', { fetch: kit.browser(kit.testCaller([{ action: 'notes.read', scope: W1 }])) })
		expect(await api.notes.get({ id: N1 })).toEqual({ id: N1, title: 'first' })
		expect((await failure(api.notes.get({ id: N2 }))).httpStatus).toBe(404)
	})

	test('the application receives the proxy’s token and request id, never the client’s, and no proxy cookie', async () => {
		const received: Headers[] = []
		const kit = testKit(notesApp(seed()), {
			assets: {
				serve: (_mount, request) => {
					received.push(request.headers)
					return Promise.resolve(new Response('ok'))
				},
			},
		})
		const member = kit.testCaller([{ action: 'notes.read', scope: W1 }])
		const response = await kit.browser(member)('/', {
			headers: {
				'X-Fabrika-Token': 'forged',
				'X-Fabrika-Client-Ip': '203.0.113.9',
				'X-Request-Id': 'chosen-by-client',
				'X-Fabrika-Endpoint': 'api.me@forged',
				'X-Forwarded-For': '203.0.113.9',
				Cookie: 'theme=dark',
			},
		})
		expect(response.status).toBe(200)
		const headers = received[0]
		expect(headers?.get('X-Fabrika-Token')).not.toBe('forged')
		expect(headers?.get('X-Fabrika-Token')?.split('.')).toHaveLength(3)
		expect(headers?.get('X-Fabrika-Client-Ip')).toBeNull()
		expect(headers?.get('X-Forwarded-For')).toBeNull()
		expect(headers?.get('X-Request-Id')).not.toBe('chosen-by-client')
		// The endpoint the proxy selected, with the digest of the rules it applied, as production sends it.
		expect(headers?.get('X-Fabrika-Endpoint')).toMatch(/^spa@sha256:[0-9a-f]{64}$/)
		expect(headers?.get('Cookie')).toBe('theme=dark')
	})

	test('an anonymous endpoint is forwarded without a token', async () => {
		const kit = testKit(notesApp(seed()))
		const response = await kit.fetch('/healthz')
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ status: 'ok' })
	})

	test('the SPA is served to a member through the asset server', async () => {
		const kit = testKit(notesApp(seed()))
		const response = await kit.browser(kit.testCaller([{ action: 'notes.read', scope: W1 }]))('/')
		expect(response.status).toBe(200)
		expect(response.headers.get('Content-Type')).toContain('text/html')
	})

	test('an application that does not boot fails the kit like boot does', () => {
		const app = notesApp(seed())
		expect(() => testKit({ ...app, database: null })).toThrow("acts on a 'note'")
	})
})

describe('test callers', () => {
	const kit = testKit(notesApp(seed()))

	test('a role grants its actions in its scope, and nothing else', async () => {
		const editor = kit.testCaller([{ role: 'editor', scope: W1 }])
		expect(editor.perms).toEqual([
			{ action: 'notes.read', scope: { type: 'workspace', value: 'w1' }, source: 'grant' },
			{ action: 'notes.write', scope: { type: 'workspace', value: 'w1' }, source: 'grant' },
		])
		const api = createClient(contract, 'api', { fetch: kit.browser(editor) })
		const created = await api.notes.create({ workspaceId: 'w1', title: 'new' })
		expect(created.title).toBe('new')
		expect((await failure(api.notes.remove({ id: created.id }))).httpStatus).toBe(403)
		expect((await failure(api.notes.create({ workspaceId: 'w2', title: 'x' }))).httpStatus).toBe(403)
	})

	test('a membership role is granted in one value of its dimension', () => {
		expect(() => kit.testCaller([{ role: 'editor' }])).toThrow("'editor' is a membership role: grant it in one workspace")
		expect(() => kit.testCaller([{ role: 'editor', scope: { type: 'note', value: N1 } }])).toThrow('membership role')
	})

	test('every caller gets its own credential and principal', () => {
		const a = kit.testCaller([{ action: 'notes.read' }])
		const b = kit.testCaller([{ action: 'notes.read' }])
		const bot = kit.testCaller([{ action: 'notes.write' }], { kind: 'machine' })
		expect(a.cookie).not.toBe(b.cookie)
		expect(a.id).not.toBe(b.id)
		expect(a.key).toBeNull()
		expect(bot.cookie).toBeNull()
		expect(bot.key?.startsWith('px_')).toBe(true)
		expect(() => kit.browser(bot)).toThrow("pass the machine's key to createClient")
	})

	test('a machine key reaches its mount without a browser header', async () => {
		const bot = kit.testCaller([{ action: 'notes.write', scope: W1 }], { kind: 'machine' })
		const machine = createClient(contract, 'machine', { fetch: kit.fetch, key: bot.key ?? '' })
		expect(await machine.importNotes({ workspaceId: 'w1', titles: ['a'] })).toEqual({ imported: 1 })
	})
})

describe('the browser and the hop stay on the application', () => {
	test('a destination other than the application is refused, not answered as the application', async () => {
		const kit = testKit(notesApp(seed()))
		const person = kit.testCaller([{ action: 'notes.read' }])
		const elsewhere = createClient(contract, 'api', { fetch: kit.browser(person), baseUrl: 'https://unrelated.test' })
		expect(await failure(elsewhere.me())).toMatchObject({ type: 'transport', httpStatus: 0 })
		await expect(kit.fetch('https://unrelated.test/healthz')).rejects.toThrow('the test kit serves only https://notes.test')
	})

	test('credentials: omit sends no session', async () => {
		const kit = testKit(notesApp(seed()))
		const person = kit.testCaller([{ action: 'notes.read' }])
		const fromString = await kit.browser(person)('/api/me', { ...post({}), credentials: 'omit' })
		expect(fromString.status).toBe(401)
		const fromRequest = await kit.browser(person)(new Request('https://notes.test/api/me', post({})), {
			headers: post({}).headers,
			credentials: 'omit',
		})
		expect(fromRequest.status).toBe(401)
	})

	test('the headers of a Request input are the ones sent', async () => {
		const kit = testKit(notesApp(seed()))
		const person = kit.testCaller([{ role: 'editor', scope: W1 }])
		const crossSite = new Request('https://notes.test/api/notes.create', post({ workspaceId: 'w1', title: 'x' }, { 'Sec-Fetch-Site': 'cross-site' }))
		const response = await kit.browser(person)(crossSite)
		expect([response.status, await response.text()]).toEqual([403, 'forbidden'])
	})
})

describe('the token size bound', () => {
	test('a token up to MAX_ACCESS_TOKEN_BYTES is forwarded; one byte-step above it is 403', async () => {
		const forwarded: number[] = []
		const kit = testKit(notesApp(seed()), {
			assets: {
				serve: (_mount, request) => {
					forwarded.push(request.headers.get('X-Fabrika-Token')?.length ?? 0)
					return Promise.resolve(new Response('ok'))
				},
			},
		})
		const statusWith = async (length: number) => {
			const caller = kit.testCaller([{ action: 'notes.read', scope: { type: 'workspace', value: 'w'.repeat(length) } }])
			return (await kit.browser(caller)('/')).status
		}
		let fits = 0
		let tooLarge = MAX_ACCESS_TOKEN_BYTES
		expect(await statusWith(fits)).toBe(200)
		expect(await statusWith(tooLarge)).toBe(403)
		while (tooLarge - fits > 1) {
			const middle = Math.floor((fits + tooLarge) / 2)
			if ((await statusWith(middle)) === 200) {
				fits = middle
			} else {
				tooLarge = middle
			}
		}
		await statusWith(fits)
		const largest = forwarded.at(-1) ?? 0
		// One more character of the scope adds one or two characters of base64url to the token.
		expect(largest).toBeLessThanOrEqual(MAX_ACCESS_TOKEN_BYTES)
		expect(largest).toBeGreaterThanOrEqual(MAX_ACCESS_TOKEN_BYTES - 1)
		const refused = await kit.browser(kit.testCaller([{ action: 'notes.read', scope: { type: 'workspace', value: 'w'.repeat(tooLarge) } }]))('/')
		expect(refused.status).toBe(403)
		expect(await refused.text()).toBe('forbidden')
	})
})
