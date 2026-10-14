// The hooks against a scripted application: one request per cached call, invalidation after a mutation, the error
// union for every refusal the application answers, the cursor list, and the provider's misuses.

import { mount, press, settle } from './dom'

import { createClient, type RpcFetch } from '@fabrika/app/client'
import {
	type FabrikaError,
	FabrikaProvider,
	type MutationResult,
	skip,
	useAction,
	useInfiniteQuery,
	useInvalidate,
	useMutation,
	useQuery,
} from '@fabrika/app/react'
import { describe, expect, test } from 'bun:test'
import { Component, type ReactNode, useState } from 'react'
import { contract } from './fixture'

type Answer = { readonly status?: number; readonly body: unknown }
type Script = (path: string, input: Record<string, unknown>) => Answer

/** A fetch that answers `script` and records every call as `<path> <input JSON>`. */
function scripted(script: Script) {
	const calls: string[] = []
	const fetch: RpcFetch = async (url, init) => {
		const path = new URL(String(url), 'http://app.test').pathname
		const text = typeof init?.body === 'string' ? init.body : '{}'
		const input: unknown = JSON.parse(text)
		calls.push(`${path} ${text}`)
		const answer = script(path, typeof input === 'object' && input !== null ? Object.fromEntries(Object.entries(input)) : {})
		return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'Content-Type': 'application/json' } })
	}
	return { calls, api: createClient(contract, 'api', { fetch }) }
}

const note = (id: string, title: string, version = 1) => ({ id, title, version })
const ok = (result: unknown): Answer => ({ body: { result } })
const refused = (status: number, error: Record<string, unknown>): Answer => ({ status, body: { error } })

/** The client the components below name their calls by: the provider runs them on the client it holds. */
const names = createClient(contract, 'api', { fetch: () => Promise.reject(new Error('the module client is never called')) })

function NoteTitle({ id }: { readonly id: string }): ReactNode {
	const note = useQuery(names.notes.get, { id })
	if (note.status === 'error') return <p data-error={note.error.kind}>{note.error.message}</p>
	return <p data-status={note.status}>{note.status === 'success' ? note.data.title : '…'}</p>
}

describe('useQuery', () => {
	test('two views of one call share one request, and the answer is the parsed output', async () => {
		const { calls, api } = scripted(() => ok(note('n1', 'First')))
		const view = await mount(
			<FabrikaProvider clients={[api]}>
				<NoteTitle id="n1" />
				<NoteTitle id="n1" />
			</FabrikaProvider>,
		)
		await settle()
		expect([...view.container.querySelectorAll('p')].map((p) => p.textContent)).toEqual(['First', 'First'])
		expect(calls).toEqual(['/api/notes.get {"id":"n1"}'])
		await view.unmount()
	})

	test('an answer the output schema refuses is an error, not data', async () => {
		const { api } = scripted(() => ok({ id: 'n1', title: 'First', version: 'one' }))
		const view = await mount(
			<FabrikaProvider clients={[api]}>
				<NoteTitle id="n1" />
			</FabrikaProvider>,
		)
		await settle()
		expect(view.container.querySelector('p')?.getAttribute('data-error')).toBe('other')
		await view.unmount()
	})

	test('skip sends nothing until the input is known', async () => {
		const { calls, api } = scripted(() => ok(note('n1', 'First')))
		function Later(): ReactNode {
			const [id, setId] = useState<string | null>(null)
			const note = useQuery(names.notes.get, id === null ? skip : { id })
			return <button type="button" onClick={() => setId('n1')}>{note.status}</button>
		}
		const view = await mount(
			<FabrikaProvider clients={[api]}>
				<Later />
			</FabrikaProvider>,
		)
		await settle()
		expect(calls).toEqual([])
		expect(view.container.textContent).toBe('idle')
		await press(view.container.querySelector('button'))
		expect(calls).toEqual(['/api/notes.get {"id":"n1"}'])
		expect(view.container.textContent).toBe('success')
		await view.unmount()
	})
})

