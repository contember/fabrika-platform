// The runtime of `c.files`: the generated upload, download, list and remove endpoints, the locator of every
// `file:<name>` dimension, the scan pass of `scan: true` collections (`scan.ts`), and the sweep that deletes the objects
// of removed, orphaned and abandoned files. Access is the core's:
// the dispatcher checks the access form and mints the target, and every database operation here takes that target,
// so `@fabrika/db` scopes it by the whole chain the access check saw.

import type { ContractArtifact, CredentialedEndpoint, EndpointRow, FileCollectionArtifact } from '@fabrika/auth-core'
import type { CapabilityAuthority, RefGrant } from '@fabrika/db/capability'
import {
	type FileCollectionTable,
	fileTableName,
	fileTablesOf,
	type FormFiles,
	frameworkTablesOf,
	isScopedDatabase,
	QueryRefusedError,
	type Session,
	type StoredFile,
	type WrittenFormFile,
} from '@fabrika/db/framework'
import { type FileObjectStore, type StoredObject, uuidv7 } from '@fabrika/platform'
import { z } from 'zod/v4'
import { FILE_LIMITS } from '../contract/defaults'
import { FileLinkListInput, FileListInput, FileListOutput } from '../contract/file-schemas'
import { HttpError, jsonResponse, NotFoundError } from '../errors'
import { type CapabilityMint, CapabilityRefusedError, type RequestFrame } from '../implement/capability'
import { NO_FACILITIES, type ServedEndpoint } from '../implement/dispatch'
import { ServerFault } from '../implement/faults'
import type { ContractDatabase, ImplementationDatabase } from '../implement/implement'
import type { OperationsReporter } from '../jobs/report'
import type { FileCollectionJobHandle, FileCollections as FilesOfSite, FileListing, FileListPage, OpenedFile, OpenOptions } from './handle'
import { type FileScanner, runScanPass } from './scan'
import { bytesAreOfType, SNIFF_BYTES, SNIFFABLE_TYPES } from './sniff'
import { FileDownload } from './treatment'

/** Which step of a file cleanup or sweep failed: the whole of what its log line says about the failure. */
type FileCleanupStep = 'rows_read_failed' | 'object_delete_failed' | 'row_delete_failed'

/** How many removable files one sweep handles; the next remove picks up the rest. */
const SWEEP_BATCH = 20
const MAX_NAME_CODE_POINTS = 255
/** An upload whose body has not arrived by then fails, so its pending row is abandoned well before the grace ends. */
export const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000
/** A pending row older than this is an upload that will never complete; the sweep deletes its object and the row. */
export const PENDING_GRACE_MS = 60 * 60 * 1000
/**
 * The framework's sweep job: hourly, it deletes the objects of every collection's removed and orphaned files and of
 * abandoned uploads, so none waits for the next request. A reserved name with `-`, which no `c.cron` name can take;
 * `@fabrika/provider-zerops` writes it into the crontab on this schedule (`ZEROPS_FILE_SWEEP_JOB`).
 */
export const FILE_SWEEP_JOB = 'fabrika-file-sweep'
export const FILE_SWEEP_SCHEDULE = '41 * * * *'
export const FILE_SWEEP_TIMEOUT_MS = 10 * 60_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const ById = z.strictObject({ id: z.uuid() })

/** Where `ctx.files` runs: the site's frame, the session its statements run in, and whether it may remove. */
export interface FileSite {
	/** `job 'erase'`, an endpoint id: named in a refusal. */
	readonly where: string
	readonly frame: RequestFrame
	/** Throws once the site's work ended, or when called from other work. */
	readonly check: () => void
	/** The invocation's transaction, a job's fenced transaction, or a job's statement-at-a-time session. */
	readonly session: () => Promise<Session>
	/** `null` where `removeAll` runs (a mutation, a job's transaction); otherwise why it does not. */
	readonly readOnly: string | null
	/** Whether `attach` runs here: only in a job's transaction, the job that drains a form's inbox. */
	readonly attaches: boolean
}

interface Collection {
	readonly name: string
	readonly artifact: FileCollectionArtifact
	readonly dimension: string
	/** The owner table's dimension, which `file:<name>` lies in. */
	readonly ownerDimension: string
	readonly table: FileCollectionTable
	/** The link mounts bound to the owner's dimension, for a `link: true` collection: each serves its link holders. */
	readonly linkMounts: readonly string[]
}

/** The media type of a `Content-Type` value, without parameters, lower-cased. */
function mediaType(header: string | null): string | null {
	const type = header?.split(';')[0]?.trim().toLowerCase()
	return type === undefined || type === '' ? null : type
}

