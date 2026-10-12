// The scan pass of `scan: true` collections: a framework job (`FILE_SCAN_JOB`) that takes a batch of quarantined files,
// hands their objects to a `FileScanner`, and writes each verdict under the job's lease. It fails closed: only a
// completed clean verdict over bytes whose size and digest match the upload's promotes a file. Every other outcome —
// no scanner, a scanner error, a timeout, an encrypted or oversize file, a missing verdict, a truncated object — leaves
// it quarantined and reports. The scanner comes from the runtime adapter (`clamscan.ts` on Bun).

import type { FileCollectionTable, QuarantinedFile } from '@fabrika/db/framework'
import type { FileObjectStore } from '@fabrika/platform'
import type { JobReporter } from '../jobs/report'

/** The reserved name of the scan job: a `c.cron` job name cannot contain `-`, so no application job takes it. */
export const FILE_SCAN_JOB = 'fabrika-file-scan'
export const FILE_SCAN_SCHEDULE = '* * * * *'

export const SCAN_LIMITS = {
	/** One pass scans at most this many files, and at most `batchBytes` of them; the next pass takes the rest. */
	batchFiles: 20,
	batchBytes: 256 * 1024 * 1024,
	/** A scanner that has not answered by then is stopped, and its whole batch stays quarantined. */
	scanTimeoutMs: 5 * 60_000,
	/** The attempt's deadline; it outlasts the scanner's, so the verdicts are written before it. */
	jobTimeoutMs: 10 * 60_000,
} as const

/** What the scanner decided about one file. Only `clean` promotes; `infected` rejects; anything else stays quarantined. */
export type ScanVerdict = { readonly kind: 'clean' } | { readonly kind: 'infected'; readonly signature: string } | { readonly kind: 'unscanned' }

/** Why a whole batch got no verdict. Fixed codes only: a scanner's own output is never reported. */
export type ScanFailure =
	| 'scanner_missing'
	| 'signatures_missing'
	| 'signatures_stale'
	| 'scanner_failed'
	| 'timeout'
	| 'output_overflow'

export type ScanBatchResult =
	| { readonly ok: true; readonly verdicts: ReadonlyMap<string, ScanVerdict> }
	| { readonly ok: false; readonly failure: ScanFailure }

export interface ScanObject {
	/** The file's id: a UUID. */
	readonly id: string
	/** The object's bytes. It throws, or its stream errors, when they are missing or differ from the upload's. */
	open(): Promise<ReadableStream<Uint8Array>>
}

export interface FileScanner {
	/**
	 * A verdict per file id, or why the batch got none. A file whose `open` threw or whose stream errored has no
	 * `clean` verdict. Never throws.
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

/** How reading one file's object ended; only `verified` lets a clean verdict promote it. */
type ReadState = 'unread' | 'verified' | 'missing' | 'mismatch'

/** A signature name as Operations shows it: ClamAV's names are plain, anything else is not repeated. */
function signatureName(signature: string): string {
	return /^[A-Za-z0-9._:/-]{1,128}$/.test(signature) ? signature : 'unnamed'
}

/**
 * The object's bytes, counted and hashed on the way: the stream errors as soon as it runs past the recorded size, and
 * at its end unless size and SHA-256 match the upload's. `settle` learns the outcome.
 */
function verified(body: ReadableStream<Uint8Array>, file: QuarantinedFile, settle: (state: ReadState) => void): ReadableStream<Uint8Array> {
	const hasher = new Bun.CryptoHasher('sha256')
	let length = 0
	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				length += chunk.byteLength
				if (length > file.size) {
					settle('mismatch')
					controller.error(new Error('the object is longer than its upload'))
					return
				}
				hasher.update(chunk)
				controller.enqueue(chunk)
			},
			flush(controller) {
				if (length !== file.size || hasher.digest('hex') !== file.sha256) {
					settle('mismatch')
					controller.error(new Error('the object differs from its upload'))
					return
				}
				settle('verified')
			},
		}),
	)
}

export interface ScanPassInput {
	readonly collections: readonly ScanningCollection[]
	readonly store: FileObjectStore
	/** `null` when the runtime adapter supplies none: every quarantined file stays quarantined. */
	readonly scanner: FileScanner | null
	readonly reporter: JobReporter
	readonly signal: AbortSignal
}

