// The file collections of a typed client: `api.files.<name>` for a signed-in caller of an RPC mount, and
// `<link client>.files.<name>` for a link holder, whose owner is the link's object. The paths come from
// `fileCollectionPaths`, the code that gives the artifact its rows; every answer is parsed before the caller sees it.

import { z } from 'zod/v4'
import { fileCollectionPaths, FILES_PREFIX, joinPath, LINK_API_SEGMENT } from '../contract/defaults'
import type { FileCollection } from '../contract/define'
import { FileListOutput } from '../files/schemas'
import { type BounceConfig, exchange, exchangeFile, RpcError, type RpcFetch } from './transport'

/** A page of an owner's files, oldest first, as `files.<name>.list` answers it. */
export type FileList = z.output<typeof FileListOutput>

export interface FilePage {
	/** The id of the last file of the previous page. */
	readonly after?: string
	/** 1–100, 50 by default. */
	readonly limit?: number
}

export interface UploadOptions {
	/** The file's name, metadata only; a `File`'s own name by default. */
	readonly name?: string
}

/** One collection, for a signed-in caller: the owner is a parameter, checked against the caller's grants. */
export interface FileClient {
	/** Uploads `file` (its `type` is the declared media type) to `owner`; answers the new file's id. */
	upload(owner: string, file: Blob, options?: UploadOptions): Promise<{ readonly id: string }>
	/** The owner's files, oldest first. */
	list(input: { readonly owner: string } & FilePage): Promise<FileList>
	/** The file `id`, named as it was uploaded. A refusal is an `RpcError`: 409 `quarantined` while it is being scanned. */
	download(id: string): Promise<File>
	remove(input: { readonly id: string }): Promise<{ readonly id: string }>
}

/** One collection, for a link holder: the owner is the object the key is bound to, never a parameter. */
export interface LinkFileClient {
	upload(file: Blob, options?: UploadOptions): Promise<{ readonly id: string }>
	list(input?: FilePage): Promise<FileList>
	download(id: string): Promise<File>
}

/** The collections the holders of link mount `M` reach: those with `link: true`, and those whose `link` names `M`. */
export type LinkCollections<F, M> = {
	[N in keyof F]: F[N] extends FileCollection<string, infer L>
		? true extends L ? N : L extends readonly (infer Named)[] ? M extends Named ? N : never : never
		: never
}[keyof F]

/** What a client sends with every request: its key as a bearer, or the page's session. */
export interface FileTransport {
	readonly origin: string
	readonly fetch: RpcFetch
	readonly key: string | undefined
	readonly bounce: BounceConfig | null
}

const Uploaded = z.strictObject({ id: z.uuid() })

/** The request, built inside the transport's guard: the key as a bearer and no cookie, or the page's session. */
function init(transport: FileTransport, method: 'GET' | 'POST', contentType: string | null, body?: BodyInit): () => RequestInit {
	return () => {
		const headers = new Headers()
		if (contentType !== null) {
			headers.set('Content-Type', contentType)
		}
		if (transport.key !== undefined) {
			headers.set('Authorization', `Bearer ${transport.key}`)
		}
		return { method, credentials: transport.key === undefined ? 'same-origin' : 'omit', headers, ...(body === undefined ? {} : { body }) }
	}
}

async function call<S extends z.ZodType>(transport: FileTransport, url: string, input: unknown, output: S, id: string): Promise<z.output<S>> {
	const request = init(transport, 'POST', 'application/json', JSON.stringify(input ?? {}))
	const parsed = z.safeParse(output, await exchange(transport.fetch, url, request, transport.bounce))
	if (!parsed.success) {
		throw new RpcError({ type: 'invalid-response', message: `'${id}' answered a value its output schema refuses`, httpStatus: 200 })
	}
	return parsed.data
}

async function upload(transport: FileTransport, path: string, file: Blob, options: UploadOptions, id: string): Promise<{ readonly id: string }> {
	const name = options.name ?? (file instanceof File ? file.name : '')
	const url = `${transport.origin}${path}${name === '' ? '' : `?${new URLSearchParams({ name })}`}`
	const parsed = z.safeParse(Uploaded, await exchange(transport.fetch, url, init(transport, 'POST', file.type, file), transport.bounce))
	if (!parsed.success) {
		throw new RpcError({ type: 'invalid-response', message: `'${id}' answered a value its output schema refuses`, httpStatus: 200 })
	}
	return parsed.data
}

/** `filename*=UTF-8''…` of a download's `Content-Disposition`, as `files/treatment.ts` writes it. */
function nameOf(disposition: string | null, fallback: string): string {
	const encoded = disposition?.match(/filename\*=UTF-8''([^;]+)/)?.[1]
	if (encoded === undefined) {
		return fallback
	}
	try {
		return decodeURIComponent(encoded)
	} catch {
		return fallback
	}
}

async function download(transport: FileTransport, path: string, file: string): Promise<File> {
	const url = `${transport.origin}${path}/${encodeURIComponent(file)}`
	const answer = await exchangeFile(transport.fetch, url, init(transport, 'GET', null), transport.bounce)
	return new File([answer.body], nameOf(answer.disposition, file), { type: answer.body.type })
}

/** The collection `name` for a signed-in caller. */
export function sessionFiles(transport: FileTransport, name: string): FileClient {
	const paths = fileCollectionPaths(FILES_PREFIX, name)
	const id = `files.${name}`
	return Object.freeze({
		upload: (owner: string, file: Blob, options: UploadOptions = {}) =>
			upload(transport, `${paths.upload}/${encodeURIComponent(owner)}`, file, options, `${id}.upload`),
		list: (input: { readonly owner: string } & FilePage) => call(transport, `${transport.origin}${paths.list}`, input, FileListOutput, `${id}.list`),
		download: (file: string) => download(transport, paths.download, file),
		remove: (input: { readonly id: string }) => call(transport, `${transport.origin}${paths.remove}`, input, Uploaded, `${id}.remove`),
	})
}

/** The collection `name` for a holder of a key of the link mount at `prefix`. */
export function linkFiles(transport: FileTransport, prefix: string, mount: string, name: string): LinkFileClient {
	const paths = fileCollectionPaths(joinPath(prefix, LINK_API_SEGMENT), name)
	const id = `${mount}.files.${name}`
	return Object.freeze({
		upload: (file: Blob, options: UploadOptions = {}) => upload(transport, paths.upload, file, options, `${id}.upload`),
		list: (input: FilePage = {}) => call(transport, `${transport.origin}${paths.list}`, input, FileListOutput, `${id}.list`),
		download: (file: string) => download(transport, paths.download, file),
	})
}