describe('the error union', () => {
	const cases: readonly [string, Answer, Partial<FabrikaError>][] = [
		[
			"the proxy's 401 carries the login URL",
			refused(401, { type: 'auth', message: 'Authentication required', loginUrl: 'https://iam.test/login' }),
			{ kind: 'unauthenticated', loginUrl: 'https://iam.test/login' },
		],
		['a 401 without one', refused(401, { type: 'auth', message: 'Authentication required' }), { kind: 'unauthenticated', loginUrl: null }],
		['a 403', refused(403, { type: 'forbidden', message: 'Forbidden' }), { kind: 'forbidden', message: 'Forbidden' }],
		['a 404', refused(404, { type: 'not_found', message: 'Not found' }), { kind: 'not-found' }],
		['a stale version', refused(409, { type: 'conflict', message: 'the row changed' }), { kind: 'conflict', message: 'the row changed' }],
		[
			"the application's 400, field by field",
			refused(400, {
				type: 'validation',
				message: 'title: Too long',
				issues: [
					{ path: 'title', code: 'too_big', message: 'Too long' },
					{ path: 'title', code: 'custom', message: 'second' },
					{ path: 'workspaceId', code: 'custom', message: 'Unknown' },
				],
			}),
			{ kind: 'validation', fields: { title: 'Too long', workspaceId: 'Unknown' } },
		],
		['a business 400 without issues', refused(400, { type: 'bad_request', message: 'not a member' }), { kind: 'validation', fields: {} }],
		['a 500', refused(500, { type: 'internal', message: 'Internal error' }), { kind: 'other', status: 500 }],
	]
	for (const [name, answer, expected] of cases) {
		test(`a mutation refused: ${name}`, async () => {
			const { api } = scripted(() => answer)
			let result: MutationResult<unknown> | null = null
			function Create(): ReactNode {
				const create = useMutation(names.notes.create)
				return (
					<button type="button" onClick={async () => (result = await create.mutate({ workspaceId: 'w1', title: 'Hello' }))}>
						{create.error?.kind ?? create.status}
					</button>
				)
			}
			const view = await mount(
				<FabrikaProvider clients={[api]}>
					<Create />
				</FabrikaProvider>,
			)
			await press(view.container.querySelector('button'))
			expect(result).toMatchObject({ ok: false, error: expected })
			expect(view.container.textContent).toBe(expected.kind ?? '')
			await view.unmount()
		})
	}

	test("an input the procedure's schema refuses is a validation error, and nothing is sent", async () => {
		const { calls, api } = scripted(() => ok(note('n9', 'x')))
		let result: MutationResult<unknown> | null = null
		function Create(): ReactNode {
			const create = useMutation(names.notes.create)
			return <button type="button" onClick={async () => (result = await create.mutate({ workspaceId: 'w1', title: '' }))}>go</button>
		}
		const view = await mount(
			<FabrikaProvider clients={[api]}>
				<Create />
			</FabrikaProvider>,
		)
		await press(view.container.querySelector('button'))
		expect(calls).toEqual([])
		expect(result).toMatchObject({ ok: false, error: { kind: 'validation', fields: { title: expect.any(String) } } })
		await view.unmount()
	})

	test('a request that never got an answer is other with status 0', async () => {
		const api = createClient(contract, 'api', { fetch: () => Promise.reject(new TypeError('offline')) })
		const view = await mount(
			<FabrikaProvider clients={[api]}>
				<NoteTitle id="n1" />
			</FabrikaProvider>,
		)
		await settle()
		expect(view.container.querySelector('p')?.getAttribute('data-error')).toBe('other')
		await view.unmount()
	})
})

