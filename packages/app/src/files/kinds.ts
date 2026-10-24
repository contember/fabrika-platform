// The runtime of file kinds (`c.files({ types, maxBytes, scan? })`): a stored file is a value in a table column, and
// the table's policy is its authority. This module stages a file (an incoming part or a `ctx.files.put`): its pending
// row first, on a connection of its own, then its object, sniffed and bounded by the kind. It serves and opens a file
// only through a reference the work holds and may read, and only a live one, by its scanned version. The sweep
// deletes the files no declared column references, and the scan job decides about the quarantined ones (`scan.ts`).

import type { ContractArtifact, FileKindArtifact } from '@fabrika/auth-core'
import {
	type FileBinding,
	type FileColumnRef,
	fileHoldingOf,
	fileReference,
	frameworkTablesOf,
	holdsFile,
	isScopedDatabase,
	QueryRefusedError,
	type StoredFiles,
} from '@fabrika/db/framework'
import { type FileObjectStore, type StoredObject, uuidv7 } from '@fabrika/platform'
import type { FileRef } from '../contract/file'
import { HttpError, NotFoundError } from '../errors'
import { CapabilityRefusedError } from '../implement/capability'
import { ServerFault } from '../implement/faults'
import type { ImplementationDatabase } from '../implement/implement'
import type { OperationsReporter } from '../jobs/report'
import type { OpenedFile } from './handle'
import { type FileScanner, runScanPass, type ScanningKind } from './scan'
import { bytesAreOfType, SNIFF_BYTES, SNIFFABLE_TYPES } from './sniff'
import { cleanName, digesting, isNamed, readExactly, readHead } from './streams'
import { FileDownload } from './treatment'

export { FILE_SWEEP_JOB, FILE_SWEEP_SCHEDULE } from './job-names'
export const FILE_SWEEP_TIMEOUT_MS = 10 * 60_000
/** How long a staged file waits for its first reference before the sweep may delete it. */
export const FILE_PENDING_GRACE_MS = 60 * 60 * 1000
/** How many files one sweep batch handles; the next batch, or the next run, takes the rest. */
const SWEEP_BATCH = 20

/** One file part of a multipart body, as the multipart reader hands it over. */
export interface FilePart {
	readonly filename: string | null
	/** The media type the part declares; the bytes must be of it. */
	readonly contentType: string | null
	readonly body: ReadableStream<Uint8Array>
}

/** What `ctx.files.put` takes: the bytes, and the type they must be of. */
export interface PutOptions {
	readonly type: string
	readonly name?: string
}

/** The bytes `ctx.files.put` writes: in memory, or a stream a large file comes from. */
export type PutBody = Uint8Array | ReadableStream<Uint8Array> | Blob

/**
 * One request's or job attempt's files: the holder its file references belong to, the id a pending file it stages
 * carries, and what it staged, so a known rollback deletes what nothing claimed.
 */
export class FileWork {
	readonly holder: object
	readonly request: string
	readonly #staged: string[] = []
	readonly #written = new Map<string, string>()

	constructor(holder: object, request: string) {
		this.holder = holder
		this.request = request
	}

	staged(id: string): void {
		this.#staged.push(id)
	}

	/** The work wrote the object of a file it staged, under a key no other file has. */
	wrote(id: string, objectKey: string): void {
		this.#written.set(id, objectKey)
	}

	get stagedIds(): readonly string[] {
		return [...this.#staged]
	}

	writtenKey(id: string): string | null {
		return this.#written.get(id) ?? null
	}
}

interface Kind {
	readonly name: string
	readonly artifact: FileKindArtifact
}

export class StoredFileKinds {
	readonly #kinds: ReadonlyMap<string, Kind>
	readonly #store: FileObjectStore
	readonly #files: StoredFiles
	readonly #columns: readonly FileColumnRef[]

