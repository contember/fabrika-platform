// The test kit: the proxy's decision in front of the real dispatcher, the header stripping of the hop, and test
// callers resolved from the contract's roles. It reaches the application only through `@fabrika/app/testing` and
// `@fabrika/app/client`, as an application's own tests do.

import { createClient, RpcError } from '@fabrika/app/client'
import { defineContract } from '@fabrika/app/contract'
import { statusOf, type TestCaller, testKit } from '@fabrika/app/testing'
import { MAX_ACCESS_TOKEN_BYTES } from '@fabrika/auth-core'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { implement } from '../implement/implement'
import { notesApp } from './fixtures/implement/app'
import { contract } from './fixtures/implement/fabrika.contract'
import type { NoteRow } from './fixtures/implement/stores'
import { RecordingMembership } from './fixtures/multi-tenant/iam'

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

	test('a scope the kit builds keeps its dimension and grants in that value', async () => {
		const w1 = kit.scope('workspace', 'w1')
		expect(w1).toEqual({ type: 'workspace', value: 'w1' })
		expect(Object.isFrozen(w1)).toBe(true)
		const api = createClient(contract, 'api', { fetch: kit.browser(kit.testCaller([{ role: 'editor', scope: w1 }])) })
		expect((await api.notes.create({ workspaceId: 'w1', title: 'scoped' })).title).toBe('scoped')
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

	test("a disabled caller's key and session sign nothing in, as IAM refuses a disabled principal", async () => {
		const bot = kit.testCaller([{ action: 'notes.write', scope: W1 }], { kind: 'machine', disabled: true })
		const keyed = await kit.fetch('/machine/importNotes', post({ workspaceId: 'w1', titles: [] }, { Authorization: `Bearer ${bot.key}` }))
		expect(keyed.status).toBe(403)
		const person = kit.testCaller([{ role: 'editor', scope: W1 }], { disabled: true })
		expect((await kit.browser(person)('/api/me', post({}))).status).toBe(401)
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

describe("the kit serves an SPA's built directory as the deploy does", () => {
	const root = mkdtempSync(join(tmpdir(), 'fabrika-kit-spa-'))
	afterAll(() => rmSync(root, { recursive: true, force: true }))
	mkdirSync(join(root, 'dist', 'app', 'assets'), { recursive: true })
	writeFileSync(join(root, 'dist', 'app', 'index.html'), '<!doctype html><title>Notes</title><script src="/assets/app.js"></script>')
	writeFileSync(join(root, 'dist', 'app', 'assets', 'app.js'), 'console.log("notes")')

	test('a member gets the built index.html, a built file by its path, and the index for a route of the SPA', async () => {
		const kit = testKit(notesApp(seed()), { root })
		const member = kit.browser(kit.testCaller([{ action: 'notes.read', scope: W1 }]))
		const page = await member('/')
		expect(page.status).toBe(200)
		expect(await page.text()).toBe('<!doctype html><title>Notes</title><script src="/assets/app.js"></script>')
		expect(await (await member('/assets/app.js')).text()).toBe('console.log("notes")')
		expect(await (await member('/notes/n-1/edit')).text()).toContain('<title>Notes</title>')
	})

	test('the proxy still decides first: a caller with no permission gets no built page', async () => {
		const kit = testKit(notesApp(seed()), { root })
		const stranger = kit.browser(kit.testCaller([]))
		const refused = await stranger('/')
		expect(refused.status).toBe(403)
		expect(await refused.text()).not.toContain('<title>Notes</title>')
	})

	test('an SPA that is not built is an empty page', async () => {
		const kit = testKit(notesApp(seed()), { root: join(root, 'elsewhere') })
		const page = await kit.browser(kit.testCaller([{ action: 'notes.read', scope: W1 }]))('/')
		expect(page.status).toBe(200)
		expect(await page.text()).toBe('<!doctype html><title></title>')
	})
})

describe('the kit serves the IAM membership operations it is given', () => {
	const starting = defineContract({
		app: 'notes',
		dimensions: { workspace: { creator: 'owner' } },
		actions: { 'notes.read': 'Read', 'workspaces.create': 'Start' },
		roles: { owner: { grants: ['notes.read'], member: { scope: 'workspace', assignableBy: ['owner'] } } },
	}, (c) => ({
		api: c.rpc('/api', { callers: ['human'] }, {
			start: c.mutation({ output: z.strictObject({ workspace: z.string() }), access: { action: 'workspaces.create', creates: 'workspace' } }),
		}),
	}))
	const app = implement(starting, {
		database: null,
		deps: () => null,
		handlers: () => ({ api: { start: ({ ctx }) => ({ workspace: ctx.created.value }) } }),
	})

	test("the kit's proxy obtains the delegation for the request, and the application spends it at IAM", async () => {
		const membership = new RecordingMembership()
		const kit = testKit(app, { membership })
		const starter = kit.testCaller([{ action: 'workspaces.create' }])
		const response = await kit.browser(starter)('/api/start', post({}))
		expect(await response.json()).toEqual({ result: { workspace: 'w-new' } })
		const [asked] = membership.delegations
		const [created] = membership.calls
		expect(asked?.endpoint).toBe('api.start')
		expect(created?.method === 'createScope' ? created.input.delegation : null).toBe(`grant-for-${asked?.requestId}`)
	})

	test("without it, the kit's own IAM creates the value for a global holder only, and makes the creator its owner", async () => {
		const kit = testKit(app)
		const response = await kit.browser(kit.testCaller([{ action: 'workspaces.create' }]))('/api/start', post({}))
		expect(response.status).toBe(200)
		const scoped = kit.testCaller([{ action: 'workspaces.create', scope: { type: 'workspace', value: 'w1' } }])
		expect((await kit.browser(scoped)('/api/start', post({}))).status).toBe(403)
	})
})

describe("the kit's own IAM: an invitation accepted, a member removed, each live from the next request", () => {
	const people = defineContract({
		app: 'notes',
		dimensions: { workspace: { creator: 'owner', members: { manage: 'members.manage', list: 'notes.read' } } },
		actions: { 'notes.read': 'Read', 'members.manage': 'Invite and remove', 'workspaces.create': 'Start' },
		roles: {
			owner: { grants: ['notes.read', 'members.manage'], member: { scope: 'workspace', assignableBy: ['owner'] } },
			guest: { grants: ['notes.read'], member: { scope: 'workspace', assignableBy: ['owner'] }, external: true },
		},
	}, (c) => ({
		api: c.rpc('/api', { callers: ['human'] }, {
			start: c.mutation({ output: z.strictObject({ workspace: z.string() }), access: { action: 'workspaces.create', creates: 'workspace' } }),
			invite: c.mutation({
				input: z.strictObject({ workspaceId: z.string(), email: z.email() }),
				output: z.strictObject({ invitationId: z.string() }),
				access: { action: 'members.manage', in: 'workspace', from: 'workspaceId' },
			}),
			remove: c.mutation({
				input: z.strictObject({ workspaceId: z.string(), principalId: z.string() }),
				output: z.strictObject({ ok: z.boolean() }),
				access: { action: 'members.manage', in: 'workspace', from: 'workspaceId' },
			}),
			members: c.query({
				input: z.strictObject({ workspaceId: z.string() }),
				output: z.strictObject({ items: z.array(z.strictObject({ principalId: z.string(), roles: z.array(z.string()), affiliation: z.string() })) }),
				access: { action: 'notes.read', in: 'workspace', from: 'workspaceId' },
			}),
		}),
	}))
	const app = implement(people, {
		database: null,
		deps: () => null,
		handlers: () => ({
			api: {
				start: ({ ctx }) => ({ workspace: ctx.created.value }),
				invite: async ({ input, ctx }) => {
					const result = await ctx.members.assign(ctx.target, { email: input.email }, 'guest')
					return { invitationId: 'invited' in result ? result.invited.invitationId : result.assigned.principalId }
				},
				remove: async ({ input, ctx }) => {
					await ctx.members.revoke(ctx.target, { principalId: input.principalId })
					return { ok: true }
				},
				members: async ({ ctx }) => ({
					items: (await ctx.members.list()).map(({ principalId, roles, affiliation }) => ({ principalId, roles: [...roles], affiliation })),
				}),
			},
		}),
	})
	const kit = testKit(app)
	const w1 = kit.scope('workspace', 'w1')
	const apiOf = (caller: TestCaller) => createClient(people, 'api', { fetch: kit.browser(caller) })

	test('a creator holds the owner role of the value it created from its next request', async () => {
		const starter = kit.testCaller([{ action: 'workspaces.create' }])
		const { workspace } = await apiOf(starter).start()
		expect((await apiOf(starter).members({ workspaceId: workspace })).items).toEqual([{
			principalId: starter.id,
			roles: ['owner'],
			affiliation: 'internal',
		}])
	})

	test('the addressee accepts as a new person who is listed and reads; once removed, it is refused and no longer listed', async () => {
		const owner = kit.testCaller([{ role: 'owner', scope: w1 }])
		const ownerApi = apiOf(owner)
		const { invitationId } = await ownerApi.invite({ workspaceId: 'w1', email: 'Ann@Example.test' })
		const ann = kit.acceptInvitation(invitationId)
		expect(ann).toMatchObject({ kind: 'human', label: 'ann@example.test', affiliation: 'external' })
		expect((await apiOf(ann).members({ workspaceId: 'w1' })).items).toContainEqual({ principalId: ann.id, roles: ['guest'], affiliation: 'external' })
		expect(() => kit.acceptInvitation(invitationId)).toThrow(`no open invitation ${invitationId}`)

		expect(await ownerApi.remove({ workspaceId: 'w1', principalId: ann.id })).toEqual({ ok: true })
		expect(await statusOf(apiOf(ann).members({ workspaceId: 'w1' }))).toBe(403)
		expect((await ownerApi.members({ workspaceId: 'w1' })).items.map((item) => item.principalId)).toEqual([owner.id])
	})

	test('a person of the kit accepts into its own grants; a guest invites nobody; an unknown invitation is not accepted', async () => {
		const owner = kit.testCaller([{ role: 'owner', scope: w1 }])
		const bob = kit.testCaller([{ role: 'owner', scope: kit.scope('workspace', 'w2') }])
		const { invitationId } = await apiOf(owner).invite({ workspaceId: 'w1', email: 'bob@example.test' })
		expect(kit.acceptInvitation(invitationId, bob)).toBe(bob)
		expect((await apiOf(bob).members({ workspaceId: 'w1' })).items.map((item) => item.principalId)).toContain(bob.id)
		expect(await statusOf(apiOf(bob).invite({ workspaceId: 'w1', email: 'eve@example.test' }))).toBe(403)
		expect(() => kit.acceptInvitation('invitation-unknown')).toThrow('no open invitation invitation-unknown')
	})

	test('a kit given its own membership transport holds no invitation to accept', () => {
		const own = testKit(app, { membership: new RecordingMembership() })
		expect(() => own.acceptInvitation('invitation-1')).toThrow('given its own membership transport')
	})
})