describe('invalidation', () => {
	function Notes(): ReactNode {
		const list = useInfiniteQuery(names.notes.list, { workspaceId: 'w1' })
		const counts = useQuery(names.stats.counts)
		const create = useMutation(names.notes.create)
		return (
			<div>
				<ul>{list.items.map((item) => <li key={item.id}>{item.title}</li>)}</ul>
				<output>{counts.status === 'success' ? counts.data.notes : ''}</output>
				<button type="button" onClick={() => void create.mutate({ workspaceId: 'w1', title: 'New' })}>add</button>
			</div>
		)
	}

	const store = () => {
		const notes = [note('n1', 'First')]
		return scripted((path, input) => {
			if (path === '/api/notes.create') {
				notes.push(note(`n${notes.length + 1}`, String(input['title'])))
				return ok(notes.at(-1))
			}
			if (path === '/api/stats.counts') return ok({ notes: notes.length })
			return ok({ items: notes, next: null })
		})
	}

	test("a mutation refetches its own group's shown queries by default, and not another group's", async () => {
		const { calls, api } = store()
		const view = await mount(
			<FabrikaProvider clients={[api]}>
				<Notes />
			</FabrikaProvider>,
		)
		await settle()
		calls.length = 0
		await press(view.container.querySelector('button'))
		expect(calls).toEqual(['/api/notes.create {"workspaceId":"w1","title":"New"}', '/api/notes.list {"workspaceId":"w1"}'])
		expect([...view.container.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['First', 'New'])
		expect(view.container.querySelector('output')?.textContent).toBe('1')
		await view.unmount()
	})

	test('invalidates names what to refetch, and useInvalidate refetches on demand', async () => {
		const { calls, api } = store()
		function Both(): ReactNode {
			const counts = useQuery(names.stats.counts)
			const create = useMutation(names.notes.create, { invalidates: [names.stats] })
			const invalidate = useInvalidate()
			return (
				<div>
					<output>{counts.status === 'success' ? counts.data.notes : ''}</output>
					<button type="button" onClick={() => void create.mutate({ workspaceId: 'w1', title: 'New' })}>add</button>
					<button type="button" onClick={() => void invalidate(names)}>all</button>
				</div>
			)
		}
		const view = await mount(
			<FabrikaProvider clients={[api]}>
				<Both />
			</FabrikaProvider>,
		)
		await settle()
		const [add, all] = view.container.querySelectorAll('button')
		await press(add)
		expect(view.container.querySelector('output')?.textContent).toBe('2')
		calls.length = 0
		await press(all)
		expect(calls).toEqual(['/api/stats.counts {}'])
		await view.unmount()
	})

	test('a query no view shows is forgotten by an invalidation, so its next view loads it again', async () => {
		function Toggle(): ReactNode {
			const [shown, setShown] = useState(true)
			const create = useMutation(names.notes.create)
			return (
				<div>
					{shown ? <NoteTitle id="n1" /> : null}
					<button type="button" onClick={() => setShown(!shown)}>toggle</button>
					<button type="button" onClick={() => void create.mutate({ workspaceId: 'w1', title: 'New' })}>add</button>
				</div>
			)
		}
		const scriptedGet = scripted((path) => (path === '/api/notes.get' ? ok(note('n1', 'First')) : ok(note('n2', 'New'))))
		const view = await mount(
			<FabrikaProvider clients={[scriptedGet.api]}>
				<Toggle />
			</FabrikaProvider>,
		)
		await settle()
		const [toggle, add] = view.container.querySelectorAll('button')
		await press(toggle)
		await press(add)
		expect(scriptedGet.calls.filter((call) => call.startsWith('/api/notes.get'))).toHaveLength(1)
		await press(toggle)
		expect(scriptedGet.calls.filter((call) => call.startsWith('/api/notes.get'))).toHaveLength(2)
		await view.unmount()
	})
})

describe('useInfiniteQuery', () => {
	const pages = () =>
		scripted((_path, input) =>
			input['after'] === undefined
				? ok({ items: [note('n1', 'One'), note('n2', 'Two')], next: 'c2' })
				: input['after'] === 'c2'
				? ok({ items: [note('n3', 'Three')], next: null })
				: refused(400, { type: 'validation', message: 'bad cursor' })
		)

	function List({ all }: { readonly all?: boolean }): ReactNode {
		const list = useInfiniteQuery(names.notes.list, { workspaceId: 'w1' }, all === true ? { pages: 'all' } : {})
		const invalidate = useInvalidate()
		return (
			<div>
				<ul>{list.items.map((item) => <li key={item.id}>{item.title}</li>)}</ul>
				{list.hasMore ? <button type="button" onClick={() => void list.loadMore()}>more</button> : null}
				<button type="button" onClick={() => void invalidate(names.notes.list)}>again</button>
			</div>
		)
	}

	test('loadMore appends the next page by its cursor, and the button goes when there is none', async () => {
		const { calls, api } = pages()
		const view = await mount(
			<FabrikaProvider clients={[api]}>
				<List />
			</FabrikaProvider>,
		)
		await settle()
		expect([...view.container.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['One', 'Two'])
		await press(view.container.querySelector('button'))
		expect([...view.container.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['One', 'Two', 'Three'])
		expect(view.container.querySelectorAll('button')).toHaveLength(1)
		expect(calls).toEqual(['/api/notes.list {"workspaceId":"w1"}', '/api/notes.list {"workspaceId":"w1","after":"c2"}'])
		calls.length = 0
		await press(view.container.querySelector('button'))
		expect(calls).toEqual(['/api/notes.list {"workspaceId":"w1"}', '/api/notes.list {"workspaceId":"w1","after":"c2"}'])
		await view.unmount()
	})

	test("pages: 'all' follows every cursor on the first load", async () => {
		const { calls, api } = pages()
		const view = await mount(
			<FabrikaProvider clients={[api]}>
				<List all />
			</FabrikaProvider>,
		)
		await settle()
		expect([...view.container.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['One', 'Two', 'Three'])
		expect(calls).toHaveLength(2)
		await view.unmount()
	})
})

describe('useAction', () => {
	test('a call that is no procedure gets the same state and error union', async () => {
		const { api } = scripted(() => ok(note('n1', 'x')))
		const seen: string[] = []
		function Upload(): ReactNode {
			const upload = useAction(async (name: string) => {
				if (name === '') throw Object.assign(new Error('Forbidden'), { httpStatus: 403, type: 'forbidden' })
				return { name }
			})
			return (
				<button
					type="button"
					onClick={async () => {
						const outcome = await upload.mutate('')
						seen.push(outcome.ok ? 'ok' : outcome.error.kind)
					}}
				>
					up
				</button>
			)
		}
		const view = await mount(
			<FabrikaProvider clients={[api]}>
				<Upload />
			</FabrikaProvider>,
		)
		await press(view.container.querySelector('button'))
		expect(seen).toEqual(['forbidden'])
		await view.unmount()
	})
})

class Boundary extends Component<{ readonly children: ReactNode }, { readonly message: string | null }> {
	override state = { message: null }
	static getDerivedStateFromError(error: unknown) {
		return { message: error instanceof Error ? error.message : 'thrown' }
	}
	override render(): ReactNode {
		return this.state.message ?? this.props.children
	}
}

describe('the provider', () => {
	const quietly = async (node: ReactNode) => {
		const original = console.error
		console.error = () => {}
		try {
			const view = await mount(<Boundary>{node}</Boundary>)
			const text = view.container.textContent
			await view.unmount()
			return text
		} finally {
			console.error = original
		}
	}

	test('a hook outside it says so', async () => {
		expect(await quietly(<NoteTitle id="n1" />)).toBe('useQuery is used outside a FabrikaProvider')
	})

	test('a procedure of a mount it holds no client of is refused by name', async () => {
		expect(
			await quietly(
				<FabrikaProvider clients={[]}>
					<NoteTitle id="n1" />
				</FabrikaProvider>,
			),
		).toBe("useQuery: the FabrikaProvider holds no client of mount 'api'")
	})

	test('a mutation is not a query, and a group is no client', async () => {
		const { api } = scripted(() => ok(null))
		function Wrong(): ReactNode {
			useQuery(names.notes.create, { workspaceId: 'w1', title: 'x' })
			return null
		}
		expect(
			await quietly(
				<FabrikaProvider clients={[api]}>
					<Wrong />
				</FabrikaProvider>,
			),
		).toBe("useQuery: 'api.notes.create' is a mutation; use useMutation")
		expect(await quietly(<FabrikaProvider clients={[api.notes]}>x</FabrikaProvider>)).toBe('FabrikaProvider takes the clients createClient made')
	})
})