	constructor(kinds: readonly Kind[], store: FileObjectStore, files: StoredFiles, columns: readonly FileColumnRef[]) {
		this.#kinds = new Map(kinds.map((kind) => [kind.name, kind]))
		this.#store = store
		this.#files = files
		this.#columns = columns
	}

	/** Whether the contract declares kind `name`. */
	has(name: string): boolean {
		return this.#kinds.has(name)
	}

	/** Whether any kind scans, so the scan job runs. */
	get scans(): boolean {
		return [...this.#kinds.values()].some((kind) => kind.artifact.scan === true)
	}

	/** What the data layer claims and checks a site's file references with. */
	binding(work: FileWork): FileBinding {
		return {
			holder: work.holder,
			request: work.request,
			graceMs: FILE_PENDING_GRACE_MS,
			scans: (kind) => this.#kinds.get(kind)?.artifact.scan === true,
		}
	}

	#kind(where: string, name: unknown): Kind {
		const kind = typeof name === 'string' ? this.#kinds.get(name) : undefined
		if (kind === undefined) {
			throw new ServerFault(
				'file_kind_unknown',
				`${where}: '${String(name)}' is no file kind of the contract (kinds: ${[...this.#kinds.keys()].join(', ')})`,
			)
		}
		return kind
	}

	/**
	 * One incoming file of a request's file field, staged for `work`: its declared type must be one the kind admits and
	 * its first bytes that type. `null` for an empty part without a file name: a file input the visitor left empty.
	 */
	async receive(work: FileWork, kind: string, part: FilePart): Promise<FileRef | null> {
		const { head, stream } = await readHead(part.body, SNIFF_BYTES)
		if (head.byteLength === 0 && (part.filename === null || part.filename === '')) {
			return null
		}
		return await this.#stage(work, this.#kind('an input file', kind), part.contentType, cleanName(part.filename ?? ''), head, stream)
	}

	/** `ctx.files.put`: a file of `kind` this work creates, staged like an incoming one; its reference is the work's. */
	async put(work: FileWork, kind: unknown, body: PutBody, options: PutOptions): Promise<FileRef> {
		const declared = this.#kind('ctx.files.put', kind)
		if (typeof options !== 'object' || options === null || typeof options.type !== 'string') {
			throw new ServerFault('file_put', "ctx.files.put takes the file's options: { type, name? }")
		}
		const stream = body instanceof Uint8Array ? bytesStream(body) : body instanceof Blob ? body.stream() : body
		const read = await readHead(stream, SNIFF_BYTES)
		return await this.#stage(work, declared, options.type, cleanName(options.name ?? ''), read.head, read.stream)
	}

	/**
	 * The pending row comes first, on a connection of its own, and is the cleanup intent: whatever fails after it — the
	 * write, a lost answer of the store, the record of its size — leaves a row the sweep finds.
	 */
	async #stage(
		work: FileWork,
		kind: Kind,
		type: string | null,
		name: string | null,
		head: Uint8Array,
		stream: ReadableStream<Uint8Array>,
	): Promise<FileRef> {
		const { artifact } = kind
		if (type === null || !artifact.types.includes(type)) {
			await stream.cancel()
			throw new HttpError(415, 'unsupported_media_type', `files of kind '${kind.name}' are ${artifact.types.join(', ')}`)
		}
		if (!bytesAreOfType(type, head)) {
			await stream.cancel()
			throw new HttpError(415, 'unsupported_media_type', `The bytes of the file are not ${type}`)
		}
		if (head.byteLength === 0 && artifact.scan === true) {
			// A scanner gives no verdict on nothing, and a file goes live only on a clean verdict.
			await stream.cancel()
			throw new HttpError(400, 'empty', `files of kind '${kind.name}' are scanned, so none is empty`)
		}
		const id = uuidv7()
		const objectKey = `${kind.name}/${id}`
		await this.#files.stage({ id, kind: kind.name, objectKey, contentType: type, name, request: work.request })
		work.staged(id)
		// The request's body deadline bounds an incoming file; a put's caller bounds its own stream.
		const body = digesting(stream, null)
		try {
			const { size } = await this.#store.write(objectKey, body.stream, { contentType: type, maxBytes: artifact.maxBytes })
			work.wrote(id, objectKey)
			const sha256 = body.digest()
			await this.#files.written(id, { size, sha256 })
			return fileReference({ id, kind: kind.name, name, type, size, status: 'pending' }, work.holder, true)
		} catch (error) {
			if (isNamed(error, 'ObjectExistsError')) {
				// The key holds an object this work did not write: never delete it; the sweep removes the row.
				throw new ServerFault('file_key_taken', `files of kind '${kind.name}' found an object already under a new file's key`)
			}
			await this.#abandon(work, id)
			if (isNamed(error, 'ObjectTooLargeError')) {
				throw new HttpError(413, 'too_large', `files of kind '${kind.name}' hold at most ${artifact.maxBytes} bytes`)
			}
			throw error
		} finally {
			body.stop()
		}
	}

