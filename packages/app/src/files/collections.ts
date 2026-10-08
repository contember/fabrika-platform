// The runtime of `c.files`: the generated upload, download and remove endpoints, the locator of every `file:<name>`
// dimension, and the sweep that deletes the objects of removed and orphaned files. Access is the core's: the
// dispatcher checks the access form and mints the target before anything here runs, and a file reaches only what
// its owner row reaches, read through that row on every request.

import type { ContractArtifact, CredentialedEndpoint, EndpointRow, FileCollectionArtifact } from '@fabrika/auth-core'
import type { RefGrant } from '@fabrika/db/capability'
import { fileTableName, type FileTables, fileTablesOf, isScopedDatabase } from '@fabrika/db/framework'
import { type FileObjectStore, uuidv7 } from '@fabrika/platform'
import { z } from 'zod/v4'
import { HttpError, jsonResponse, NotFoundError } from '../errors'
import { requestCapabilities } from '../implement/capability'
import { type ServedEndpoint, ServerFault } from '../implement/dispatch'
import type { ContractDatabase, ImplementationDatabase } from '../implement/implement'
import { bytesAreOfType, SNIFF_BYTES, SNIFFABLE_TYPES } from './sniff'
import { FileDownload } from './treatment'

/** How many removable files one sweep handles; the next remove picks up the rest. */
const SWEEP_BATCH = 20
const MAX_NAME_LENGTH = 255
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const FOREIGN_KEY_VIOLATION = '23503'

const ById = z.strictObject({ id: z.uuid() })

interface Collection {
	readonly name: string
	readonly artifact: FileCollectionArtifact
	readonly dimension: string
	/** The owner table's dimension, which a file lies in. */
	readonly owner: string
}

/** The media type of a `Content-Type` value, without parameters, lower-cased. */
function mediaType(header: string | null): string | null {
	const type = header?.split(';')[0]?.trim().toLowerCase()
	return type === undefined || type === '' ? null : type
}

/** The client's file name, metadata only: at most 255 characters, no control characters. */
function originalName(request: Request): string | null {
	const raw = new URL(request.url).searchParams.get('name')
	const name = raw?.replace(/\p{Cc}/gu, '').trim().slice(0, MAX_NAME_LENGTH) ?? ''
	return name === '' ? null : name
}

