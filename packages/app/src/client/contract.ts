// The typed client of one contract mount: `api.notes.remove({ id })` POSTs the input to `/api/notes.remove`, the
// path `compileContract` gives that procedure. Built from the contract value, so it can call only declared
// procedures, and it checks each answer against the procedure's output schema before handing it out. An attachment
// procedure answers a file, which `download(api.<procedure>, input)` fetches and saves.

import { z } from 'zod/v4'
import { type AttachmentBrand, attachmentOf } from '../contract/attachment'
import { isProcedure, type ProcedureTreeDeclaration, type ProcedureType, SURFACE_SECTIONS } from '../contract/declaration'
import { joinPath, LINK_API_SEGMENT } from '../contract/defaults'
import type { AnyContract, InputSchema, Procedure, Schema, Surface } from '../contract/define'
import { type FileClient, type FileTransport, type LinkCollections, type LinkFileClient, linkFiles, sessionFiles } from './files'
import { type BounceConfig, type BounceOption, exchange, exchangeFile, resolveBounce, RpcError, type RpcFetch } from './transport'

type SurfaceOf<C> = C extends { readonly surface: infer S } ? S : never

/** The mounts a client calls: RPC mounts and link mounts. */
export type ClientMount<C> =
	& { [M in keyof SurfaceOf<C>]: SurfaceOf<C>[M] extends { readonly kind: 'rpc' | 'link' } ? M : never }[keyof SurfaceOf<C>]
	& string

/**
 * One procedure: its input as the caller writes it (defaults optional), its output as parsed, and the output schema
 * it parses with (`@fabrika/app/react` reads a cached answer back through it).
 */
export type ProcedureCall<I, O extends Schema> =
	& ([I] extends [InputSchema] ? (input: z.input<I>) => Promise<z.output<O>> : (input?: Record<never, never>) => Promise<z.output<O>>)
	& { readonly output: O }

export type ClientTree<T> = {
	readonly [K in keyof T]: T[K] extends Procedure<'query' | 'mutation', infer I, infer O, unknown>
		? O extends AttachmentBrand ? AttachmentProcedure<I> : ProcedureCall<I, O>
		: ClientTree<T[K]>
}

type FilesOf<C> = SurfaceOf<C> extends { readonly files: infer F } ? F : Record<never, never>

/** `files.<name>` of every collection, for the signed-in callers of an RPC mount that admits people. */
type SessionFiles<C, Callers> = Callers extends readonly (infer Caller)[] ? 'human' extends Caller ? [keyof FilesOf<C>] extends [never] ? unknown
		: { readonly files: { readonly [N in keyof FilesOf<C>]: FileClient } }
	: unknown
	: unknown

/** `files.<name>` of every `link: true` collection, for a link mount's holders. */
type HolderFiles<C, M> = [LinkCollections<FilesOf<C>, M>] extends [never] ? unknown
	: { readonly files: { readonly [N in LinkCollections<FilesOf<C>, M>]: LinkFileClient } }

type MountOf<C, M> = SurfaceOf<C>[M & keyof SurfaceOf<C>]

/** One function per procedure, an `AttachmentProcedure` per attachment, and `files` where the mount's callers reach collections. */
export type ContractClient<C, M> = MountOf<C, M> extends { readonly kind: 'link'; readonly procedures: infer T } ? ClientTree<T> & HolderFiles<C, M>
	: MountOf<C, M> extends { readonly callers: infer Callers; readonly procedures: infer T } ? ClientTree<T> & SessionFiles<C, Callers>
	: never

/** The answer of a client procedure: `ResultOf<typeof api.tasks.get>`; an attachment procedure answers a `File`. */
export type ResultOf<F> = F extends (...args: never[]) => Promise<infer R> ? R : F extends AttachmentProcedure<unknown> ? File : never

/** The input of a client procedure as the caller writes it: `InputOf<typeof api.tasks.create>`. */
export type InputOf<F> = F extends (...args: infer A) => Promise<unknown> ? A[0]
	: F extends AttachmentProcedure<infer I> ? DownloadInput<I>[0]
	: never

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
	readonly type: ProcedureType
	readonly input: Schema | null
	readonly output: Schema
}

/**
 * What a value of a client tree is, kept beside it so the value stays a plain function or record: a procedure's
 * `<mount>.<path>`, its type and input schema, or a group's prefix. `@fabrika/app/react` keys its cache by it.
 */