	/** One staged file nothing claimed: its row and the record of its object in one statement, then the object. */
	async #abandon(work: FileWork, id: string): Promise<void> {
		let step = 'row_delete_failed'
		try {
			const objectKey = await this.#files.abandon(id, work.request)
			if (objectKey === null) {
				// On SQLite the pending row is written in the work's own transaction and rolled back with it, so only the
				// work knows the object; a row still there is a file something claimed, whose object stays.
				const written = work.writtenKey(id)
				if (written !== null && (await this.#files.find(id)) === null) {
					step = 'object_delete_failed'
					await this.#store.delete(written)
				}
				return
			}
			step = 'object_delete_failed'
			await this.#store.delete(objectKey)
			step = 'deletion_record_failed'
			await this.#files.forgetDeletion(objectKey)
		} catch {
			console.error(`fabrika: file cleanup: ${step}`)
		}
	}

	/**
	 * After a known rollback: every file the work staged and nothing claimed goes now. After an uncertain outcome (a lost
	 * commit answer, a crash) nothing is deleted here; the sweep decides from the database.
	 */
	async release(work: FileWork): Promise<void> {
		for (const id of work.stagedIds) {
			await this.#abandon(work, id)
		}
	}

	/**
	 * The file a reference names, as a byte consumer reads it: only through a reference the work holds and may read,
	 * and only a live one. A pending or quarantined file is 409 `file_not_ready`, a rejected one 409 `file_rejected`, and
	 * one the sweep deleted since the read 404.
	 */
	async #object(
		work: FileWork,
		where: string,
		reference: unknown,
	): Promise<{ readonly file: FileRef & { readonly kind: string }; readonly object: StoredObject }> {
		const holding = fileHoldingOf(reference)
		if (holding === undefined || !holdsFile(work.holder, holding.id)) {
			throw new CapabilityRefusedError(
				'wrong_capability',
				`${where} takes a file reference this request holds and may read: an input file, a put, or a file column read under its table's read action`,
			)
		}
		const file = await this.#files.find(holding.id)
		if (file === null) {
			throw new NotFoundError('The file is no longer stored')
		}
		if (file.status === 'pending' || file.status === 'quarantined') {
			throw new HttpError(409, 'file_not_ready', 'The file is not ready yet; try again in a few minutes')
		}
		if (file.status === 'rejected') {
			throw new HttpError(409, 'file_rejected', 'The file was refused by the malware scan')
		}
		const scans = this.#kinds.get(file.kind)?.artifact.scan === true
		const object = scans
			? file.objectVersion === null ? null : await this.#store.readVersion(file.objectKey, file.objectVersion)
			: await this.#store.read(file.objectKey)
		if (object === null && scans) {
			// No byte of a replaced object is served: the scan decides about the bytes stored now.
			await this.#files.requarantine(file.id, file.objectVersion)
			throw new HttpError(409, 'file_not_ready', 'The file is not ready yet; try again in a few minutes')
		}
		if (object === null) {
			throw new ServerFault('file_object_missing', `the object of a file of kind '${file.kind}' is missing from storage`)
		}
		if (object.size !== file.size) {
			await object.body.cancel()
			throw new ServerFault('file_object_mismatch', `the object of a file of kind '${file.kind}' has another size than its row records`)
		}
		return { file, object }
	}

	/** `ctx.files.open(ref)`: the bytes of a live file, read whole, at most `maxBytes` (the kind's by default). */
	async open(work: FileWork, reference: unknown, options: { readonly maxBytes?: number } = {}): Promise<OpenedFile> {
		const { file, object } = await this.#object(work, 'ctx.files.open', reference)
		const maxBytes = options.maxBytes ?? this.#kinds.get(file.kind)?.artifact.maxBytes ?? file.size
		if (file.size > maxBytes) {
			await object.body.cancel()
			throw new HttpError(413, 'too_large', `The file has ${file.size} bytes, more than the ${maxBytes} this site reads`)
		}
		const bytes = await readExactly(object.body, file.size)
		if (bytes === null) {
			throw new ServerFault('file_object_mismatch', `the object of a file of kind '${file.kind}' has another size than its row records`)
		}
		return Object.freeze({ id: file.id, name: file.name, type: file.type, size: file.size, bytes })
	}

	/** The answer of a procedure whose output is a file: the file the handler returned, streamed. */
	async download(work: FileWork, endpoint: string, kind: string, reference: unknown): Promise<FileDownload> {
		const holding = fileHoldingOf(reference)
		if (holding !== undefined && holding.kind !== kind) {
			throw new ServerFault('file_output_kind', `'${endpoint}' answers files of kind '${kind}', and its handler returned a file of another kind`)
		}
		const { file, object } = await this.#object(work, `'${endpoint}'`, reference)
		return new FileDownload({ body: object.body, size: file.size, contentType: file.type, name: file.name })
	}

	/**
	 * The sweep: it finishes deletions a crash interrupted, adopts the migrated files a declared column references, then
	 * deletes, batch by batch, every file past the grace that no declared column references: its row and the record of
	 * its object in one transaction (the foreign key keeps a referenced one), then the object, then the record.
	 */
	async sweep(signal: AbortSignal): Promise<void> {
		let step = 'rows_read_failed'
		try {
			for (let keys = await this.#files.unfinishedDeletions(SWEEP_BATCH); keys.length > 0 && !signal.aborted;) {
				for (const key of keys) {
					step = 'object_delete_failed'
					await this.#store.delete(key)
					step = 'deletion_record_failed'
					await this.#files.forgetDeletion(key)
				}
				step = 'rows_read_failed'
				keys = keys.length === SWEEP_BATCH ? await this.#files.unfinishedDeletions(SWEEP_BATCH) : []
			}
			await this.#files.adoptReferenced(this.#columns)
			for (let more = true; more && !signal.aborted;) {
				step = 'rows_read_failed'
				const batch = await this.#files.unreferenced(this.#columns, SWEEP_BATCH, FILE_PENDING_GRACE_MS)
				for (const id of batch) {
					step = 'row_delete_failed'
					const key = await this.#files.remove(id, FILE_PENDING_GRACE_MS)
					if (key === null) {
						continue
					}
					step = 'object_delete_failed'
					await this.#store.delete(key)
					step = 'deletion_record_failed'
					await this.#files.forgetDeletion(key)
				}
				more = batch.length === SWEEP_BATCH
			}
		} catch {
			console.error(`fabrika: stored files sweep: ${step}`)
			throw new ServerFault('file_sweep_failed', 'the sweep of stored files failed; the next run retries it')
		}
	}

	/** One scan pass over the quarantined files of every scanning kind: the scan job's part for kinds. */
	async scanPass(scanner: FileScanner | null, reporter: OperationsReporter, signal: AbortSignal): Promise<void> {
		const files = this.#files
		const scanning: ScanningKind[] = [...this.#kinds.values()].filter((kind) => kind.artifact.scan === true).map((kind) => ({
			name: kind.name,
			table: {
				quarantined: (limit: number, now: Date) => files.quarantined([kind.name], limit, now),
				promote: (id: string, sha256: string, version: string) => files.promote(id, sha256, version),
				deferScan: (id: string, attempts: number, after: Date) => files.deferScan(id, attempts, after),
				reject: (id: string) => files.reject(id),
			},
		}))
		await runScanPass({ collections: scanning, store: this.#store, scanner, reporter, signal })
	}
}

