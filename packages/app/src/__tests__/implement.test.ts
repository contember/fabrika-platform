// `boot`'s request pipeline, driven through real tokens and the fixture contract: every access form allowed, denied
// and missing; caller kinds; admission; capabilities bound to their request; output projection; the header policy.

import { implement, type Ref, requestCapabilities } from '@fabrika/app/implement'
import { describe, expect, test } from 'bun:test'
import { notesApp } from './fixtures/implement/app'
import { contract } from './fixtures/implement/contract'
import { bootApp, errorType, grant, resultOf, send, type Sent, token, unreachableIam } from './fixtures/implement/harness'
import { noteDatabase, type NoteRow, notesStore } from './fixtures/implement/stores'

const N1 = '0190a0a0-0000-7000-8000-000000000001'
const N2 = '0190a0a0-0000-7000-8000-000000000002'
const MISSING = '0190a0a0-0000-7000-8000-0000000000ff'

function seed(): Map<string, NoteRow> {
	return new Map([
		[N1, { id: N1, workspaceId: 'w1', title: 'first', internalScore: 7 }],
		[N2, { id: N2, workspaceId: 'w2', title: 'second', internalScore: 9 }],
	])
}

const inW1 = (action: string) => grant(action, { type: 'workspace', value: 'w1' })

/** The declared fields of a note; every other field of the row stays in the store. */
const view = (note: NoteRow) => ({ id: note.id, title: note.title })

describe('access forms', () => {
	const app = bootApp(notesApp(seed()))

	test('member: any permission of the application is enough, and none is 403', async () => {
		const me = await send(app, '/api/me', { token: await token('user', [inW1('notes.read')]), body: {} })
		expect(resultOf(me)).toEqual({ id: 'user-1', label: 'user@notes.test' })
		const none = await send(app, '/api/me', { token: await token('user', []), body: {} })
		expect(none.status).toBe(403)
	})

	test('over: the list holds the scopes where the caller holds the action; a global grant holds all', async () => {
		const scoped = await send(app, '/api/notes.list', { token: await token('user', [inW1('notes.read')]), body: {} })
		expect(resultOf(scoped)).toEqual({ items: [{ id: N1, title: 'first' }] })
		const global = await send(app, '/api/notes.list', { token: await token('user', [grant('notes.read')]), body: {} })
		expect(resultOf(global)).toEqual({ items: [{ id: N1, title: 'first' }, { id: N2, title: 'second' }] })
	})

	test('over: the action held in no value of the dimension is 403', async () => {
		const elsewhere = await send(app, '/api/notes.list', { token: await token('user', [grant('notes.read', { type: 'note', value: N1 })]), body: {} })
		expect(elsewhere.status).toBe(403)
		const otherAction = await send(app, '/api/notes.list', { token: await token('user', [inW1('notes.write')]), body: {} })
		expect(otherAction.status).toBe(403)
	})

	test('in: the action in that scope; another scope is 403; a missing field is 400', async () => {
		const rows = seed()
		const own = bootApp(notesApp(rows))
		const user = await token('user', [inW1('notes.write')])
		const created = await send(own, '/api/notes.create', { token: user, body: { workspaceId: 'w1', title: 'third' } })
		expect(created.status).toBe(200)
		expect([...rows.values()].filter((row) => row.workspaceId === 'w1').map((row) => row.title)).toEqual(['first', 'third'])
		const other = await send(own, '/api/notes.create', { token: user, body: { workspaceId: 'w2', title: 'x' } })
		expect(other.status).toBe(403)
		const missing = await send(own, '/api/notes.create', { token: user, body: { title: 'x' } })
		expect(missing.status).toBe(400)
	})

	test('on: the action on any link of the chain; another scope and a missing object are both 404', async () => {
		const reader = await token('user', [inW1('notes.read')])
		expect(resultOf(await send(app, '/api/notes.get', { token: reader, body: { id: N1 } }))).toEqual({ id: N1, title: 'first' })
		const noteOnly = await token('user', [grant('notes.read', { type: 'note', value: N1 })])
		expect(resultOf(await send(app, '/api/notes.get', { token: noteOnly, body: { id: N1 } }))).toEqual({ id: N1, title: 'first' })
		const elsewhere = await send(app, '/api/notes.get', { token: reader, body: { id: N2 } })
		const missing = await send(app, '/api/notes.get', { token: reader, body: { id: MISSING } })
		expect([elsewhere.status, missing.status]).toEqual([404, 404])
		expect(elsewhere.body).toEqual(missing.body)
	})

	test('on: a read grant does not reach the delete endpoint', async () => {
		const removed = await send(app, '/api/notes.remove', { token: await token('user', [inW1('notes.read')]), body: { id: N1 } })
		expect(removed.status).toBe(403)
	})

	test('the input is strict: an undeclared field is 400', async () => {
		const sent = await send(app, '/api/notes.get', { token: await token('user', [inW1('notes.read')]), body: { id: N1, ownerId: 'u2' } })
		expect(sent.status).toBe(400)
		expect(errorType(sent)).toBe('validation')
	})
})

