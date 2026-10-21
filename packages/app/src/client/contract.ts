// The typed client of one contract mount: `api.notes.remove({ id })` POSTs the input to `/api/notes.remove`, the
// path `compileContract` gives that procedure (`procedurePath`, a public procedure's own `http.path` included). Built
// from the contract value, so it can call only declared procedures, and it checks each answer against the procedure's
// output schema before handing it out. An input with a file field goes as `multipart/form-data`: its JSON first, then
// each file. An attachment procedure and a procedure whose output is a file answer a file, which
// `download(api.<procedure>, input)` fetches; a GET one also has `url`.

import { z } from 'zod/v4'
import { type AttachmentBrand, attachmentOf } from '../contract/attachment'
import { isProcedure, type ProcedureTreeDeclaration, type ProcedureType, SURFACE_SECTIONS } from '../contract/declaration'
import { FILE_INPUT_PART } from '../contract/defaults'
import { challengePath, declaredChallengeAction, joinPath, LINK_API_SEGMENT, procedurePath } from '../contract/defaults'
import type { AnyContract, InputSchema, Procedure, Schema, Surface } from '../contract/define'
import { type ClientInput, type FileBrand, fileOf } from '../contract/file'
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
	& ([I] extends [InputSchema] ? (input: ClientInput<z.input<I>>) => Promise<z.output<O>> : (input?: Record<never, never>) => Promise<z.output<O>>)
	& { readonly output: O }

export type ClientTree<T> = {
	readonly [K in keyof T]: T[K] extends Procedure<'query' | 'mutation', infer I, infer O, unknown>
		? O extends AttachmentBrand ? AttachmentProcedure<I> : O extends FileBrand<string> ? FileProcedure<I> : ProcedureCall<I, O>
		: ClientTree<T[K]>
}

type MountOf<C, M> = SurfaceOf<C>[M & keyof SurfaceOf<C>]

/** One function per procedure, and an `AttachmentProcedure` or `FileProcedure` per procedure that answers a file. */
export type ContractClient<C, M> = MountOf<C, M> extends { readonly procedures: infer T } ? ClientTree<T> : never

/** The answer of a client procedure: `ResultOf<typeof api.tasks.get>`; a procedure that answers a file, a `DownloadedFile`. */
export type ResultOf<F> = F extends (...args: never[]) => Promise<infer R> ? R
	: F extends AttachmentProcedure<unknown> | FileProcedure<unknown> ? DownloadedFile
	: never

/** The input of a client procedure as the caller writes it: `InputOf<typeof api.tasks.create>`. */
export type InputOf<F> = F extends (...args: infer A) => Promise<unknown> ? A[0]
	: F extends AttachmentProcedure<infer I> | FileProcedure<infer I> ? DownloadInput<I>[0]
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
	/** `GET` for a procedure whose `http` says so: its input travels in the URL. */
	readonly method: 'GET' | 'POST'
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
/** A GET call: its input travels in the URL, its credential as a POST's does. */
function getRequestOf(options: ClientOptions): () => RequestInit {
	return () => {
		const headers = new Headers({ Accept: 'application/json' })
		if (options.key !== undefined) {
			headers.set('Authorization', `Bearer ${options.key}`)
		}
		return { method: 'GET', credentials: options.key === undefined ? 'same-origin' : 'omit', headers }
	}
}