/** Where `ctx.files.put` and `.open` run: the site's name, its liveness check, and whether it may create a file. */
export interface StoredFileSite {
	readonly where: string
	readonly check: () => void
	/** A query reads only, so it puts no file. */
	readonly writes: boolean
}

/** `ctx.files.put` and `.open` of one site, bound to its work. */
export function storedFilesHandle(
	kinds: StoredFileKinds | null,
	work: FileWork,
	site: StoredFileSite,
): {
	readonly put: (kind: unknown, body: PutBody, options: PutOptions) => Promise<FileRef>
	readonly open: (file: unknown, options?: { readonly maxBytes?: number }) => Promise<OpenedFile>
} {
	const declared = (): StoredFileKinds => {
		if (kinds === null) {
			throw new ServerFault('file_kind_unknown', `${site.where}: ctx.files.put and open need a file kind, and the contract declares none`)
		}
		return kinds
	}
	return Object.freeze({
		put: async (kind: unknown, body: PutBody, options: PutOptions) => {
			site.check()
			if (!site.writes) {
				throw new QueryRefusedError('read_only', `${site.where}: a query creates no file; put it in a mutation, a job or a webhook`)
			}
			return await declared().put(work, kind, body, options)
		},
		open: async (file: unknown, options: { readonly maxBytes?: number } = {}) => {
			site.check()
			return await declared().open(work, file, options)
		},
	})
}

