// The scan pass of `scan: true` collections: a framework job (`FILE_SCAN_JOB`) that takes a batch of quarantined files,
// hands their objects to a `FileScanner`, and writes each verdict under the job's lease. It fails closed: a file goes
// live only with a completed clean verdict over the exact bytes its upload recorded, and the download then serves only
// that object version. An archive the scanner cannot read in full is rejected before it is scanned (`archive.ts`). No
// scanner, a scanner error or a timeout leave files quarantined; a file that gets no verdict is retried later, alone,
// and rejected after `SCAN_LIMITS.maxAttempts`. The scanner comes from the runtime adapter (`clamscan.ts` on Bun).

import type { FileCollectionTable, QuarantinedFile } from '@fabrika/db/framework'
import type { FileObjectStore } from '@fabrika/platform'
import type { OperationsReporter } from '../jobs/report'
import { type ArchiveRefusal, checkArchive } from './archive'
import { ZIP_TYPES } from './sniff'

/** The reserved name of the scan job: a `c.cron` job name cannot contain `-`, so no application job takes it. */
export const FILE_SCAN_JOB = 'fabrika-file-scan'
export const FILE_SCAN_SCHEDULE = '* * * * *'

export const SCAN_LIMITS = {
	/** One pass scans at most this many files, and at most `batchBytes` of them; the next pass takes the rest. */
	batchFiles: 20,
	batchBytes: 256 * 1024 * 1024,
	/** The scanner's whole run — reading the objects, the scan, the cleanup — is stopped by then. */
	scanTimeoutMs: 5 * 60_000,
	/** The attempt's deadline; it outlasts the scanner's, so the verdicts are written before it. */
	jobTimeoutMs: 10 * 60_000,
	/** A file that got no verdict this many times is rejected. */
	maxAttempts: 5,
	/** The wait before the next try of a file without a verdict: doubled per try, at most `retryMaxMs`. */
	retryBaseMs: 60_000,
	retryMaxMs: 60 * 60_000,
} as const

/** What the scanner decided about one file. Only `clean` promotes; `infected` rejects; anything else is retried. */
export type ScanVerdict = { readonly kind: 'clean' } | { readonly kind: 'infected'; readonly signature: string } | { readonly kind: 'unscanned' }

/** Why a whole batch got no verdict. Fixed codes only: a scanner's own output is never reported. */
export type ScanFailure =
	| 'scanner_missing'
	| 'signatures_missing'
	| 'signatures_stale'
	| 'scanner_failed'
	| 'timeout'
	| 'output_overflow'

/** The failures of the scanner's own installation: no file is to blame, so none of them counts as a file's try. */
const INSTALLATION_FAILURES: ReadonlySet<ScanFailure> = new Set(['scanner_missing', 'signatures_missing', 'signatures_stale'])

export type ScanBatchResult =
	| { readonly ok: true; readonly verdicts: ReadonlyMap<string, ScanVerdict> }
	| { readonly ok: false; readonly failure: ScanFailure }

export interface ScanObject {
	/** The file's id: a UUID. */
	readonly id: string
	/**
	 * The object's bytes. It throws when they are missing, differ from the upload's, are an archive the scanner cannot
	 * read in full, or `signal` aborts.
	 */
	open(signal: AbortSignal): Promise<ReadableStream<Uint8Array>>
}

export interface FileScanner {
	/**
	 * A verdict per file id, or why the batch got none. A file whose `open` threw has no verdict. Stops once `signal`
	 * aborts. Never throws.
	 */
	scan(objects: readonly ScanObject[], signal: AbortSignal): Promise<ScanBatchResult>
}

export interface ScanningCollection {
	readonly name: string
	readonly table: FileCollectionTable
}

interface Candidate {
	readonly collection: ScanningCollection
	readonly file: QuarantinedFile
}

/** How reading one file's object ended; only `verified` lets a clean verdict promote it, as that version. */
type ReadState =
	| { readonly kind: 'unread' }
	| { readonly kind: 'verified'; readonly version: string }
	| { readonly kind: 'missing' }
	| { readonly kind: 'mismatch' }
	| { readonly kind: 'unsafe'; readonly refusal: ArchiveRefusal }