function requestOf(options: ClientOptions, input: unknown): () => RequestInit {
	return () => {
		const files = fileValues(input)
		// A multipart body's boundary is the one `fetch` writes, so its Content-Type is left to it.
		// `Accept` asks a `redirect()` procedure for its target as JSON instead of a redirect the fetch would follow.
		const headers = new Headers(files === null ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' })
		if (options.key !== undefined) {
			headers.set('Authorization', `Bearer ${options.key}`)
		}
		const body = files === null ? JSON.stringify(input ?? {}) : multipartBody(files)
		return { method: 'POST', credentials: options.key === undefined ? 'same-origin' : 'omit', headers, body }
	}
}

/** An input's file fields and the rest: `null` when it holds no `Blob`, so it goes as JSON. */
function fileValues(input: unknown): { readonly json: Record<string, unknown>; readonly files: readonly (readonly [string, Blob])[] } | null {
	if (typeof input !== 'object' || input === null) {
		return null
	}
	const json: Record<string, unknown> = {}
	const files: (readonly [string, Blob])[] = []
	for (const [name, value] of Object.entries(input)) {
		if (value instanceof Blob) {
			files.push([name, value])
		} else if (Array.isArray(value) && value.length > 0 && value.every((item) => item instanceof Blob)) {
			for (const item of value) files.push([name, item])
		} else {
			json[name] = value
		}
	}
	return files.length === 0 ? null : { json, files }
}

/** The multipart body of an input with files: the JSON input part first, then each file under its field's name. */
function multipartBody(input: { readonly json: Record<string, unknown>; readonly files: readonly (readonly [string, Blob])[] }): FormData {
	const form = new FormData()
	form.append(FILE_INPUT_PART, JSON.stringify(input.json))
	for (const [name, file] of input.files) {
		form.append(name, file, file instanceof File ? file.name : name)
	}
	return form
}

/** A GET's input as the URL's parameters: each scalar field in its canonical spelling; an absent one left out. */
function withParams(url: string, input: unknown): string {
	const params = new URLSearchParams()
	for (const [name, value] of Object.entries(typeof input === 'object' && input !== null ? input : {})) {
		if (value !== undefined) params.set(name, value === null ? 'null' : String(value))
	}
	const query = params.toString()
	return query === '' ? url : `${url}?${query}`
}

function caller(target: CallTarget, at: TreeAt, options: ClientOptions, bounce: BounceConfig | null) {
	const call = async (input?: unknown): Promise<unknown> => {
		const result = target.method === 'GET'
			? await exchange(options.fetch ?? fetch, withParams(target.url, input), getRequestOf(options), bounce)
			: await exchange(options.fetch ?? fetch, target.url, requestOf(options, input), bounce)
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

/**
 * The method a procedure's `http` declares: `GET` where written, and for a query that answers a file or declares
 * `http.cache`; `POST` otherwise.
 */
function httpMethodOf(http: unknown, type: ProcedureType, output: Schema): 'GET' | 'POST' {
	if (typeof http === 'object' && http !== null && Reflect.get(http, 'method') !== undefined) {
		return Reflect.get(http, 'method') === 'GET' ? 'GET' : 'POST'
	}
	const caches = typeof http === 'object' && http !== null && Reflect.get(http, 'cache') !== undefined
	return type === 'query' && (fileOf(output) !== null || caches) ? 'GET' : 'POST'
}

interface TreeAt {
	readonly mount: string
	/** The origin the paths are joined to, without a trailing `/`. */
	readonly origin: string
	readonly base: string
	readonly path: string
}

/** Where each procedure of a client with an ALTCHA challenge fetches it, by the procedure's value. */
const challengeUrls = new WeakMap<object, string>()

/**
 * The URL a page's ALTCHA widget fetches the challenge of `procedure` from (`GET /__fabrika/challenge/<action>`), on the
 * client's `baseUrl`. Throws for a procedure whose `admission.challenge` is not `provider: 'altcha'`.
 */
export function challengeUrl(procedure: object): string {
	const url = challengeUrls.get(procedure)
	if (url === undefined) {
		throw new Error("challengeUrl takes a procedure of a client createClient made whose admission.challenge is provider: 'altcha'")
	}
	return url
}

/** The action of a procedure's declared ALTCHA challenge, or `null`; `buildArtifact` refuses every other shape. */
function altchaActionOf(admission: unknown, id: string): string | null {
	const challenge: unknown = typeof admission === 'object' && admission !== null ? Reflect.get(admission, 'challenge') : undefined
	if (typeof challenge !== 'object' || challenge === null || Reflect.get(challenge, 'provider') !== 'altcha') {
		return null
	}
	return declaredChallengeAction(id, Reflect.get(challenge, 'action'))
}

function clientTree(
	tree: ProcedureTreeDeclaration<Schema, unknown>,
	at: TreeAt,
	make: (target: CallTarget, at: TreeAt) => unknown,
): Record<string, unknown> {
	const client: Record<string, unknown> = {}
	for (const [name, node] of Object.entries(tree)) {
		const path = at.path === '' ? name : `${at.path}.${name}`
		if (!isProcedure(node)) {
			client[name] = clientTree(node, { ...at, path }, make)
			continue
		}
		const id = `${at.mount}.${path}`
		const made = make({
			id,
			url: `${at.origin}${procedurePath(at.base, path, node.http)}`,
			method: httpMethodOf(node.http, node.type, node.output),
			type: node.type,
			input: node.input,
			output: node.output,
		}, {
			...at,
			path,
		})
		const action = altchaActionOf(node.admission, id)
		if (action !== null && (typeof made === 'function' || (typeof made === 'object' && made !== null))) {
			challengeUrls.set(made, `${at.origin}${challengePath(action)}`)
		}
		client[name] = made
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

/**
 * A procedure whose output is a file (`file('<kind>')`): not a function, because its answer is a file.
 * `download(api.<procedure>, input)` fetches it with the caller's credential, and a GET one's `url(input)` is where a
 * same-origin page links to it (`<img src>`, `<a download>`).
 */
export interface FileProcedure<I> {
	/** `<mount>.<path>` */
	readonly id: string
	/**
	 * The URL of the file a GET procedure answers, for a page signed in on the same origin. A client with a key has none:
	 * a key never goes into a URL, so it downloads instead.
	 */
	url(...input: DownloadInput<I>): string
	/** Carries the input schema for `download`; never present at runtime. */
	readonly [attachmentInput]?: I
}

/** The request each file procedure sends and where it lies, kept beside it so the value itself carries no key. */
interface DownloadRequest {
	readonly url: string
	readonly method: 'GET' | 'POST'
	/** The name an attachment declares; `null` where the answer names its file. */
	readonly filename: string | null
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
	downloads.set(procedure, { url: target.url, method: 'POST', filename, options, bounce, at: { mount: at.mount, path: at.path } })
	return procedure
}

function fileProcedure(target: CallTarget, at: TreeAt, options: ClientOptions, bounce: BounceConfig | null): FileProcedure<unknown> {
	const url = (input?: unknown): string => {
		if (target.method !== 'GET') {
			throw new Error(`'${target.id}' answers its file to a POST; fetch it with download(…)`)
		}
		if (options.key !== undefined) {
			throw new Error(`'${target.id}': a client with a key fetches the file with download(…); a key never goes into a URL`)
		}
		return withParams(target.url, input)
	}
	const procedure = Object.freeze({ id: target.id, url })
	downloads.set(procedure, { url: target.url, method: target.method, filename: null, options, bounce, at: { mount: at.mount, path: at.path } })
	return procedure
}

/** A downloaded file: a `File`, and the page's offer to save it. */
export class DownloadedFile extends File {
	/** The file as a `Blob`. */
	blob(): Blob {
		return this
	}

	/** Offers the file as a download under its name; nothing where there is no page. */
	save(): void {
		saveFile(this)
	}
}

/** The name of a file from its `Content-Disposition` (`filename*=UTF-8''…`), or `null`. */
function dispositionName(disposition: string | null): string | null {
	const encoded = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
	if (encoded === undefined) {
		return null
	}
	try {
		return decodeURIComponent(encoded)
	} catch {
		return null
	}
}

/** The mount and path of an attachment procedure of a client, or `null` for any other value. */
export function attachmentAt(value: unknown): { readonly mount: string; readonly path: string } | null {
	return typeof value === 'object' && value !== null ? (downloads.get(value)?.at ?? null) : null
}

/** The input `download` takes: the procedure's, or none. */
export type DownloadInput<I> = [I] extends [InputSchema] ? [input: z.input<I>] : [input?: Record<never, never>]

/**
 * Calls a procedure that answers a file (an attachment, or a `file('<kind>')` output) with the caller's credential, and
 * answers the file: `blob()`, `stream()`, `save()`. An attachment is also offered as a download in a browser, under the
 * declared name. A refusal is an `RpcError`.
 */
export function download<I>(procedure: AttachmentProcedure<I> | FileProcedure<I>, ...input: DownloadInput<I>): Promise<DownloadedFile> {
	if (!downloads.has(procedure)) {
		return Promise.reject(new Error(`'${procedure.id}' answers no file`))
	}
	return downloadFile(procedure, input[0])
}

/** `download` of any file procedure of a client, its input unchecked: the provider's `useDownload` runs it. */
export async function downloadFile(procedure: object, input: unknown): Promise<DownloadedFile> {
	const request = downloads.get(procedure)
	if (request === undefined) {
		throw new Error('download takes a procedure of a client createClient made that answers a file')
	}
	const doFetch = request.options.fetch ?? fetch
	const { body, disposition } = request.method === 'GET'
		? await exchangeFile(doFetch, withParams(request.url, input), getRequestOf(request.options), request.bounce)
		: await exchangeFile(doFetch, request.url, requestOf(request.options, input), request.bounce)
	const file = new DownloadedFile([body], request.filename ?? dispositionName(disposition) ?? 'download', { type: body.type })
	if (request.filename !== null) {
		saveFile(file)
	}
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
		return attachmentOf(node.output) === null && fileOf(node.output) === null
			? typeof member === 'function' && Reflect.get(member, 'output') === node.output
			: typeof member === 'object' && member !== null && downloads.has(member)
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
	const procedures = clientTree(node.procedures, { mount, origin, base, path: '' }, (target, at) => {
		const mark = attachmentOf(target.output)
		if (mark !== null) {
			return attachmentProcedure(target, at, mark.declaration.filename, options, bounce)
		}
		return fileOf(target.output) === null ? caller(target, at, options, bounce) : fileProcedure(target, at, options, bounce)
	})
	// The tree was built from this mount's declaration; the check ties the value to the type the contract derives.
	const covers = (value: unknown): value is ContractClient<C, M> => coversTree(value, node.procedures)
	if (!covers(procedures)) {
		throw new Error(`the client of '${mount}' does not cover its procedures`)
	}
	return procedures
}