describe('the from field and the capability', () => {
	test('the handler gets the input without the from field, and a Ref with the chain', async () => {
		const seen: { input?: unknown; chain?: unknown; value?: string } = {}
		const rows = seed()
		const app = bootApp(implement(contract, {
			database: noteDatabase(rows),
			deps: (_env, { capabilities }) => notesStore(capabilities, rows),
			handlers: (notes) => ({
				api: {
					me: ({ ctx }) => ({ id: ctx.principal.id, label: ctx.principal.label }),
					notes: {
						list: ({ ctx }) => ({ items: notes.list(ctx.within).map(view) }),
						get: ({ input, ctx }) => {
							seen.input = input
							seen.chain = Object.fromEntries(ctx.target.chain)
							seen.value = ctx.target.value
							return view(notes.get(ctx.target))
						},
						create: ({ input, ctx }) => view(notes.insert(ctx.target, input.title)),
						remove: ({ ctx }) => ({ deleted: ctx.target.value }),
					},
				},
				machine: { importNotes: ({ input }) => ({ imported: input.titles.length }) },
			}),
		}))
		await send(app, '/api/notes.get', { token: await token('user', [inW1('notes.read')]), body: { id: N1 } })
		expect(seen).toEqual({ input: {}, chain: { workspace: 'w1' }, value: N1 })
	})
})

describe('caller kinds', () => {
	const app = bootApp(notesApp(seed()))
	const importBody = { workspaceId: 'w1', titles: ['a'] }

	test('a share-link key on a machine mount is refused', async () => {
		const link = await token('link', [inW1('notes.write')])
		const sent = await send(app, '/machine/importNotes', {
			token: link,
			body: importBody,
			headers: { Authorization: 'Bearer px_link', 'Content-Type': 'application/json' },
		})
		expect(sent.status).toBe(403)
	})

	test('a person cannot call a machine mount, nor a machine a person mount', async () => {
		const asUser = await send(app, '/machine/importNotes', { token: await token('user', [inW1('notes.write')]), body: importBody })
		const asService = await send(app, '/api/me', { token: await token('service', [inW1('notes.read')]), body: {} })
		expect([asUser.status, asService.status]).toEqual([403, 403])
	})

	test('a machine key reaches its mount without a browser header', async () => {
		const service = await token('service', [inW1('notes.write')])
		const sent = await send(app, '/machine/importNotes', {
			token: service,
			body: importBody,
			headers: { Authorization: 'Bearer px_key', 'Content-Type': 'application/json' },
		})
		expect(resultOf(sent)).toEqual({ imported: 1 })
	})
})

describe('the SPA', () => {
	const app = bootApp(notesApp(seed()))

	test('is served to a member, refused to a person with no permission and to no credential', async () => {
		expect((await send(app, '/', { token: await token('user', [inW1('notes.read')]) })).status).toBe(200)
		expect((await send(app, '/', { token: await token('user', []) })).status).toBe(403)
		expect((await send(app, '/')).status).toBe(401)
	})
})

describe('the token', () => {
	const app = bootApp(notesApp(seed()))

	test('no token is 401, a token for another application is 401', async () => {
		expect((await send(app, '/api/me', { body: {} })).status).toBe(401)
		expect((await send(app, '/api/me', { token: await token('user', [grant('notes.read')], 'other-app'), body: {} })).status).toBe(401)
	})

	test('an unreachable IAM is 503, never a 401', async () => {
		const down = bootApp(notesApp(seed()), { iam: unreachableIam })
		expect((await send(down, '/api/me', { token: await token('user', [grant('notes.read')]), body: {} })).status).toBe(503)
	})
})

describe('admission', () => {
	const app = bootApp(notesApp(seed()))

	test('a cross-site POST with a session is refused', async () => {
		const user = await token('user', [inW1('notes.read')])
		const statuses: number[] = []
		for (const site of ['cross-site', 'same-site', 'none', undefined]) {
			const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(site === undefined ? {} : { 'Sec-Fetch-Site': site }) }
			const sent = await send(app, '/api/notes.get', { token: user, body: { id: N1 }, headers })
			expect(errorType(sent)).toBe('admission')
			statuses.push(sent.status)
		}
		expect(statuses).toEqual([403, 403, 403, 403])
	})

	test('an RPC request must be JSON', async () => {
		const user = await token('user', [inW1('notes.read')])
		const sent = await send(app, '/api/notes.get', {
			token: user,
			body: { id: N1 },
			headers: { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'text/plain' },
		})
		expect(sent.status).toBe(400)
		expect(errorType(sent)).toBe('admission')
	})

	test('admission follows the requirement: a caller without permission learns nothing about admission', async () => {
		const sent = await send(app, '/api/notes.get', { token: await token('user', []), body: { id: N1 }, headers: { 'Content-Type': 'text/plain' } })
		expect(sent.status).toBe(403)
		expect(errorType(sent)).toBe('forbidden')
	})
})