/** The client's file name, metadata only: at most 255 code points, never half a character, no control characters. */
export function originalName(request: Request): string | null {
	return cleanName(new URL(request.url).searchParams.get('name') ?? '')
}

function cleanName(raw: string): string | null {
	const name = Array.from(raw.replace(/\p{Cc}/gu, '').trim()).slice(0, MAX_NAME_CODE_POINTS).join('')
	return name === '' ? null : name
}

/** One file part of a form's submission, as the multipart reader hands it over. */
export interface FormFilePart {
	readonly filename: string | null
	/** The media type the part declares; the bytes must be of it. */
	readonly contentType: string | null
	readonly body: ReadableStream<Uint8Array>
}

/** A form's file whose object is written under its pending row: what the inbox append holds, or a failure cleans up. */
export interface ReceivedFormFile extends WrittenFormFile {
	readonly objectKey: string
}

/** The first `size` bytes of `body`, and a stream that yields the whole body again. */
async function readHead(
	body: ReadableStream<Uint8Array>,
	size: number,
): Promise<{ readonly head: Uint8Array; readonly stream: ReadableStream<Uint8Array> }> {
	const reader = body.getReader()
	const chunks: Uint8Array[] = []
	let length = 0
	let done = false
	while (length < size) {
		const next = await reader.read()
		if (next.done) {
			done = true
			break
		}
		chunks.push(next.value)
		length += next.value.byteLength
	}
	const buffered = new Uint8Array(length)
	let offset = 0
	for (const chunk of chunks) {
		buffered.set(chunk, offset)
		offset += chunk.byteLength
	}
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			if (buffered.byteLength > 0) {
				controller.enqueue(buffered)
			}
			if (done) {
				controller.close()
			}
		},
		async pull(controller) {
			const next = await reader.read()
			if (next.done) {
				controller.close()
			} else {
				controller.enqueue(next.value)
			}
		},
		cancel: (reason) => reader.cancel(reason),
	})
	return { head: buffered.subarray(0, size), stream }
}

/** The body as it is stored: hashed on the way, and failed once `timeoutMs` (`null`: no timer) passes before it ends. */
function digesting(body: ReadableStream<Uint8Array>, timeoutMs: number | null): {
	readonly stream: ReadableStream<Uint8Array>
	digest(): string
	timedOut(): boolean
	stop(): void
} {
	const hasher = new Bun.CryptoHasher('sha256')
	let timer: ReturnType<typeof setTimeout> | undefined
	let expired = false
	const stream = body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			start(controller) {
				if (timeoutMs !== null) {
					timer = setTimeout(() => {
						expired = true
						controller.error(new Error('the upload did not finish in time'))
					}, timeoutMs)
				}
			},
			transform(chunk, controller) {
				hasher.update(chunk)
				controller.enqueue(chunk)
			},
			flush() {
				clearTimeout(timer)
			},
		}),
	)
	return { stream, digest: () => hasher.digest('hex'), timedOut: () => expired, stop: () => clearTimeout(timer) }
}

/** The whole body when it holds exactly `size` bytes; `null` as soon as it proves longer, or once it ends shorter. */
async function readExactly(body: ReadableStream<Uint8Array>, size: number): Promise<Uint8Array | null> {
	const bytes = new Uint8Array(size)
	let length = 0
	const reader = body.getReader()
	try {
		for (let next = await reader.read(); !next.done; next = await reader.read()) {
			if (length + next.value.byteLength > size) {
				return null
			}
			bytes.set(next.value, length)
			length += next.value.byteLength
		}
	} finally {
		reader.releaseLock()
	}
	return length === size ? bytes : null
}

function isNamed(error: unknown, name: string): boolean {
	return error instanceof Error && error.name === name
}

export class FileCollections {
	readonly #collections: readonly Collection[]
	readonly #byDimension: ReadonlyMap<string, Collection>
	readonly #store: FileObjectStore
	readonly #capabilities: CapabilityAuthority
	readonly #mint: CapabilityMint
	/** The files forms received, before they have an owner (`fabrika_form_files`). */
	readonly #formFiles: FormFiles

	constructor(
		collections: readonly Collection[],
		store: FileObjectStore,
		capabilities: CapabilityAuthority,
		mint: CapabilityMint,
		formFiles: FormFiles,
	) {
		this.#collections = collections
		this.#byDimension = new Map(collections.map((collection) => [collection.dimension, collection]))
		this.#store = store
		this.#capabilities = capabilities
		this.#mint = mint
		this.#formFiles = formFiles
	}