/** A signature name as Operations shows it: ClamAV's names are plain, anything else is not repeated. */
function signatureName(signature: string): string {
	return /^[A-Za-z0-9._:/-]{1,128}$/.test(signature) ? signature : 'unnamed'
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

/** The next try of a file that has had `attempts` tries: one minute, doubled per try, at most an hour. */
export function retryDelayMs(attempts: number): number {
	return Math.min(SCAN_LIMITS.retryMaxMs, SCAN_LIMITS.retryBaseMs * 2 ** Math.max(0, attempts - 1))
}

/** The whole body, at most `size` bytes; the read stops, and the stream is cancelled, past it or on `signal`. */
async function readExactly(body: ReadableStream<Uint8Array>, size: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer> | null> {
	const reader = body.getReader()
	const aborted = new Promise<null>((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true }))
	const bytes = new Uint8Array(size)
	let length = 0
	try {
		for (let next = await Promise.race([reader.read(), aborted]); next !== null && !next.done; next = await Promise.race([reader.read(), aborted])) {
			if (length + next.value.byteLength > size) return null
			bytes.set(next.value, length)
			length += next.value.byteLength
		}
		return signal.aborted || length !== size ? null : bytes
	} finally {
		await reader.cancel().catch(() => undefined)
	}
}

export interface ScanPassInput {
	readonly collections: readonly ScanningCollection[]
	readonly store: FileObjectStore
	/** `null` when the runtime adapter supplies none: every quarantined file stays quarantined. */
	readonly scanner: FileScanner | null
	readonly reporter: OperationsReporter
	readonly signal: AbortSignal
	readonly now?: () => Date
}

/**
 * The batch: the due files that waited longest first, across every scanning collection, so a busy collection or a
 * stream of new uploads never holds back an older file. A file that has failed before is scanned alone, so it cannot
 * take others down with it; new files go together, within the batch bounds.
 */
async function batch(collections: readonly ScanningCollection[], now: Date): Promise<Candidate[]> {
	const due: Candidate[] = []
	for (const collection of collections) {
		for (const file of await collection.table.quarantined(SCAN_LIMITS.batchFiles, now)) due.push({ collection, file })
	}
	due.sort((left, right) => left.file.dueSince.getTime() - right.file.dueSince.getTime())
	const [first] = due
	if (first === undefined || first.file.scanAttempts > 0) return first === undefined ? [] : [first]
	const candidates: Candidate[] = []
	let bytes = 0
	for (const candidate of due) {
		const full = candidates.length >= SCAN_LIMITS.batchFiles || (candidates.length > 0 && bytes + candidate.file.size > SCAN_LIMITS.batchBytes)
		if (full || candidate.file.scanAttempts > 0) break
		candidates.push(candidate)
		bytes += candidate.file.size
	}
	return candidates
}

function names(candidates: readonly Candidate[]): string {
	return [...new Set(candidates.map((candidate) => `'${candidate.collection.name}'`))].join(', ')
}

class ScanPass {
	readonly #input: ScanPassInput
	readonly #states = new Map<string, ReadState>()
	readonly #now: () => Date

	constructor(input: ScanPassInput) {
		this.#input = input
		this.#now = input.now ?? (() => new Date())
	}

	/**
	 * The object's bytes, read whole, checked against the upload's size and digest, and checked as an archive. Its
	 * outcome is the file's read state; the bytes reach the scanner only when they are verified.
	 */
	async load(file: QuarantinedFile, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
		const object = await this.#input.store.read(file.objectKey, signal)
		if (object === null) {
			this.#states.set(file.id, { kind: 'missing' })
			throw new Error('the object is missing')
		}
		const bytes = object.size === file.size ? await readExactly(object.body, file.size, signal) : null
		if (object.size !== file.size) await object.body.cancel()
		if (bytes === null || new Bun.CryptoHasher('sha256').update(bytes).digest('hex') !== file.sha256) {
			if (!signal.aborted) this.#states.set(file.id, { kind: 'mismatch' })
			throw new Error('the object differs from its upload')
		}
		const archive = checkArchive(bytes, ZIP_TYPES.includes(file.contentType))
		if (!archive.ok) {
			this.#states.set(file.id, { kind: 'unsafe', refusal: archive.refusal })
			throw new Error('the scanner cannot read this archive in full')
		}
		this.#states.set(file.id, { kind: 'verified', version: object.version })
		return bytes
	}

	async run(): Promise<void> {
		const { scanner, signal } = this.#input
		const candidates = await batch(this.#input.collections, this.#now())
		if (candidates.length === 0) return
		const none = new Map<string, ScanVerdict>()
		if (scanner === null) {
			console.error('fabrika: the file scan has no scanner; quarantined files stay quarantined')
			await this.#failed('scanner_missing', candidates)
			return
		}
		const objects = candidates.map(({ file }): ScanObject => ({
			id: file.id,
			open: async (stop) => new Blob([await this.load(file, stop)]).stream(),
		}))
		const result = await scanner.scan(objects, signal)
		if (!result.ok) {
			console.error(`fabrika: the file scan did not complete: ${result.failure}`)
			await this.#failed(result.failure, candidates)
			// A broken installation is no file's fault; a run that failed over its files counts a try for each.
			return this.#settle(candidates, none, !INSTALLATION_FAILURES.has(result.failure))
		}
		await this.#settle(candidates, result.verdicts, true)
	}

	async #failed(failure: ScanFailure | 'delete_failed', files: readonly Candidate[]): Promise<void> {
		await this.#input.reporter.report({
			fingerprint: ['fabrika-file-scan-failed', failure],
			type: 'FileScanFailed',
			message: `the scan of ${plural(files.length, 'quarantined file')} of files ${names(files)} did not complete: ${failure}; they stay quarantined`,
			tags: { code: failure },
		})
	}

	/**
	 * Each file's outcome, written under the lease; a write that fails throws, and the run fails with it. A file without
	 * a decisive outcome is tried again later when `countTry`, and otherwise left as it is.
	 */
	async #settle(candidates: readonly Candidate[], verdicts: ReadonlyMap<string, ScanVerdict>, countTry: boolean): Promise<void> {
		const unscanned: Candidate[] = []
		for (const candidate of candidates) {
			const { collection, file } = candidate
			const state = this.#states.get(file.id) ?? { kind: 'unread' }
			const verdict = verdicts.get(file.id) ?? { kind: 'unscanned' }
			if (state.kind === 'missing') {
				// Its object is gone: a rejection whose delete succeeded before its row was written, or a lost object.
				await this.#reject(candidate, 'object_missing', `files '${collection.name}': file ${file.id} has no object to scan and is rejected`)
			} else if (state.kind === 'unsafe') {
				await this.#reject(candidate, `Fabrika.Archive.${state.refusal}`, `files '${collection.name}': file ${file.id} is rejected: ${state.refusal}`)
			} else if (verdict.kind === 'infected') {
				const signature = signatureName(verdict.signature)
				await this.#reject(candidate, signature, `files '${collection.name}': file ${file.id} is rejected: ${signature}`)
			} else if (state.kind === 'verified' && verdict.kind === 'clean') {
				await collection.table.promote(file.id, file.sha256, state.version)
			} else {
				unscanned.push(candidate)
			}
		}
		if (countTry) await this.#retryLater(unscanned)
	}

	/**
	 * Deletes the object, then marks the row rejected. A failed delete leaves it quarantined, unserved, and waiting like
	 * a retry, so the next try deletes it again and failing deletes never fill every batch.
	 */
	async #reject(candidate: Candidate, signature: string, message: string): Promise<void> {
		const { collection, file } = candidate
		try {
			await this.#input.store.delete(file.objectKey)
		} catch {
			await this.#failed('delete_failed', [candidate])
			const attempts = file.scanAttempts + 1
			await collection.table.deferScan(file.id, attempts, new Date(this.#now().getTime() + retryDelayMs(attempts)))
			return
		}
		await collection.table.reject(file.id)
		await this.#input.reporter.report({
			fingerprint: ['fabrika-file-rejected', collection.name],
			type: 'FileRejected',
			message,
			tags: { collection: collection.name, file: file.id, signature },
		})
	}

	/** A try without a verdict: the file waits, then is tried alone; past the last try it is rejected. */
	async #retryLater(candidates: readonly Candidate[]): Promise<void> {
		const counts = new Map<string, number>()
		for (const candidate of candidates) {
			const { collection, file } = candidate
			const attempts = file.scanAttempts + 1
			if (attempts >= SCAN_LIMITS.maxAttempts) {
				await this.#reject(
					candidate,
					'Fabrika.Unscannable',
					`files '${collection.name}': file ${file.id} got no verdict in ${plural(attempts, 'attempt')} and is rejected`,
				)
				continue
			}
			await collection.table.deferScan(file.id, attempts, new Date(this.#now().getTime() + retryDelayMs(attempts)))
			counts.set(collection.name, (counts.get(collection.name) ?? 0) + 1)
		}
		for (const [collection, count] of counts) {
			await this.#input.reporter.report({
				fingerprint: ['fabrika-file-unscanned', collection],
				type: 'FileUnscanned',
				message: `files '${collection}': ${plural(count, 'file')} got no clean verdict; each is tried again later, alone`,
				tags: { collection },
			})
		}
	}
}

/**
 * One pass. A verdict write that fails (the lease lost, the database gone) throws, so the runner reports the run as
 * failed; everything the scanner decides is reported here and never throws.
 */
export function runScanPass(input: ScanPassInput): Promise<void> {
	return new ScanPass(input).run()
}