describe('capabilities are bound to their request', () => {
	/** `get` hands its Ref to `keep` and waits for what it returns before it answers. */
	function capturingApp(rows: Map<string, NoteRow>, keep: (ref: Ref<'note', 'notes.read'>) => Promise<void> | void) {
		return implement(contract, {
			database: noteDatabase(rows),
			deps: (_env, { capabilities }) => notesStore(capabilities, rows),
			handlers: (notes) => ({
				api: {
					me: ({ ctx }) => ({ id: ctx.principal.id, label: ctx.principal.label }),
					notes: {
						list: ({ ctx }) => ({ items: notes.list(ctx.within).map(view) }),
						get: async ({ ctx }) => {
							await keep(ctx.target)
							return view(notes.get(ctx.target))
						},
						create: ({ input, ctx }) => view(notes.insert(ctx.target, input.title)),
						remove: ({ ctx }) => ({ deleted: ctx.target.value }),
					},
				},
				machine: { importNotes: ({ input }) => ({ imported: input.titles.length }) },
			}),
		})
	}

	test('a Ref used after its request is refused', async () => {
		const kept: Ref<'note', 'notes.read'>[] = []
		const app = bootApp(capturingApp(seed(), (ref) => {
			kept.push(ref)
		}))
		await send(app, '/api/notes.get', { token: await token('user', [inW1('notes.read')]), body: { id: N1 } })
		expect(kept.length).toBe(1)
		expect(() => requestCapabilities.resolve(kept[0])).toThrow('which has ended')
	})

	test('a Ref of one live request is refused in another', async () => {
		const rows = seed()
		const { promise: stolen, resolve: steal } = Promise.withResolvers<Ref<'note', 'notes.read'>>()
		const { promise: done, resolve: finish } = Promise.withResolvers<void>()
		const app = bootApp(capturingApp(rows, (ref) => {
			steal(ref)
			return done
		}))
		const user = await token('user', [inW1('notes.read')])
		const first = send(app, '/api/notes.get', { token: user, body: { id: N1 } })
		const ref = await stolen
		const thief = bootApp(implement(contract, {
			database: noteDatabase(rows),
			deps: (_env, { capabilities }) => notesStore(capabilities, rows),
			handlers: (notes) => ({
				api: {
					me: () => {
						notes.get(ref)
						return { id: 'x', label: 'x' }
					},
					notes: {
						list: ({ ctx }) => ({ items: notes.list(ctx.within).map(view) }),
						get: ({ ctx }) => view(notes.get(ctx.target)),
						create: ({ input, ctx }) => view(notes.insert(ctx.target, input.title)),
						remove: ({ ctx }) => ({ deleted: ctx.target.value }),
					},
				},
				machine: { importNotes: ({ input }) => ({ imported: input.titles.length }) },
			}),
		}))
		const refused = await send(thief, '/api/me', { token: user, body: {} })
		finish()
		expect(resultOf(await first)).toEqual({ id: N1, title: 'first' })
		expect(refused.status).toBe(500)
		expect(errorType(refused)).toBe('capability')
	})

	test('a value the framework did not mint is refused', () => {
		expect(() => requestCapabilities.resolve({ '~capability': { kind: 'ref', dimension: 'note', action: 'notes.read' } })).toThrow('not a capability')
	})
})

describe('output projection', () => {
	test('undeclared fields of the returned value are dropped', async () => {
		const rows = seed()
		const app = bootApp(implement(contract, {
			database: noteDatabase(rows),
			deps: (_env, { capabilities }) => notesStore(capabilities, rows),
			handlers: (notes) => ({
				api: {
					me: ({ ctx }) => ({ id: ctx.principal.id, label: ctx.principal.label }),
					notes: {
						list: ({ ctx }) => {
							const items: { id: string; title: string }[] = notes.list(ctx.within)
							return { items }
						},
						get: ({ ctx }) => {
							// Widened without a cast: the row still carries internalScore and workspaceId at runtime.
							const note: { id: string; title: string } = notes.get(ctx.target)
							return note
						},
						create: ({ input, ctx }) => view(notes.insert(ctx.target, input.title)),
						remove: ({ ctx }) => ({ deleted: ctx.target.value }),
					},
				},
				machine: { importNotes: ({ input }) => ({ imported: input.titles.length }) },
			}),
		}))
		const reader = await token('user', [grant('notes.read')])
		expect(resultOf(await send(app, '/api/notes.get', { token: reader, body: { id: N1 } }))).toEqual({ id: N1, title: 'first' })
		expect(resultOf(await send(app, '/api/notes.list', { token: reader, body: {} }))).toEqual({
			items: [{ id: N1, title: 'first' }, { id: N2, title: 'second' }],
		})
	})
})