export interface ClientNode {
	readonly mount: string
	/** The dotted path below the mount; `''` for the client itself. */
	readonly path: string
	readonly procedure: { readonly type: ProcedureType; readonly input: Schema | null } | null
}

const clientNodes = new WeakMap<object, ClientNode>()

/** The node a value of a client tree is, or `null` for any other value. */
export function clientNodeOf(value: unknown): ClientNode | null {
	return (typeof value === 'function' || (typeof value === 'object' && value !== null)) ? (clientNodes.get(value) ?? null) : null
}

/** The request of one procedure call: its input as JSON, with the key as a bearer or the page's session. */
function requestOf(options: ClientOptions, input: unknown): () => RequestInit {
	return () => {
		const headers = new Headers({ 'Content-Type': 'application/json' })
		if (options.key !== undefined) {
			headers.set('Authorization', `Bearer ${options.key}`)
		}
		return { method: 'POST', credentials: options.key === undefined ? 'same-origin' : 'omit', headers, body: JSON.stringify(input ?? {}) }
	}
}

function caller(target: CallTarget, at: TreeAt, options: ClientOptions, bounce: BounceConfig | null) {
	const call = async (input?: unknown): Promise<unknown> => {
		const result = await exchange(options.fetch ?? fetch, target.url, requestOf(options, input), bounce)
		const parsed = z.safeParse(target.output, result)
		if (!parsed.success) {
			throw new RpcError({ type: 'invalid-response', message: `'${target.id}' answered a value its output schema refuses`, httpStatus: 200 })
		}
		return parsed.data
	}
	Object.defineProperty(call, 'output', { value: target.output, enumerable: true })
	clientNodes.set(call, { mount: at.mount, path: at.path, procedure: { type: target.type, input: target.input } })
	return call
}

interface TreeAt {
	readonly mount: string
	/** The origin the paths are joined to, without a trailing `/`. */
	readonly origin: string
	readonly base: string
	readonly path: string
}

function clientTree(
	tree: ProcedureTreeDeclaration<Schema, unknown>,
	at: TreeAt,
	make: (target: CallTarget, at: TreeAt) => unknown,
): Record<string, unknown> {
	const client: Record<string, unknown> = {}
	for (const [name, node] of Object.entries(tree)) {
		const path = at.path === '' ? name : `${at.path}.${name}`
		client[name] = isProcedure(node)
			? make({ id: `${at.mount}.${path}`, url: `${at.origin}${joinPath(at.base, path)}`, type: node.type, input: node.input, output: node.output }, {
				...at,
				path,
			})
			: clientTree(node, { ...at, path }, make)
	}
	const group = Object.freeze(client)
	clientNodes.set(group, { mount: at.mount, path: at.path, procedure: null })
	return group
}

declare const attachmentInput: unique symbol

/**
 * An attachment procedure of a client: not a function, because its answer is a file. `download(api.<procedure>,
 * input)` fetches and saves it.
 */
export interface AttachmentProcedure<I> {
	/** `<mount>.<path>` */
	readonly id: string
	/** The file name the contract declares. */
	readonly filename: string
	/** Carries the input schema for `download`; never present at runtime. */
	readonly [attachmentInput]?: I
}

/** The request each attachment procedure sends and where it lies, kept beside it so the value itself carries no key. */
interface DownloadRequest {
	readonly url: string
	readonly filename: string
	readonly options: ClientOptions
	readonly bounce: BounceConfig | null
	readonly at: { readonly mount: string; readonly path: string }
}

const downloads = new WeakMap<object, DownloadRequest>()

function attachmentProcedure(
	target: CallTarget,
	at: TreeAt,
	filename: string,
	options: ClientOptions,
	bounce: BounceConfig | null,
): AttachmentProcedure<unknown> {
	const procedure = Object.freeze({ id: target.id, filename })
	downloads.set(procedure, { url: target.url, filename, options, bounce, at: { mount: at.mount, path: at.path } })
	return procedure
}

/** The mount and path of an attachment procedure of a client, or `null` for any other value. */
export function attachmentAt(value: unknown): { readonly mount: string; readonly path: string } | null {
	return typeof value === 'object' && value !== null ? (downloads.get(value)?.at ?? null) : null
}