/** The oldest quarantined files of every scanning collection, within the batch bounds. */
async function batch(collections: readonly ScanningCollection[]): Promise<Candidate[]> {
	const candidates: Candidate[] = []
	let bytes = 0
	for (const collection of collections) {
		for (const file of await collection.table.quarantined(SCAN_LIMITS.batchFiles)) {
			if (candidates.length >= SCAN_LIMITS.batchFiles || (candidates.length > 0 && bytes + file.size > SCAN_LIMITS.batchBytes)) {
				return candidates
			}
			candidates.push({ collection, file })
			bytes += file.size
		}
	}
	return candidates
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

function names(candidates: readonly Candidate[]): string {
	return [...new Set(candidates.map((candidate) => `'${candidate.collection.name}'`))].join(', ')
}

/**
 * One pass. A verdict write that fails (the lease lost, the database gone) throws, so the runner reports the run as
 * failed; everything the scanner decides is reported here and never throws.
 */
export async function runScanPass(input: ScanPassInput): Promise<void> {
	const candidates = await batch(input.collections)
	if (candidates.length === 0) {
		return
	}
	const { reporter, scanner, store } = input
	const failed = (failure: ScanFailure | 'delete_failed', count: number, collections: string): Promise<void> =>
		reporter.report({
			fingerprint: ['fabrika-file-scan-failed', failure],
			type: 'FileScanFailed',
			message: `the scan of ${plural(count, 'quarantined file')} of files ${collections} did not complete: ${failure}; they stay quarantined`,
			tags: { code: failure },
		})
	if (scanner === null) {
		console.error('fabrika: the file scan has no scanner; quarantined files stay quarantined')
		await failed('scanner_missing', candidates.length, names(candidates))
		return
	}
	const states = new Map<string, ReadState>(candidates.map((candidate) => [candidate.file.id, 'unread']))
	const objects: ScanObject[] = candidates.map(({ file }) => ({
		id: file.id,
		open: async () => {
			const object = await store.read(file.objectKey)
			if (object === null) {
				states.set(file.id, 'missing')
				throw new Error('the object is missing')
			}
			return verified(object.body, file, (state) => states.set(file.id, state))
		},
	}))
	const result = await scanner.scan(objects, input.signal)
	if (!result.ok) {
		console.error(`fabrika: the file scan did not complete: ${result.failure}`)
		await failed(result.failure, candidates.length, names(candidates))
		return
	}
	const unscanned = new Map<string, number>()
	for (const { collection, file } of candidates) {
		const verdict = result.verdicts.get(file.id) ?? { kind: 'unscanned' }
		const state = states.get(file.id)
		if (state === 'missing') {
			// Its object is gone: a rejection whose delete succeeded before its row was written, or a lost object.
			await collection.table.reject(file.id)
			await reporter.report({
				fingerprint: ['fabrika-file-rejected', collection.name],
				type: 'FileRejected',
				message: `files '${collection.name}': file ${file.id} has no object to scan and is rejected`,
				tags: { collection: collection.name, file: file.id, signature: 'object_missing' },
			})
		} else if (verdict.kind === 'infected') {
			const signature = signatureName(verdict.signature)
			try {
				await store.delete(file.objectKey)
			} catch {
				// The row stays quarantined, so the next pass scans it again and retries the delete.
				await failed('delete_failed', 1, `'${collection.name}'`)
				continue
			}
			await collection.table.reject(file.id)
			await reporter.report({
				fingerprint: ['fabrika-file-rejected', collection.name],
				type: 'FileRejected',
				message: `files '${collection.name}': file ${file.id} is rejected: ${signature}`,
				tags: { collection: collection.name, file: file.id, signature },
			})
		} else if (verdict.kind === 'clean' && state === 'verified') {
			await collection.table.promote(file.id, file.sha256)
		} else {
			unscanned.set(collection.name, (unscanned.get(collection.name) ?? 0) + 1)
		}
	}
	for (const [collection, count] of unscanned) {
		await reporter.report({
			fingerprint: ['fabrika-file-unscanned', collection],
			type: 'FileUnscanned',
			message: `files '${collection}': ${plural(count, 'file')} got no clean verdict and stay quarantined`,
			tags: { collection },
		})
	}
}