	/** Whether the contract declares the collection `name`, so a form's file can land in it. */
	has(name: string): boolean {
		return this.#collections.some((collection) => collection.name === name)
	}

	/** The largest file collection `name` admits; 0 for a collection it does not serve. */
	maxBytesOf(name: string): number {
		return this.#collections.find((collection) => collection.name === name)?.artifact.maxBytes ?? 0
	}

	/** `ctx.files` of one site: each collection's handle, by its name. */
	site(site: FileSite): FilesOfSite<FileCollectionJobHandle> {
		const handles = new Map(this.#collections.map((collection) => [collection.name, this.#handle(collection, site)]))
		return (name) => {
			site.check()
			const handle = typeof name === 'string' ? handles.get(name) : undefined
			if (handle === undefined) {
				throw new ServerFault(
					'file_collection_unknown',
					`${site.where}: ctx.files('${String(name)}') names no collection of the contract (collections: ${[...handles.keys()].join(', ')})`,
				)
			}
			return handle
		}
	}

	#handle(collection: Collection, site: FileSite): FileCollectionJobHandle {
		return Object.freeze({
			list: async (owner: unknown, page: FileListPage = {}) => {
				site.check()
				this.#ownerGrant(collection, site, owner, ['read'])
				return await this.#listOwned(collection, site, owner, page)
			},
			open: async (owner: unknown, id: unknown, options: OpenOptions) => {
				site.check()
				const grant = this.#ownerGrant(collection, site, owner, ['read'])
				return await this.#open(collection, site, grant, id, options)
			},
			removeAll: async (owner: unknown) => {
				site.check()
				if (site.readOnly !== null) {
					throw new QueryRefusedError('read_only', `${site.where}: files '${collection.name}' removeAll: ${site.readOnly}`)
				}
				this.#ownerGrant(collection, site, owner, ['delete'])
				return await collection.table.removeOwned(owner, new Date(), await site.session())
			},
			attach: async (owner: unknown, id: unknown) => {
				site.check()
				if (!site.attaches) {
					throw new QueryRefusedError(
						'undeclared_reach',
						`${site.where}: files '${collection.name}' attach runs only in a job's ctx.transaction((tx) => …), as tx.files`,
					)
				}
				const grant = this.#ownerGrant(collection, site, owner, ['write'])
				if (typeof id !== 'string') {
					throw new QueryRefusedError('invalid_argument', `${site.where}: files '${collection.name}' attach takes the id of a form's file`)
				}
				return await this.#attach(collection, grant, owner, id, await site.session())
			},
		})
	}