function isForeignKeyViolation(error: unknown): boolean {
	return error instanceof Error && 'errno' in error && error.errno === FOREIGN_KEY_VIOLATION
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

export class FileCollections {
	readonly #collections: ReadonlyMap<string, Collection>
	readonly #byDimension: ReadonlyMap<string, Collection>
	readonly #tables: FileTables
	readonly #store: FileObjectStore

	constructor(collections: readonly Collection[], tables: FileTables, store: FileObjectStore) {
		this.#collections = new Map(collections.map((collection) => [collection.name, collection]))
		this.#byDimension = new Map(collections.map((collection) => [collection.dimension, collection]))
		this.#tables = tables
		this.#store = store
	}

	/** The `file:<name>` dimensions; the dispatcher locates them like a table's. */
	get dimensions(): readonly string[] {
		return [...this.#byDimension.keys()]
	}

	/** The application's database, with the locator extended to every file dimension. */
	locating(database: ContractDatabase): ContractDatabase {
		return {
			tables: database.tables,
			locate: (dimension, id) => {
				const collection = this.#byDimension.get(dimension)
				return collection === undefined ? database.locate(dimension, id) : this.#locate(collection, id, database)
			},
		}
	}

	/** A file lies in its owner and in everything the owner lies in, read now through the owner row. */
	async #locate(collection: Collection, id: string, database: ContractDatabase): Promise<ReadonlyMap<string, string> | null> {
		if (!UUID.test(id)) {
			return null
		}
		const file = await this.#tables.find(collection.name, id)
		if (file === null) {
			return null
		}
		const owner = await database.locate(collection.owner, file.ownerId)
		return owner === null ? null : new Map([[collection.owner, file.ownerId], ...owner])
	}

	/** The served endpoints of every collection, by endpoint id. */
	endpoints(rows: ReadonlyMap<string, EndpointRow>, problems: string[]): ReadonlyMap<string, ServedEndpoint> {
		const served = new Map<string, ServedEndpoint>()
		for (const collection of this.#collections.values()) {
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
			const remove = row('remove')
			if (upload !== null) {
				served.set(upload.id, { kind: 'file', row: upload, serve: (request, target) => this.#upload(collection, request, target) })
			}
			if (download !== null) {
				served.set(download.id, { kind: 'file', row: download, serve: (_request, target) => this.#download(collection, target) })
			}
			if (remove !== null) {
				served.set(remove.id, {
					kind: 'procedure',
					row: remove,
					input: ById,
					output: ById,
					handler: ({ ctx }) => this.#remove(collection, 'target' in ctx ? ctx.target : undefined),
				})
			}
		}
		return served
	}

	/** The object `target` grants `action` on; the authority refuses anything but this request's own. */
	#target(target: unknown, dimension: string, action: string): RefGrant {
		const grant = requestCapabilities.resolve(target)
		if (grant.kind !== 'ref' || grant.dimension !== dimension || grant.action !== action) {
			throw new ServerFault(`a file endpoint was handed a capability for '${grant.action}' on a ${grant.dimension}`)
		}
		return grant
	}

	async #upload(collection: Collection, request: Request, target: unknown): Promise<Response> {
		const { artifact } = collection
		const { id: ownerId, principal } = this.#target(target, collection.owner, artifact.write)
		const type = mediaType(request.headers.get('Content-Type'))
		if (type === null || !artifact.types.includes(type)) {
			throw new HttpError(415, 'unsupported_media_type', `files '${collection.name}' admits ${artifact.types.join(', ')}`)
		}
		const declaredLength = Number(request.headers.get('Content-Length') ?? 0)
		if (declaredLength > artifact.maxBytes) {
			throw tooLarge(collection)
		}
		if (artifact.maxPerOwner !== null && (await this.#tables.countLive(collection.name, ownerId)) >= artifact.maxPerOwner) {
			throw tooMany(collection)
		}
		const { head, stream } = await readHead(request.body ?? new Blob([]).stream(), SNIFF_BYTES)
		if (!bytesAreOfType(type, head)) {
			await stream.cancel()
			throw new HttpError(415, 'unsupported_media_type', `The bytes of the file are not ${type}`)
		}
		const hasher = new Bun.CryptoHasher('sha256')
		const hashed = stream.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					hasher.update(chunk)
					controller.enqueue(chunk)
				},
			}),
		)
		const id = uuidv7()
		const objectKey = `${collection.name}/${id}`
		let size: number
		try {
			size = (await this.#store.write(objectKey, hashed, { contentType: type, maxBytes: artifact.maxBytes })).size
		} catch (error) {
			// Read by name: the store is another package's.
			if (error instanceof Error && error.name === 'ObjectTooLargeError') {
				throw tooLarge(collection)
			}
			throw error
		}
		const file = { id, ownerId, objectKey, size, contentType: type, originalName: originalName(request) }
		try {
			await this.#tables.insert(collection.name, { ...file, sha256: hasher.digest('hex'), createdBy: principal, createdAt: new Date() })
		} catch (error) {
			await this.#store.delete(objectKey)
			// The owner was deleted after the access check.
			throw isForeignKeyViolation(error) ? new NotFoundError('Not found') : error
		}
		// Counted again after the insert: two concurrent uploads may both have passed the first count.
		if (artifact.maxPerOwner !== null && (await this.#tables.countLive(collection.name, ownerId)) > artifact.maxPerOwner) {
			await this.#tables.markRemoved(collection.name, id, new Date())
			await this.#sweep(collection)
			throw tooMany(collection)
		}
		return jsonResponse({ result: { id } }, 200)
	}

	async #download(collection: Collection, target: unknown): Promise<FileDownload> {
		const { id } = this.#target(target, collection.dimension, collection.artifact.read)
		const file = await this.#tables.find(collection.name, id)
		if (file === null) {
			throw new NotFoundError('Not found')
		}
		const object = await this.#store.read(file.objectKey)
		if (object === null) {
			throw new ServerFault(`the object of a file in '${collection.name}' is missing from storage`)
		}
		if (object.size !== file.size) {
			await object.body.cancel()
			throw new ServerFault(`the object of a file in '${collection.name}' has another size than its row records`)
		}
		return new FileDownload({ body: object.body, size: file.size, contentType: file.contentType, name: file.originalName })
	}

	async #remove(collection: Collection, target: unknown): Promise<{ readonly id: string }> {
		const { id } = this.#target(target, collection.dimension, collection.artifact.delete)
		if (!(await this.#tables.markRemoved(collection.name, id, new Date()))) {
			throw new NotFoundError('Not found')
		}
		await this.#sweep(collection)
		return { id }
	}

	/**
	 * Deletes the objects of removed and orphaned files, then their rows. Retry-safe: a row stays until its object is
	 * gone, so a failed delete is retried by the next sweep. It never fails the request that triggered it.
	 */
	async #sweep(collection: Collection): Promise<void> {
		try {
			for (const file of await this.#tables.removable(collection.name, SWEEP_BATCH)) {
				await this.#store.delete(file.objectKey)
				await this.#tables.purge(collection.name, file.id)
			}
		} catch (error) {
			console.error(`fabrika: files '${collection.name}' sweep: ${error instanceof Error ? error.name : typeof error} thrown`)
		}
	}

	/** One sweep of every collection, for a framework job to run on a schedule. */
	async sweep(): Promise<void> {
		for (const collection of this.#collections.values()) {
			await this.#sweep(collection)
		}
	}
}

