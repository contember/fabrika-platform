// The typed client of one contract mount: `api.notes.remove({ id })` POSTs the input to `/api/notes.remove`, the
// path `compileContract` gives that procedure. Built from the contract value, so it can call only declared
// procedures, and it checks each answer against the procedure's output schema before handing it out.

import { z } from 'zod/v4'
import { isProcedure, type ProcedureTreeDeclaration, SURFACE_SECTIONS } from '../contract/declaration'
import { joinPath, LINK_API_SEGMENT } from '../contract/defaults'
import type { AnyContract, InputSchema, Procedure, Schema, Surface } from '../contract/define'
import { type BounceConfig, type BounceOption, exchange, resolveBounce, RpcError, type RpcFetch } from './transport'

type SurfaceOf<C> = C extends { readonly surface: infer S } ? S : never

/** The mounts a client calls: RPC mounts and link mounts. */
export type ClientMount<C> =
	& { [M in keyof SurfaceOf<C>]: SurfaceOf<C>[M] extends { readonly kind: 'rpc' | 'link' } ? M : never }[keyof SurfaceOf<C>]
	& string

/** One procedure: its input as the caller writes it (defaults optional), its output as parsed. */
export type ProcedureCall<I, O extends Schema> = [I] extends [InputSchema] ? (input: z.input<I>) => Promise<z.output<O>>
	: (input?: Record<never, never>) => Promise<z.output<O>>

export type ClientTree<T> = {
	readonly [K in keyof T]: T[K] extends Procedure<'query' | 'mutation', infer I, infer O, unknown> ? ProcedureCall<I, O> : ClientTree<T[K]>
}

export type ContractClient<C, M> = SurfaceOf<C>[M & keyof SurfaceOf<C>] extends { readonly procedures: infer T } ? ClientTree<T> : never

export interface ClientOptions {
	/** The application's origin; procedure paths are joined to it. Defaults to the page's own origin. */
	readonly baseUrl?: string
	/** Override `fetch` (tests, a script). Defaults to the global `fetch`. */
	readonly fetch?: RpcFetch
	/**
	 * A `px_` key, sent as `Authorization: Bearer`. A request with a key carries no cookie. In a browser the key goes
	 * only to the page's own origin.
	 */
	readonly key?: string
	/** On a 401 that carries a login URL, send the browser to sign in instead of throwing. */
	readonly bounceOnAuth?: BounceOption
}

/** A link mount's caller is the holder of its share key, which every request presents. */
export interface LinkClientOptions extends ClientOptions {
	readonly key: string
}

type OptionsFor<C, M> = SurfaceOf<C>[M & keyof SurfaceOf<C>] extends { readonly kind: 'link' } ? [options: LinkClientOptions]
	: [options?: ClientOptions]

interface CallTarget {
	readonly id: string
	readonly url: string
	readonly output: Schema
}

function caller(target: CallTarget, options: ClientOptions, bounce: BounceConfig | null) {
	return async (input?: unknown): Promise<unknown> => {
		const headers = new Headers({ 'Content-Type': 'application/json' })
		if (options.key !== undefined) {
			headers.set('Authorization', `Bearer ${options.key}`)
		}
		const result = await exchange(options.fetch ?? fetch, target.url, () => ({
			method: 'POST',
			credentials: options.key === undefined ? 'same-origin' : 'omit',
			headers,
			body: JSON.stringify(input ?? {}),
		}), bounce)
		const parsed = z.safeParse(target.output, result)
		if (!parsed.success) {
			throw new RpcError({ type: 'invalid-response', message: `'${target.id}' answered a value its output schema refuses`, httpStatus: 200 })
		}
		return parsed.data
	}
}

interface TreeAt {
	readonly mount: string
	/** The origin the paths are joined to, without a trailing `/`. */
	readonly origin: string
	readonly base: string
	readonly path: string
}

function clientTree(tree: ProcedureTreeDeclaration<Schema, unknown>, at: TreeAt, make: (target: CallTarget) => unknown): Record<string, unknown> {
	const client: Record<string, unknown> = {}
	for (const [name, node] of Object.entries(tree)) {
		const path = at.path === '' ? name : `${at.path}.${name}`
		client[name] = isProcedure(node)
			? make({ id: `${at.mount}.${path}`, url: `${at.origin}${joinPath(at.base, path)}`, output: node.output })
			: clientTree(node, { ...at, path }, make)
	}
	return Object.freeze(client)
}

/** A function for every procedure of `tree` and a group for every nested tree: every declared call exists. */
function coversTree(value: unknown, tree: ProcedureTreeDeclaration<Schema, unknown>): boolean {
	if (typeof value !== 'object' || value === null) {
		return false
	}
	return Object.entries(tree).every(([name, node]) => {
		const member: unknown = Reflect.get(value, name)
		return isProcedure(node) ? typeof member === 'function' : coversTree(member, node)
	})
}

/** The page's origin when the client runs in a browser, else `null`. */
function pageOrigin(): string | null {
	const location: unknown = Reflect.get(globalThis, 'location')
	const origin: unknown = typeof location === 'object' && location !== null ? Reflect.get(location, 'origin') : undefined
	return typeof origin === 'string' ? origin : null
}

/**
 * The client of mount `mount` of `contract`: one function per declared procedure. A link mount's client sends its
 * share key as a bearer, so `options.key` is required there.
 */
export function createClient<const C extends AnyContract, const M extends ClientMount<C>>(
	contract: C,
	mount: M,
	...rest: OptionsFor<C, M>
): ContractClient<C, M> {
	const options: ClientOptions = rest[0] ?? {}
	const surface: Surface = contract.surface
	const node = SURFACE_SECTIONS.some((section) => section === mount) ? undefined : surface[mount]
	if (typeof node !== 'object' || !('kind' in node) || (node.kind !== 'rpc' && node.kind !== 'link')) {
		throw new Error(`'${mount}' is not an RPC or link mount of the contract`)
	}
	if (node.kind === 'link' && (options.key === undefined || options.key === '')) {
		throw new Error(`'${mount}' is a link mount; its client needs the share key`)
	}
	const base = node.kind === 'link' ? joinPath(node.prefix, LINK_API_SEGMENT) : node.prefix
	const bounce = resolveBounce(`${contract.vocabulary.app}:${mount}`, options.bounceOnAuth)
	const origin = (options.baseUrl ?? '').replace(/\/+$/, '')
	const page = pageOrigin()
	// A page's key goes only to the page's own application; a script names the application it calls.
	if (options.key !== undefined && page !== null && origin !== '' && new URL(origin, page).origin !== page) {
		throw new Error(`a client with a key in a browser calls only ${page}; baseUrl '${origin}' is another origin`)
	}
	const client = clientTree(node.procedures, { mount, origin, base, path: '' }, (target) => caller(target, options, bounce))
	// The tree was built from this mount's declaration; the check ties the value to the type the contract derives.
	const covers = (value: unknown): value is ContractClient<C, M> => coversTree(value, node.procedures)
	if (!covers(client)) {
		throw new Error(`the client of '${mount}' does not cover its procedures`)
	}
	return client
}
