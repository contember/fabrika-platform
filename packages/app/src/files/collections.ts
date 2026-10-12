// The runtime of `c.files`: the generated upload, download, list and remove endpoints, the locator of every
// `file:<name>` dimension, the scan pass of `scan: true` collections (`scan.ts`), and the sweep that deletes the objects
// of removed, orphaned and abandoned files. Access is the core's:
// the dispatcher checks the access form and mints the target, and every database operation here takes that target,
// so `@fabrika/db` scopes it by the whole chain the access check saw.

import type { ContractArtifact, CredentialedEndpoint, EndpointRow, FileCollectionArtifact } from '@fabrika/auth-core'
import type { CapabilityAuthority } from '@fabrika/db/capability'
import { type FileCollectionTable, fileTableName, fileTablesOf, isScopedDatabase, type StoredFile } from '@fabrika/db/framework'
import { type FileObjectStore, type StoredObject, uuidv7 } from '@fabrika/platform'
import { z } from 'zod/v4'
import { FILE_LIMITS } from '../contract/defaults'
import { HttpError, jsonResponse, NotFoundError } from '../errors'
import { NO_FACILITIES, type ServedEndpoint } from '../implement/dispatch'
import { ServerFault } from '../implement/faults'
import type { ContractDatabase, ImplementationDatabase } from '../implement/implement'
import type { JobReporter } from '../jobs/report'
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const ById = z.strictObject({ id: z.uuid() })

/** `files.<name>.list`'s schemas; `FILE_LIST_INPUT` and `FILE_LIST_OUTPUT` of the contract describe the same. */
export const FileListInput = z.strictObject({
	owner: z.string().min(1),
	after: z.uuid().optional(),
	limit: z.number().int().min(1).max(FILE_LIMITS.listPageMax).optional(),
})
export const FileListOutput = z.strictObject({
	items: z.array(z.strictObject({
		id: z.uuid(),
		name: z.string().min(1).nullable(),
		type: z.string().min(1),
		size: z.number().int().min(0),
		status: z.enum(['live', 'quarantined', 'rejected']),
		createdAt: z.iso.datetime(),
	})).max(FILE_LIMITS.listPageMax),
	next: z.uuid().nullable(),
})

interface Collection {
	readonly name: string
	readonly artifact: FileCollectionArtifact
	readonly dimension: string
	readonly table: FileCollectionTable
}

/** The media type of a `Content-Type` value, without parameters, lower-cased. */
function mediaType(header: string | null): string | null {
	const type = header?.split(';')[0]?.trim().toLowerCase()
	return type === undefined || type === '' ? null : type
}

/** The client's file name, metadata only: at most 255 code points, never half a character, no control characters. */
export function originalName(request: Request): string | null {
	const raw = new URL(request.url).searchParams.get('name') ?? ''
	const name = Array.from(raw.replace(/\p{Cc}/gu, '').trim()).slice(0, MAX_NAME_CODE_POINTS).join('')
	return name === '' ? null : name
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

/** The body as it is stored: hashed on the way, and failed once `timeoutMs` passes before it ends. */
function digesting(body: ReadableStream<Uint8Array>, timeoutMs: number): {
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
				timer = setTimeout(() => {
					expired = true
					controller.error(new Error('the upload did not finish in time'))
				}, timeoutMs)
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

function isNamed(error: unknown, name: string): boolean {
	return error instanceof Error && error.name === name
}

export class FileCollections {
	readonly #collections: readonly Collection[]
	readonly #byDimension: ReadonlyMap<string, Collection>
	readonly #store: FileObjectStore
	readonly #capabilities: CapabilityAuthority

	constructor(collections: readonly Collection[], store: FileObjectStore, capabilities: CapabilityAuthority) {
		this.#collections = collections
		this.#byDimension = new Map(collections.map((collection) => [collection.dimension, collection]))
		this.#store = store
		this.#capabilities = capabilities
	}

	/** The `file:<name>` dimensions; the dispatcher locates them like a table's. */
	get dimensions(): readonly string[] {
		return [...this.#byDimension.keys()]
	}

	/** The application's database, with the locator extended to every file dimension: a live file's row, read now. */
	locating(database: ContractDatabase): ContractDatabase {
		return {
			tables: database.tables,
			locate: (dimension, id) => {
				const collection = this.#byDimension.get(dimension)
				if (collection === undefined) {
					return database.locate(dimension, id)
				}
				return UUID.test(id) ? collection.table.locate(id) : Promise.resolve(null)
			},
		}
	}

	/** The served endpoints of every collection, by endpoint id. */
	endpoints(rows: ReadonlyMap<string, EndpointRow>, problems: string[]): ReadonlyMap<string, ServedEndpoint> {
		const served = new Map<string, ServedEndpoint>()
		for (const collection of this.#collections) {
			const row = (suffix: string): CredentialedEndpoint | null => {
				const found = rows.get(`files.${collection.name}.${suffix}`)
				if (found === undefined || found.requirement === null) {
					problems.push(`files '${collection.name}' has no '${suffix}' endpoint row`)
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
			await table.complete(owner, id, { size, sha256: body.digest() }, artifact.scan === true ? 'quarantined' : 'live')
		} catch (error) {
			if (isNamed(error, 'ObjectExistsError')) {
				// The key holds an object this upload did not write: never delete it, only the pending row.
				await table.abandon(id)
				throw new ServerFault(`files '${collection.name}' found an object already under a new file's key`)
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
		// The dispatcher parsed the input with `FileListInput`; the access form took `owner` for the target.
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
	 * Deletes the objects of removed, orphaned and abandoned files, then their rows. Retry-safe: a row stays until its
	 * object is gone, so a failed delete is retried by the next sweep. It never fails the request that triggered it.
	 */
	async #sweep(collection: Collection): Promise<void> {
		const pendingBefore = new Date(Date.now() - PENDING_GRACE_MS)
		let step: FileCleanupStep = 'rows_read_failed'
		try {
			for (const file of await collection.table.removable(SWEEP_BATCH, pendingBefore)) {
				step = 'object_delete_failed'
				await this.#store.delete(file.objectKey)
				step = 'row_delete_failed'
				await collection.table.purge(file.id, pendingBefore)
			}
		} catch {
			console.error(`fabrika: files '${collection.name}' sweep: ${step}`)
		}
	}

	/** One sweep of every collection, for a framework job to run on a schedule. */
	async sweep(): Promise<void> {
		for (const collection of this.#collections) {
			await this.#sweep(collection)
		}
	}

	/** Whether a collection scans its uploads, so the scan job runs. */
	get scans(): boolean {
		return this.#collections.some((collection) => collection.artifact.scan === true)
	}

	/** One scan pass over every `scan: true` collection, then their sweep: the body of the scan job. */
	async scanPass(scanner: FileScanner | null, reporter: JobReporter, signal: AbortSignal): Promise<void> {
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
export function fileCollections(
	artifact: ContractArtifact,
	database: ImplementationDatabase | null,
	store: FileObjectStore | undefined,
	capabilities: CapabilityAuthority,
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
		if (collection.link) {
			problems.push(`files '${name}' sets link: true, which this version of @fabrika/app does not serve yet`)
		}
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
			collections.push({ name, artifact: collection, dimension, table })
		} catch (error) {
			problems.push(error instanceof Error ? error.message : `files '${name}' cannot be served`)
		}
	}
	return store === undefined ? null : new FileCollections(collections, store, capabilities)
}