	/**
	 * Moves the file a form received under `id` into the collection, owned by `owner`, in `session`: the transaction
	 * that wrote the owner, so a rollback leaves the file held. A scanning collection holds it `quarantined` until the
	 * scan job's verdict. `false` when no held file of this collection has the id (never received, of another collection,
	 * or its hold ended); `true` again for a file this owner attached before, so a retried attempt answers alike.
	 */
	async #attach(collection: Collection, grant: RefGrant, owner: unknown, id: string, session: Session): Promise<boolean> {
		const claimed = await this.#formFiles.claim(collection.name, id, session)
		if (claimed === null) {
			const located = UUID.test(id) ? await collection.table.locate(id, session) : null
			return located !== null && located.get(grant.dimension) === grant.id
				&& [...grant.chain].every(([dimension, value]) => located.get(dimension) === value)
		}
		// Thrown, not answered: the transaction rolls back, and the claimed file stays held for a later attempt.
		const limit = collection.artifact.maxPerOwner
		if ((await collection.table.adopt(owner, claimed, session, limit)) === 'limit') {
			throw tooMany(collection)
		}
		// Counted again: an upload of a person may have passed its own count beside this one.
		if (limit !== null && (await collection.table.countHeld(owner, session)) > limit) {
			throw tooMany(collection)
		}
		return true
	}

	/**
	 * Receives one file of a form's submission into collection `name`: the part's declared type must be one the
	 * collection admits and its first bytes that type, its row in `fabrika_form_files` is written pending before its
	 * object `<name>/<id>`, and the object stops at the collection's `maxBytes`. Answers `null` for an empty part without
	 * a file name: a file input the visitor left empty. Whatever fails after the row cleans the object and the row up.
	 */
	async receiveFormFile(form: string, name: string, part: FormFilePart): Promise<ReceivedFormFile | null> {
		const collection = this.#collections.find((candidate) => candidate.name === name)
		if (collection === undefined) {
			await part.body.cancel()
			throw new ServerFault('contract_inconsistent', `form '${form}' takes a file into files '${name}', which is not served`)
		}
		const { artifact } = collection
		const { head, stream } = await readHead(part.body, SNIFF_BYTES)
		if (head.byteLength === 0 && (part.filename === null || part.filename === '')) {
			// The part ended with no byte: it was read to its end, and the next part may follow.
			return null
		}
		const type = part.contentType
		if (type === null || !artifact.types.includes(type)) {
			await stream.cancel()
			throw new HttpError(415, 'unsupported_media_type', `files '${name}' admits ${artifact.types.join(', ')}`)
		}
		if (!bytesAreOfType(type, head)) {
			await stream.cancel()
			throw new HttpError(415, 'unsupported_media_type', `The bytes of the file are not ${type}`)
		}
		if (head.byteLength === 0 && artifact.scan === true) {
			await stream.cancel()
			throw new HttpError(400, 'empty', `files '${name}' scans its files and admits no empty file`)
		}
		const id = uuidv7()
		const objectKey = `${name}/${id}`
		await this.#formFiles.stage({ id, form, collection: name, objectKey, contentType: type, originalName: cleanName(part.filename ?? '') })
		// The form's own deadline bounds the whole body, so the digest needs no timer of its own.
		const body = digesting(stream, null)
		try {
			const { size } = await this.#store.write(objectKey, body.stream, { contentType: type, maxBytes: artifact.maxBytes })
			return Object.freeze({ id, objectKey, size, sha256: body.digest() })
		} catch (error) {
			if (isNamed(error, 'ObjectExistsError')) {
				// The key holds an object this submission did not write: never delete it, only the pending row.
				await this.#formFiles.abandon(id)
				throw new ServerFault('file_key_taken', `files '${name}' found an object already under a new file's key`)
			}
			await this.releaseFormFiles([{ id, objectKey }])
			if (isNamed(error, 'ObjectTooLargeError')) {
				throw tooLarge(collection)
			}
			throw error
		} finally {
			body.stop()
		}
	}

	/**
	 * Deletes the objects of files a submission received and then their pending rows: it did not commit. A failed step is
	 * logged by its name and left for the sweep, which deletes a pending row after `PENDING_GRACE_MS`.
	 */
	async releaseFormFiles(files: readonly { readonly id: string; readonly objectKey: string }[]): Promise<void> {
		for (const file of files) {
			let step: FileCleanupStep = 'object_delete_failed'
			try {
				await this.#store.delete(file.objectKey)
				step = 'row_delete_failed'
				await this.#formFiles.abandon(file.id)
			} catch {
				console.error(`fabrika: form files cleanup: ${step}`)
			}
		}
	}

	/** One batch of the form files whose hold ended or whose submission never committed: the object, then the row. */
	async #sweepFormFiles(): Promise<'more' | 'done' | 'failed'> {
		let step: FileCleanupStep = 'rows_read_failed'
		try {
			const batch = await this.#formFiles.removable(SWEEP_BATCH, PENDING_GRACE_MS)
			for (const file of batch) {
				step = 'object_delete_failed'
				await this.#store.delete(file.objectKey)
				step = 'row_delete_failed'
				await this.#formFiles.purge(file.id, PENDING_GRACE_MS)
			}
			return batch.length === SWEEP_BATCH ? 'more' : 'done'
		} catch {
			console.error(`fabrika: form files sweep: ${step}`)
			return 'failed'
		}
	}

	/**
	 * The grant of `owner`: a `Ref` of the collection's owner, of the work running now, for one of the collection's
	 * `actions`: `read` lists and opens, `delete` removes. A write capability alone reads no file's name or bytes.
	 */
	#ownerGrant(collection: Collection, site: FileSite, owner: unknown, actions: readonly ('read' | 'write' | 'delete')[]): RefGrant {
		const grant = this.#capabilities.resolve(owner)
		const needed = actions.map((action) => collection.artifact[action])
		if (grant.kind !== 'ref' || grant.dimension !== collection.ownerDimension || !needed.includes(grant.action)) {
			throw new CapabilityRefusedError(
				'wrong_capability',
				`${site.where}: files '${collection.name}' takes a Ref of ${collection.ownerDimension} for ${
					needed.map((action) => `'${action}'`).join(' or ')
				}, got one for '${grant.action}'`,
			)
		}
		return grant
	}

	async #listOwned(collection: Collection, site: FileSite, owner: unknown, page: FileListPage): Promise<FileListing> {
		const limit = page.limit ?? FILE_LIMITS.listPageDefault
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > FILE_LIMITS.listPageMax) {
			throw new QueryRefusedError('list_page', `${site.where}: files '${collection.name}' lists 1 to ${FILE_LIMITS.listPageMax} files a page`)
		}
		if (page.after !== undefined && !UUID.test(page.after)) {
			throw new QueryRefusedError('list_page', `${site.where}: files '${collection.name}' takes the id of a file as after`)
		}
		const listed = await collection.table.list(owner, { after: page.after ?? null, limit }, await site.session())
		return Object.freeze({ items: Object.freeze([...listed.items]), next: listed.next })
	}

	/**
	 * A file of the owner `grant` names, read whole: located now, it must lie beneath that owner where the `Ref` says,
	 * and is then read under a file `Ref` of the same principal and action, as the download endpoint reads it.
	 */
	async #open(collection: Collection, site: FileSite, grant: RefGrant, id: unknown, options: OpenOptions): Promise<OpenedFile> {
		const maxBytes = options.maxBytes
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
			throw new QueryRefusedError('invalid_argument', `${site.where}: files '${collection.name}' open takes maxBytes, a positive whole number`)
		}
		if (typeof id !== 'string' || !UUID.test(id)) {
			throw new NotFoundError()
		}
		const located = await collection.table.locate(id, await site.session())
		const beneath = located !== null && located.get(grant.dimension) === grant.id
			&& [...grant.chain].every(([dimension, value]) => located.get(dimension) === value)
		if (located === null || !beneath) {
			throw new NotFoundError()
		}
		const target = this.#mint.ref(site.frame, collection.dimension, grant.action, grant.principal, id, located)
		const file = await collection.table.find(target, await site.session())
		if (file.status === 'quarantined') {
			throw new HttpError(409, 'quarantined', 'The file is being checked for malware; try again in a few minutes')
		}
		if (file.status === 'rejected') {
			throw new NotFoundError()
		}
		if (file.size > maxBytes) {
			throw new HttpError(413, 'too_large', `The file has ${file.size} bytes, more than the ${maxBytes} this site reads`)
		}
		const object = collection.artifact.scan === true ? await this.#scannedObject(collection, target, file) : await this.#store.read(file.objectKey)
		if (object === null) {
			throw new ServerFault('file_object_missing', `the object of a file in '${collection.name}' is missing from storage`)
		}
		const bytes = object.size === file.size ? await readExactly(object.body, file.size) : null
		if (bytes === null) {
			await object.body.cancel()
			throw new ServerFault('file_object_mismatch', `the object of a file in '${collection.name}' has another size than its row records`)
		}
		return Object.freeze({ id: file.id, name: file.originalName, type: file.contentType, size: file.size, bytes })
	}

	/** The `file:<name>` dimensions; the dispatcher locates them like a table's. */
	get dimensions(): readonly string[] {
		return [...this.#byDimension.keys()]
	}

	/** The application's database, with the locator extended to every file dimension: a live file's row, read now. */
	locating(database: ContractDatabase): ContractDatabase {
		return {
			tables: database.tables,
			locate: (dimension, id, using) => {
				const collection = this.#byDimension.get(dimension)
				if (collection === undefined) {
					return database.locate(dimension, id, using)
				}
				return UUID.test(id) ? collection.table.locate(id, using) : Promise.resolve(null)
			},
		}
	}

	/** The served endpoints of every collection, by endpoint id. */
	endpoints(rows: ReadonlyMap<string, EndpointRow>, problems: string[]): ReadonlyMap<string, ServedEndpoint> {
		const served = new Map<string, ServedEndpoint>()
		for (const collection of this.#collections) {
			const row = (suffix: string, id = `files.${collection.name}.${suffix}`): CredentialedEndpoint | null => {
				const found = rows.get(id)
				if (found === undefined || found.requirement === null) {
					problems.push(`files '${collection.name}' has no '${id}' endpoint row`)
					return null
				}
				return found
			}
			const upload = row('upload')
			const download = row('download')
			const list = row('list')
			const remove = row('remove')
			if (upload !== null) {
				served.set(upload.id, { kind: 'file', row: upload, serve: (request, target) => this.#upload(collection, request, target) })
			}
			if (download !== null) {
				served.set(download.id, { kind: 'file', row: download, serve: (_request, target) => this.#download(collection, target) })
			}
			if (list !== null) {
				served.set(list.id, {
					kind: 'procedure',
					row: list,
					input: FileListInput,
					output: FileListOutput,
					handler: async ({ input, ctx }) => this.#list(collection, 'target' in ctx ? ctx.target : undefined, input),
					facilities: NO_FACILITIES,
				})
			}
			for (const mount of collection.linkMounts) {
				const linkRow = (suffix: string): CredentialedEndpoint | null => row(suffix, `${mount}.files.${collection.name}.${suffix}`)
				const linkUpload = linkRow('upload')
				const linkDownload = linkRow('download')
				const linkList = linkRow('list')
				if (linkList !== null) {
					served.set(linkList.id, {
						kind: 'procedure',
						row: linkList,
						input: FileLinkListInput,
						output: FileListOutput,
						handler: async ({ input, ctx }) => this.#list(collection, 'target' in ctx ? ctx.target : undefined, input),
						facilities: NO_FACILITIES,
					})
				}
				if (linkUpload !== null) {
					served.set(linkUpload.id, { kind: 'file', row: linkUpload, serve: (request, target) => this.#upload(collection, request, target) })
				}
				if (linkDownload !== null) {
					served.set(linkDownload.id, {
						kind: 'file',
						row: linkDownload,
						serve: (_request, target) => this.#download(collection, target),
						beneath: collection.dimension,
					})
				}
			}
			if (remove !== null) {
				served.set(remove.id, {
					kind: 'procedure',
					row: remove,
					input: ById,
					output: ById,
					handler: async ({ ctx }) => this.#remove(collection, 'target' in ctx ? ctx.target : undefined),
					facilities: NO_FACILITIES,
				})
			}
		}
		return served
	}

	/**
	 * The pending row comes first and is the intent to clean the object up: whatever fails after it — the write, a
	 * lost answer of the store, the owner moving, the final write of the row — leaves a row the sweep finds.
	 */
	async #upload(collection: Collection, request: Request, owner: unknown): Promise<Response> {
		const { artifact, table } = collection
		const type = mediaType(request.headers.get('Content-Type'))
		if (type === null || !artifact.types.includes(type)) {
			throw new HttpError(415, 'unsupported_media_type', `files '${collection.name}' admits ${artifact.types.join(', ')}`)
		}
		if (Number(request.headers.get('Content-Length') ?? 0) > artifact.maxBytes) {
			throw tooLarge(collection)
		}
		// A quarantined or rejected file holds its place too: uploads waiting for the scan are not a way past the limit.
		if (artifact.maxPerOwner !== null && (await table.countHeld(owner)) >= artifact.maxPerOwner) {
			throw tooMany(collection)
		}
		const { head, stream } = await readHead(request.body ?? new Blob([]).stream(), SNIFF_BYTES)
		if (!bytesAreOfType(type, head)) {
			await stream.cancel()
			throw new HttpError(415, 'unsupported_media_type', `The bytes of the file are not ${type}`)
		}
		const id = uuidv7()
		const objectKey = `${collection.name}/${id}`
		await table.begin(owner, { id, objectKey, contentType: type, originalName: originalName(request), createdAt: new Date() })
		const body = digesting(stream, UPLOAD_TIMEOUT_MS)
		try {
			const { size } = await this.#store.write(objectKey, body.stream, { contentType: type, maxBytes: artifact.maxBytes })
			if (size === 0 && artifact.scan === true) {
				// A scanner gives no verdict on nothing, and a file goes live only on a clean verdict.
				throw new HttpError(400, 'empty', `files '${collection.name}' scans its files and admits no empty file`)
			}
			await table.complete(owner, id, { size, sha256: body.digest() }, artifact.scan === true ? 'quarantined' : 'live')
		} catch (error) {
			if (isNamed(error, 'ObjectExistsError')) {
				// The key holds an object this upload did not write: never delete it, only the pending row.
				await table.abandon(id)
				throw new ServerFault('file_key_taken', `files '${collection.name}' found an object already under a new file's key`)
			}
			await this.#abandon(collection, id, objectKey)
			if (isNamed(error, 'ObjectTooLargeError')) {
				throw tooLarge(collection)
			}
			if (body.timedOut()) {
				throw new HttpError(408, 'timeout', `The upload did not finish within ${UPLOAD_TIMEOUT_MS / 1000} seconds`)
			}
			throw error
		} finally {
			body.stop()
		}
		// Counted again once held: two concurrent uploads may both have passed the first count.
		if (artifact.maxPerOwner !== null && (await table.countHeld(owner)) > artifact.maxPerOwner) {
			await table.retract(owner, id, new Date())
			await this.#sweep(collection)
			throw tooMany(collection)
		}
		return jsonResponse({ result: { id } }, 200)
	}

	/**
	 * Deletes the object, then the pending row; a failure of either leaves the row for the sweep. The log names the step
	 * that failed, never the error: a storage or driver error's name and message are not the framework's.
	 */
	async #abandon(collection: Collection, id: string, objectKey: string): Promise<void> {
		let step: FileCleanupStep = 'object_delete_failed'
		try {
			await this.#store.delete(objectKey)
			step = 'row_delete_failed'
			await collection.table.abandon(id)
		} catch {
			console.error(`fabrika: files '${collection.name}' cleanup: ${step}`)
		}
	}

	/** Only a live file is served: a quarantined one answers 409 until the scan pass decides, a rejected one 404. */
	async #download(collection: Collection, target: unknown): Promise<FileDownload> {
		const file = await collection.table.find(target)
		if (file.status === 'quarantined') {
			throw new HttpError(409, 'quarantined', 'The file is being checked for malware; try again in a few minutes')
		}
		if (file.status === 'rejected') {
			throw new NotFoundError()
		}
		const object = collection.artifact.scan === true ? await this.#scannedObject(collection, target, file) : await this.#store.read(file.objectKey)
		if (object === null) {
			throw new ServerFault('file_object_missing', `the object of a file in '${collection.name}' is missing from storage`)
		}
		if (object.size !== file.size) {
			await object.body.cancel()
			throw new ServerFault('file_object_mismatch', `the object of a file in '${collection.name}' has another size than its row records`)
		}
		return new FileDownload({ body: object.body, size: file.size, contentType: file.contentType, name: file.originalName })
	}

	/**
	 * The object of a live file of a scanning collection, only as the version the scan passed, in one conditional read:
	 * no byte of a replaced object is served. A file without that version — replaced, or live before the collection
	 * scanned — is quarantined again, so the scan job decides about the bytes stored now.
	 */
	async #scannedObject(collection: Collection, target: unknown, file: StoredFile): Promise<StoredObject> {
		const object = file.objectVersion === null ? null : await this.#store.readVersion(file.objectKey, file.objectVersion)
		if (object === null) {
			await collection.table.requarantine(target, file.objectVersion)
			throw new HttpError(409, 'quarantined', 'The file is being checked for malware; try again in a few minutes')
		}
		return object
	}

	async #list(collection: Collection, owner: unknown, input: Readonly<Record<string, unknown>>): Promise<z.input<typeof FileListOutput>> {
		// The dispatcher parsed the input with `FileListInput` (`FileLinkListInput` for a link holder); the target is the owner.
		const after = input['after']
		const limit = input['limit']
		const page = await collection.table.list(owner, {
			after: typeof after === 'string' ? after : null,
			limit: typeof limit === 'number' ? limit : FILE_LIMITS.listPageDefault,
		})
		return {
			items: page.items.map((file) => ({ ...file, createdAt: file.createdAt.toISOString() })),
			next: page.next,
		}
	}

	async #remove(collection: Collection, target: unknown): Promise<{ readonly id: string }> {
		const grant = this.#capabilities.resolve(target)
		if (grant.kind !== 'ref') {
			throw new ServerFault('contract_inconsistent', `files '${collection.name}' remove was handed a Within`)
		}
		await collection.table.markRemoved(target, new Date())
		await this.#sweep(collection)
		return { id: grant.id }
	}

	/**
	 * Deletes the objects of one batch of removed, orphaned and abandoned files, then their rows. Retry-safe: a row stays
	 * until its object is gone, so a failed delete is retried by the next sweep. It never fails the request that
	 * triggered it; it answers whether a full batch went (`more`), a smaller one (`done`), or a step failed.
	 */
	async #sweep(collection: Collection): Promise<'more' | 'done' | 'failed'> {
		const pendingBefore = new Date(Date.now() - PENDING_GRACE_MS)
		let step: FileCleanupStep = 'rows_read_failed'
		try {
			const batch = await collection.table.removable(SWEEP_BATCH, pendingBefore)
			for (const file of batch) {
				step = 'object_delete_failed'
				await this.#store.delete(file.objectKey)
				step = 'row_delete_failed'
				await collection.table.purge(file.id, pendingBefore)
			}
			return batch.length === SWEEP_BATCH ? 'more' : 'done'
		} catch {
			console.error(`fabrika: files '${collection.name}' sweep: ${step}`)
			return 'failed'
		}
	}

	/**
	 * Sweeps every collection, batch by batch, until none holds a removable file or `signal` aborts: the body of the sweep
	 * job. A collection whose sweep failed waits for the next run, and the run fails once every other one was swept.
	 */
	async sweep(signal: AbortSignal): Promise<void> {
		const failed: string[] = []
		for (const collection of this.#collections) {
			let state: 'more' | 'done' | 'failed' = 'more'
			while (state === 'more' && !signal.aborted) {
				state = await this.#sweep(collection)
			}
			if (state === 'failed') {
				failed.push(collection.name)
			}
		}
		// A form's file nobody attached before its hold ended, or whose submission never committed.
		let held: 'more' | 'done' | 'failed' = 'more'
		while (held === 'more' && !signal.aborted) {
			held = await this.#sweepFormFiles()
		}
		if (held === 'failed') {
			failed.push('received by forms')
		}
		if (failed.length > 0) {
			throw new ServerFault('file_sweep_failed', `the sweep of files ${failed.map((name) => `'${name}'`).join(', ')} failed; the next run retries it`)
		}
	}

	/** Whether a collection scans its uploads, so the scan job runs. */
	get scans(): boolean {
		return this.#collections.some((collection) => collection.artifact.scan === true)
	}

	/** One scan pass over every `scan: true` collection, then their sweep: the body of the scan job. */
	async scanPass(scanner: FileScanner | null, reporter: OperationsReporter, signal: AbortSignal): Promise<void> {
		const scanning = this.#collections.filter((collection) => collection.artifact.scan === true)
		await runScanPass({ collections: scanning, store: this.#store, scanner, reporter, signal })
		for (const collection of scanning) {
			await this.#sweep(collection)
		}
	}
}

function tooLarge(collection: Collection): HttpError {
	return new HttpError(413, 'too_large', `files '${collection.name}' admits at most ${collection.artifact.maxBytes} bytes per file`)
}

function tooMany(collection: Collection): HttpError {
	return new HttpError(
		409,
		'limit',
		`files '${collection.name}' admits at most ${collection.artifact.maxPerOwner} files per ${collection.artifact.owner}`,
	)
}

/**
 * The file collections of `artifact`, or `null` when it declares none. Every reason a collection cannot be served
 * goes into `problems`, so `boot` refuses to start rather than answer an upload it cannot check.
 */
/** Whether a collection's `link` reaches its files through the link mount `mount`. */
const servesLink = (link: boolean | readonly string[], mount: string): boolean => (typeof link === 'boolean' ? link : link.includes(mount))

export function fileCollections(
	artifact: ContractArtifact,
	database: ImplementationDatabase | null,
	store: FileObjectStore | undefined,
	capabilities: CapabilityAuthority,
	mint: CapabilityMint,
	problems: string[],
): FileCollections | null {
	const entries = Object.entries(artifact.files)
	if (entries.length === 0) {
		return null
	}
	if (store === undefined) {
		problems.push('files are declared, and the runtime adapter supplies no object storage (FABRIKA_APP_STORAGE_* on Zerops)')
	}
	if (database === null || !isScopedDatabase(database)) {
		problems.push('files need the scoped(tables) data layer of @fabrika/db: a file row lives beside its owner row')
		return null
	}
	const tables = fileTablesOf(database)
	const collections: Collection[] = []
	for (const [name, collection] of entries) {
		if (fileTableName(name) === null) {
			problems.push(`files '${name}' needs a lowercase snake_case name of at most 39 characters: it names the table fabrika_files_<name>`)
			continue
		}
		for (const type of collection.types.filter((candidate) => !SNIFFABLE_TYPES.includes(candidate))) {
			problems.push(`files '${name}' admits '${type}', whose bytes the framework cannot verify (allowed: ${SNIFFABLE_TYPES.join(', ')})`)
		}
		const dimension = `file:${name}`
		try {
			const table = tables.collection({
				name,
				owner: collection.owner,
				dimension,
				actions: { read: collection.read, write: collection.write, delete: collection.delete },
				scan: collection.scan === true,
			})
			const ownerDimension = artifact.dimensions[dimension]?.in ?? null
			if (ownerDimension === null) {
				problems.push(`files '${name}' has no dimension ${dimension} inside its owner's in the compiled contract`)
				continue
			}
			const linkMounts = Object.entries(artifact.mounts).flatMap(([mount, declared]) =>
				declared.kind === 'link' && declared.dimension === ownerDimension && servesLink(collection.link, mount) ? [mount] : []
			)
			collections.push({ name, artifact: collection, dimension, ownerDimension, table, linkMounts })
		} catch (error) {
			problems.push(error instanceof Error ? error.message : `files '${name}' cannot be served`)
		}
	}
	return store === undefined ? null : new FileCollections(collections, store, capabilities, mint, frameworkTablesOf(database).formFiles)
}