describe('errors', () => {
	function throwing(error: unknown) {
		return implement(contract, {
			database: noteDatabase(seed()),
			deps: () => null,
			handlers: () => ({
				api: {
					me: () => {
						throw error
					},
					notes: {
						list: () => ({ items: [] }),
						get: () => ({ id: N1, title: 'x' }),
						create: () => ({ id: N1, title: 'x' }),
						remove: () => ({ deleted: N1 }),
					},
				},
				machine: { importNotes: () => ({ imported: 0 }) },
			}),
		})
	}

	async function answer(error: unknown): Promise<Sent> {
		return send(bootApp(throwing(error)), '/api/me', { token: await token('user', [grant('notes.read')]), body: {} })
	}

	class NotFoundError extends Error {
		override name = 'NotFoundError'
	}
	class ConflictError extends Error {
		override name = 'ConflictError'
	}

	test('the data layer’s not found and conflict are 404 and 409', async () => {
		expect((await answer(new NotFoundError('row'))).status).toBe(404)
		expect((await answer(new ConflictError('version'))).status).toBe(409)
	})

	test('an unexpected error is 500 and says nothing about itself', async () => {
		const sent = await answer(new Error('postgres://user:secret@db/notes refused'))
		expect(sent.status).toBe(500)
		expect(JSON.stringify(sent.body)).not.toContain('secret')
	})

	test('a non-canonical path is 400; an unknown procedure is 404 and never the SPA', async () => {
		const app = bootApp(notesApp(seed()))
		const user = await token('user', [grant('notes.read')])
		// A Request resolves dot segments itself; the canonical-path suite covers them on the raw target.
		for (const path of ['//api/me', '/api/x%2Fy']) {
			expect((await send(app, path, { token: user, body: {} })).status).toBe(400)
		}
		expect((await send(app, '/api/notes.export', { token: user, body: {} })).status).toBe(404)
		expect((await send(app, '/api/me/', { token: user, body: {} })).status).toBe(404)
		expect((await send(app, '/api/notes.list', { token: user })).status).toBe(404)
	})
})

describe('the response header policy', () => {
	const app = bootApp(notesApp(seed()))

	test('every response carries it: results, denials, errors, health', async () => {
		const user = await token('user', [inW1('notes.read')])
		const responses = [
			await send(app, '/api/notes.get', { token: user, body: { id: N1 } }),
			await send(app, '/api/notes.get', { token: user, body: { id: N2 } }),
			await send(app, '/api/me', { body: {} }),
			await send(app, '//x', {}),
			await send(app, '/api/nope', { token: user, body: {} }),
			await send(app, '/healthz'),
		]
		expect(responses.map((sent) => sent.status)).toEqual([200, 404, 401, 400, 404, 200])
		for (const sent of responses) {
			expect(sent.headers.get('Content-Security-Policy')).toContain("default-src 'self'")
			expect(sent.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
			expect(sent.headers.get('X-Content-Type-Options')).toBe('nosniff')
			expect(sent.headers.get('Cache-Control')).toBe('no-store')
			expect(sent.headers.get('Referrer-Policy')).toBe('no-referrer')
			expect(sent.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin')
			expect(sent.headers.get('Permissions-Policy')).toContain('camera=()')
		}
	})

	test('the SPA answer carries it too, replacing what the asset server set', async () => {
		const sent = await send(app, '/notes/1', { token: await token('user', [inW1('notes.read')]) })
		expect(sent.body).toBe('dist/app /notes/1')
		expect(sent.headers.get('Cache-Control')).toBe('no-store')
	})

	test('the Operations ingest origin joins connect-src', async () => {
		const reporting = bootApp(notesApp(seed()), {
			env: { FABRIKA_APP_ID: 'notes', FABRIKA_IAM_ISSUER: 'https://iam.test', FABRIKA_OPERATIONS_DSN: 'https://key@ops.test/42' },
		})
		const sent = await send(reporting, '/healthz')
		expect(sent.headers.get('Content-Security-Policy')).toContain("connect-src 'self' https://ops.test;")
	})
})