/** The input `download` takes: the procedure's, or none. */
export type DownloadInput<I> = [I] extends [InputSchema] ? [input: z.input<I>] : [input?: Record<never, never>]

/**
 * Calls an attachment procedure and saves its file: in a browser the page offers it as a download under the declared
 * name. Answers the file, also where there is no page to save it from (a script, a test). A refusal is an `RpcError`.
 */
export function download<I>(procedure: AttachmentProcedure<I>, ...input: DownloadInput<I>): Promise<File> {
	if (!downloads.has(procedure)) {
		return Promise.reject(new Error(`'${procedure.id}' is not an attachment procedure of a client`))
	}
	return downloadFile(procedure, input[0])
}

/** `download` of any attachment procedure of a client, its input unchecked: the provider's `useDownload` runs it. */
export async function downloadFile(procedure: object, input: unknown): Promise<File> {
	const request = downloads.get(procedure)
	if (request === undefined) {
		throw new Error('download takes an attachment procedure of a client createClient made')
	}
	const { body } = await exchangeFile(request.options.fetch ?? fetch, request.url, requestOf(request.options, input), request.bounce)
	const file = new File([body], request.filename, { type: body.type })
	saveFile(file)
	return file
}

function saveFile(file: File): void {
	if (typeof document === 'undefined') {
		return
	}
	const url = URL.createObjectURL(file)
	const link = document.createElement('a')
	link.href = url
	link.download = file.name
	// A detached link downloads in every current browser; the page's document stays untouched.
	link.click()
	setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** A function for every procedure of `tree` and a group for every nested tree: every declared call exists. */
function coversTree(value: unknown, tree: ProcedureTreeDeclaration<Schema, unknown>): boolean {
	if (typeof value !== 'object' || value === null) {
		return false
	}
	return Object.entries(tree).every(([name, node]) => {
		const member: unknown = Reflect.get(value, name)
		if (!isProcedure(node)) {
			return coversTree(member, node)
		}
		return attachmentOf(node.output) === null
			? typeof member === 'function' && Reflect.get(member, 'output') === node.output
			: typeof member === 'object' && member !== null && downloads.has(member)
	})
}

/** A client of every collection in `names` under `files`, or no `files` at all. */
function coversFiles(value: unknown, names: readonly string[]): boolean {
	if (typeof value !== 'object' || value === null) {
		return false
	}
	const files: unknown = Reflect.get(value, 'files')
	if (names.length === 0) {
		return true
	}
	return typeof files === 'object' && files !== null && names.every((name) => typeof Reflect.get(files, name) === 'object')
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
	const procedures = clientTree(node.procedures, { mount, origin, base, path: '' }, (target, at) => {
		const mark = attachmentOf(target.output)
		return mark === null ? caller(target, at, options, bounce) : attachmentProcedure(target, at, mark.declaration.filename, options, bounce)
	})
	const transport: FileTransport = { origin, fetch: options.fetch ?? fetch, key: options.key, bounce }
	const collections = Object.entries(surface.files ?? {}).flatMap(([name, collection]): (readonly [string, FileClient | LinkFileClient])[] => {
		if (node.kind === 'link') {
			const serves = collection.link === true || (Array.isArray(collection.link) && collection.link.includes(mount))
			return serves ? [[name, linkFiles(transport, node.prefix, mount, name)]] : []
		}
		return node.callers.includes('human') ? [[name, sessionFiles(transport, name)]] : []
	})
	if (collections.length > 0 && Object.hasOwn(node.procedures, 'files')) {
		throw new Error(`'${mount}' has a procedure group named files, which the client of its file collections takes`)
	}
	const client = collections.length === 0 ? procedures : Object.freeze({ ...procedures, files: Object.freeze(Object.fromEntries(collections)) })
	// The client with its file collections is the mount's root too: `@fabrika/app/react` keys a provider by it.
	if (client !== procedures) clientNodes.set(client, { mount, path: '', procedure: null })
	// The tree was built from this mount's declaration; the check ties the value to the type the contract derives.
	const names = collections.map(([name]) => name)
	const covers = (value: unknown): value is ContractClient<C, M> => coversTree(value, node.procedures) && coversFiles(value, names)
	if (!covers(client)) {
		throw new Error(`the client of '${mount}' does not cover its procedures`)
	}
	return client
}