/** Bytes in memory as the stream the object store writes. */
function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			if (bytes.byteLength > 0) {
				controller.enqueue(bytes)
			}
			controller.close()
		},
	})
}

/** The file columns of every table policy: where the sweep looks a file up. */
function fileColumns(artifact: ContractArtifact): FileColumnRef[] {
	return Object.entries(artifact.tables).flatMap(([table, policy]) => Object.keys(policy.files ?? {}).map((column) => ({ table, column })))
}

/**
 * The file kinds of `artifact`, or `null` when it declares none. Every reason a kind cannot be served goes into
 * `problems`, so `boot` refuses to start rather than take a file it cannot check.
 */
export function storedFileKinds(
	artifact: ContractArtifact,
	database: ImplementationDatabase | null,
	store: FileObjectStore | undefined,
	problems: string[],
): StoredFileKinds | null {
	const entries = Object.entries(artifact.fileKinds ?? {})
	if (entries.length === 0) {
		return null
	}
	if (store === undefined) {
		problems.push('file kinds are declared, and the runtime adapter supplies no object storage (FABRIKA_APP_STORAGE_* on Zerops)')
	}
	if (database === null || !isScopedDatabase(database)) {
		problems.push('file kinds need the scoped(tables) data layer of @fabrika/db: a stored file is a value in a table column')
		return null
	}
	for (const [name, kind] of entries) {
		for (const type of kind.types.filter((candidate) => !SNIFFABLE_TYPES.includes(candidate))) {
			problems.push(`files '${name}' admits '${type}', whose bytes the framework cannot verify (allowed: ${SNIFFABLE_TYPES.join(', ')})`)
		}
	}
	if (store === undefined) {
		return null
	}
	return new StoredFileKinds(
		entries.map(([name, artifact]) => ({ name, artifact })),
		store,
		frameworkTablesOf(database).files,
		fileColumns(artifact),
	)
}
