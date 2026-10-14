// `FabrikaProvider`: the page's clients, the cache of their answers, and the caller document of the SPA mount. The
// hooks take a procedure of a client as the typed name of a call; the provider runs it on the client it holds for
// that mount, so a test hands in a client over the test kit and the page's own module-level client stays as it is.

import { createContext, type ReactNode, useContext, useState } from 'react'
import { z } from 'zod/v4'
import { type PageCaller, parsePageCaller } from '../client/caller'
import { attachmentAt, type ClientNode, clientNodeOf, downloadFile } from '../client/contract'
import { RpcError, type RpcFetch } from '../client/transport'
import { joinPath, PAGE_CALLER_FILE } from '../contract/defaults'
import { type FabrikaError, toFabrikaError } from './errors'
import { QueryStore, type StoreTarget } from './store'

export type CallerState =
	| { readonly status: 'loading' }
	| { readonly status: 'ready'; readonly caller: PageCaller }
	| { readonly status: 'error'; readonly error: FabrikaError }

/** The caller document, read once per provider when a view first asks for it. */
export class CallerSource {
	state: CallerState = { status: 'loading' }
	#started = false
	readonly #listeners = new Set<() => void>()

	constructor(private readonly url: string, private readonly fetch: RpcFetch) {}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener)
		if (!this.#started) {
			this.#started = true
			void this.#load()
		}
		return () => this.#listeners.delete(listener)
	}

	async #load(): Promise<void> {
		this.state = await this.#read()
		for (const listener of [...this.#listeners]) listener()
	}

	async #read(): Promise<CallerState> {
		try {
			const response = await this.fetch(this.url, { credentials: 'same-origin' })
			if (!response.ok) {
				return {
					status: 'error',
					error: toFabrikaError(new RpcError({ type: 'caller', message: `HTTP ${response.status}`, httpStatus: response.status })),
				}
			}
			return { status: 'ready', caller: parsePageCaller(await response.json()) }
		} catch (error) {
			return { status: 'error', error: toFabrikaError(error) }
		}
	}
}

export interface Fabrika {
	readonly store: QueryStore
	readonly caller: CallerSource
	/** The call of `procedure` on the provider's client of its mount. */
	target(procedure: unknown, hook: string): ResolvedProcedure
	/** The download of attachment `procedure` on the provider's client of its mount. */
	attachment(procedure: unknown, hook: string): (input: unknown) => Promise<File>
}

export interface ResolvedProcedure extends StoreTarget {
	readonly node: ClientNode
}

const FabrikaContext = createContext<Fabrika | null>(null)

/** The `{ path, code, message }` issues of a refused input, as the application answers them. */
function issuesOf(error: z.core.$ZodError): readonly { readonly path: string; readonly code: string; readonly message: string }[] {
	return error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), code: issue.code, message: issue.message }))
}

/** Checks the input with the procedure's own schema first: a refused input is the application's 400, unsent. */
function validated(node: ClientNode, input: unknown): unknown {
	const schema = node.procedure?.input ?? null
	if (schema === null) return input
	const parsed = z.safeParse(schema, input ?? {})
	if (parsed.success) return input
	const issues = issuesOf(parsed.error)
	const first = issues[0]
	throw new RpcError({
		type: 'validation',
		message: first === undefined ? 'Invalid input' : `${first.path || 'input'}: ${first.message}`,
		issues,
		httpStatus: 400,
	})
}

function idOf(node: ClientNode): string {
	return node.path === '' ? node.mount : `${node.mount}.${node.path}`
}

function procedureAt(client: object, path: string): unknown {
	let value: unknown = client
	for (const segment of path.split('.')) {
		value = typeof value === 'object' && value !== null ? Reflect.get(value, segment) : undefined
	}
	return value
}

function fabrika(clients: readonly object[], spa: string, fetch: RpcFetch): Fabrika {
	const byMount = new Map<string, object>()
	for (const client of clients) {
		const node = clientNodeOf(client)
		if (node === null || node.path !== '') throw new Error('FabrikaProvider takes the clients createClient made')
		if (byMount.has(node.mount)) throw new Error(`FabrikaProvider holds two clients of mount '${node.mount}'`)
		byMount.set(node.mount, client)
	}
	const clientOf = (mount: string, hook: string): object => {
		const client = byMount.get(mount)
		if (client === undefined) throw new Error(`${hook}: the FabrikaProvider holds no client of mount '${mount}'`)
		return client
	}
	return {
		store: new QueryStore(toFabrikaError),
		caller: new CallerSource(joinPath(spa, PAGE_CALLER_FILE), fetch),
		attachment(procedure, hook) {
			const at = attachmentAt(procedure)
			if (at === null) throw new Error(`${hook} takes an attachment procedure of a client createClient made`)
			const own = procedureAt(clientOf(at.mount, hook), at.path)
			if (attachmentAt(own) === null || typeof own !== 'object' || own === null) {
				throw new Error(`${hook}: '${at.mount}.${at.path}' is not an attachment procedure of the provider's client`)
			}
			return (input) => downloadFile(own, input)
		},
		target(procedure, hook) {
			const node = clientNodeOf(procedure)
			if (node?.procedure == null) throw new Error(`${hook} takes a procedure of a client createClient made`)
			const call = procedureAt(clientOf(node.mount, hook), node.path)
			if (typeof call !== 'function') throw new Error(`${hook}: '${idOf(node)}' is not a procedure of the provider's client`)
			return {
				id: idOf(node),
				node,
				run: async (input) => {
					const answer: unknown = await Reflect.apply(call, undefined, [validated(node, input)])
					return answer
				},
			}
		},
	}
}

export interface FabrikaProviderProps {
	/** The clients of the mounts the page calls, as `createClient` made them; read at the first render. */
	readonly clients: readonly object[]
	/** The prefix of the SPA mount the page is served from: the caller document is `<spa>/__fabrika-me.json`. */
	readonly spa?: string
	/** What the caller document is fetched with; the global `fetch` by default (a test passes the kit's). */
	readonly fetch?: RpcFetch
	readonly children?: ReactNode
}

export function FabrikaProvider({ clients, spa = '/', fetch: fetchCaller, children }: FabrikaProviderProps): ReactNode {
	const [value] = useState(() => fabrika(clients, spa, fetchCaller ?? ((input, init) => fetch(input, init))))
	return <FabrikaContext.Provider value={value}>{children}</FabrikaContext.Provider>
}

export function useFabrika(hook: string): Fabrika {
	const value = useContext(FabrikaContext)
	if (value === null) throw new Error(`${hook} is used outside a FabrikaProvider`)
	return value
}

/** The prefix a mutation invalidates by default: the group it lies in (`api.deals` for `api.deals.create`). */
export function parentOf(node: ClientNode): string {
	const segments = node.path.split('.')
	return segments.length <= 1 ? node.mount : `${node.mount}.${segments.slice(0, -1).join('.')}`
}

/** The prefix of a procedure or a group, for `invalidate`. */
export function prefixOf(target: unknown): string {
	const node = clientNodeOf(target)
	if (node === null) throw new Error('invalidate takes a procedure or a group of a client createClient made')
	return idOf(node)
}