function tooLarge(collection: Collection): HttpError {
	return new HttpError(413, 'too_large', `files '${collection.name}' admits at most ${collection.artifact.maxBytes} bytes per file`)
}

function tooMany(collection: Collection): HttpError {
	return new HttpError(409, 'limit', `files '${collection.name}' admits at most ${collection.artifact.maxPerOwner} files per ${collection.owner}`)
}

/**
 * The file collections of `artifact`, or `null` when it declares none. Every reason a collection cannot be served
 * goes into `problems`, so `boot` refuses to start rather than answer an upload it cannot check.
 */
export function fileCollections(
	artifact: ContractArtifact,
	database: ImplementationDatabase | null,
	store: FileObjectStore | undefined,
	problems: string[],
): FileCollections | null {
	const entries = Object.entries(artifact.files)
	if (entries.length === 0) {
		return null
	}
	const collections: Collection[] = []
	for (const [name, collection] of entries) {
		const owner = artifact.tables[collection.owner]?.scope
		if (collection.link) {
			problems.push(`files '${name}' sets link: true, which this version of @fabrika/app does not serve yet`)
		}
		if (fileTableName(name) === null) {
			problems.push(`files '${name}' needs a lowercase snake_case name of at most 39 characters: it names the table fabrika_files_<name>`)
		}
		for (const type of collection.types.filter((candidate) => !SNIFFABLE_TYPES.includes(candidate))) {
			problems.push(`files '${name}' admits '${type}', whose bytes the framework cannot verify (allowed: ${SNIFFABLE_TYPES.join(', ')})`)
		}
		if (owner?.mode === 'dimension') {
			collections.push({ name, artifact: collection, dimension: `file:${name}`, owner: owner.dimension })
		}
	}
	if (store === undefined) {
		problems.push('files are declared, and the runtime adapter supplies no object storage (FABRIKA_APP_STORAGE_* on Zerops)')
	}
	if (database === null || !isScopedDatabase(database)) {
		problems.push('files need the scoped(tables) data layer of @fabrika/db: a file row lives beside its owner row')
	}
	return store === undefined || database === null || !isScopedDatabase(database)
		? null
		: new FileCollections(collections, fileTablesOf(database), store)
}
