import { ZEROPS_SOURCE_DESCRIPTOR_MAX_BYTES } from '@fabrika/provider-zerops'
import { createHash, type Hash } from 'node:crypto'
import { SourceFailure } from './failure'

export const SOURCE_MAX_TREE_ENTRIES = 50_000
export const SOURCE_MAX_EXPANDED_BYTES = 512 * 1024 * 1024
export const SOURCE_DESCRIPTOR_PATH = 'zerops.yaml'
/** A repository with submodules: `git archive` emits them as bare directories, so this file is the only signal. */
export const SOURCE_SUBMODULE_MARKER = '.gitmodules'

const BLOCK_BYTES = 512
const MAX_PAX_PAYLOAD_BYTES = 64 * 1024
const END_OF_ARCHIVE_BLOCKS = 2
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/

/** Bun types a stream element as an `ArrayBuffer`-backed view; naming it once keeps the pipe cast-free. */
export type SourceBytes = Uint8Array<ArrayBuffer>

export interface ArchiveSummary {
	commitSha: string
	descriptorSha256: string
	entryCount: number
	expandedBytes: number
}

export interface TarRewriteInput {
	/** The exact commit the tarball must name in its pax global header. */
	commitSha: string
	descriptorSha256: string
}

export interface TarRewrite {
	readonly transform: TransformStream<SourceBytes, SourceBytes>
	readonly completed: Promise<ArchiveSummary>
	/** Settle a still-pending outcome once the destination has stopped reading. */
	abandon(): void
}

/**
 * Rewrite a `git archive` tarball into the archive Zerops accepts, one 512-byte block at a time.
 *
 * The transform holds at most one header block plus one bounded pax record: file content is passed
 * through chunk by chunk, so nothing here scales with repository or file size.
 */
export function createTarRewrite(input: TarRewriteInput): TarRewrite {
	if (!SHA256_PATTERN.test(input.descriptorSha256)) {
		throw new SourceFailure('descriptor_mismatch', 'archive', false, 409)
	}
	const outcome = Promise.withResolvers<ArchiveSummary>()
	// The caller reads this only after the PUT settles; keep an early rejection from looking unhandled.
	outcome.promise.catch(() => {})
	const rewriter = new TarRewriter(input)
	const transform = new TransformStream<SourceBytes, SourceBytes>({
		transform(chunk, controller) {
			try {
				rewriter.push(chunk, controller)
			} catch (error) {
				throw settleFailure(outcome.reject, error)
			}
		},
		flush(controller) {
			let summary: ArchiveSummary
			try {
				summary = rewriter.finish(controller)
			} catch (error) {
				throw settleFailure(outcome.reject, error)
			}
			outcome.resolve(summary)
		},
	})
	return {
		transform,
		completed: outcome.promise,
		abandon: () => outcome.reject(new SourceFailure('upload_failed', 'upload', false, 502)),
	}
}

function settleFailure(
	reject: (failure: SourceFailure) => void,
	error: unknown,
): SourceFailure {
	const failure = error instanceof SourceFailure ? error : new SourceFailure('internal', 'archive', true, 500)
	reject(failure)
	return failure
}

type Phase =
	| { kind: 'header' }
	| { kind: 'pax'; global: boolean; payload: SourceBytes; filled: number; padding: number }
	| { kind: 'content'; remaining: number; padding: number }
	| { kind: 'discard'; remaining: number }
	| { kind: 'trailer' }

interface TarEntryHeader {
	path: string
	mode: number
	size: number
	typeflag: string
}

class TarRewriter {
	private phase: Phase = { kind: 'header' }
	private readonly block: SourceBytes = new Uint8Array(BLOCK_BYTES)
	private blockFilled = 0
	private prefix: string | undefined
	private pendingPath: string | undefined
	private pendingSize: number | undefined
	private commitConfirmed = false
	private started = false
	private zeroBlocks = 0
	private entryCount = 0
	private expandedBytes = 0
	private paxIndex = 0
	private descriptorHash: Hash | undefined
	private descriptorDigest: string | undefined
	private readonly paths = new Set<string>()

	constructor(private readonly input: TarRewriteInput) {}

	push(
		chunk: SourceBytes,
		controller: TransformStreamDefaultController<SourceBytes>,
	): void {
		let offset = 0
		while (offset < chunk.byteLength) {
			const phase = this.phase
			if (phase.kind === 'content') {
				const take = Math.min(phase.remaining, chunk.byteLength - offset)
				const slice = chunk.subarray(offset, offset + take)
				this.descriptorHash?.update(slice)
				controller.enqueue(slice)
				phase.remaining -= take
				offset += take
				if (phase.remaining === 0) {
					this.completeEntry()
					if (phase.padding > 0) controller.enqueue(new Uint8Array(phase.padding))
					this.phase = phase.padding === 0 ? { kind: 'header' } : { kind: 'discard', remaining: phase.padding }
				}
				continue
			}
			if (phase.kind === 'discard') {
				const take = Math.min(phase.remaining, chunk.byteLength - offset)
				phase.remaining -= take
				offset += take
				if (phase.remaining === 0) this.phase = { kind: 'header' }
				continue
			}
			if (phase.kind === 'pax') {
				const take = Math.min(
					phase.payload.byteLength - phase.filled,
					chunk.byteLength - offset,
				)
				phase.payload.set(chunk.subarray(offset, offset + take), phase.filled)
				phase.filled += take
				offset += take
				if (phase.filled === phase.payload.byteLength) {
					this.applyPax(phase.payload, phase.global)
					this.phase = phase.padding === 0 ? { kind: 'header' } : { kind: 'discard', remaining: phase.padding }
				}
				continue
			}
			const take = Math.min(BLOCK_BYTES - this.blockFilled, chunk.byteLength - offset)
			this.block.set(chunk.subarray(offset, offset + take), this.blockFilled)
			this.blockFilled += take
			offset += take
			if (this.blockFilled === BLOCK_BYTES) {
				this.blockFilled = 0
				this.handleBlock(controller)
			}
		}
	}

	finish(controller: TransformStreamDefaultController<SourceBytes>): ArchiveSummary {
		if (
			this.blockFilled !== 0
			|| this.phase.kind !== 'trailer'
			|| this.zeroBlocks < END_OF_ARCHIVE_BLOCKS
		) {
			throw archiveRejected()
		}
		if (!this.commitConfirmed) throw commitMismatch()
		const descriptorSha256 = this.descriptorDigest
		if (descriptorSha256 === undefined) {
			throw new SourceFailure('descriptor_missing', 'archive', false, 422)
		}
		controller.enqueue(new Uint8Array(BLOCK_BYTES * END_OF_ARCHIVE_BLOCKS))
		return {
			commitSha: this.input.commitSha,
			descriptorSha256,
			entryCount: this.entryCount,
			expandedBytes: this.expandedBytes,
		}
	}

	private handleBlock(
		controller: TransformStreamDefaultController<SourceBytes>,
	): void {
		const zero = isZeroBlock(this.block)
		if (this.phase.kind === 'trailer') {
			if (!zero) throw archiveRejected()
			this.zeroBlocks++
			return
		}
		if (zero) {
			this.zeroBlocks = 1
			this.phase = { kind: 'trailer' }
			return
		}
		verifyChecksum(this.block)
		const header = parseHeader(this.block)
		if (header.typeflag === 'g') {
			if (
				this.started
				|| this.commitConfirmed
				|| this.pendingPath !== undefined
				|| this.pendingSize !== undefined
			) {
				throw archiveRejected()
			}
			this.beginPax(header.size, true)
			return
		}
		if (header.typeflag === 'x') {
			this.beginPax(header.size, false)
			return
		}
		if (!this.commitConfirmed) throw commitMismatch()
		const path = this.pendingPath ?? header.path
		const size = this.pendingSize ?? header.size
		this.pendingPath = undefined
		this.pendingSize = undefined
		this.started = true
		const relative = this.strip(path)
		// git never tracks an empty directory, so every kept path arrives with its own entry.
		if (header.typeflag === '5') {
			this.phase = skipPhase(size)
			return
		}
		if (header.typeflag !== '0') throw archiveRejected()
		this.beginEntry(relative, header.mode, size, controller)
	}

	private strip(path: string): string {
		if (this.prefix === undefined) {
			const boundary = path.indexOf('/')
			if (boundary <= 0) throw archiveRejected()
			this.prefix = path.slice(0, boundary + 1)
		}
		if (!path.startsWith(this.prefix)) throw archiveRejected()
		return path.slice(this.prefix.length)
	}

	private beginEntry(
		path: string,
		mode: number,
		size: number,
		controller: TransformStreamDefaultController<SourceBytes>,
	): void {
		if (!safeRepositoryPath(path) || path === SOURCE_SUBMODULE_MARKER) {
			throw archiveRejected()
		}
		if (this.paths.has(path)) throw archiveRejected()
		this.paths.add(path)
		this.entryCount++
		this.expandedBytes += size
		if (
			this.entryCount > SOURCE_MAX_TREE_ENTRIES
			|| this.expandedBytes > SOURCE_MAX_EXPANDED_BYTES
		) {
			throw new SourceFailure('archive_rejected', 'archive', false, 413)
		}
		if (path === SOURCE_DESCRIPTOR_PATH) {
			if (size > ZEROPS_SOURCE_DESCRIPTOR_MAX_BYTES) {
				throw new SourceFailure('archive_rejected', 'archive', false, 422)
			}
			this.descriptorHash = createHash('sha256')
		}
		this.writeEntryHeader(path, mode, size, controller)
		if (size === 0) {
			this.completeEntry()
			this.phase = { kind: 'header' }
			return
		}
		this.phase = { kind: 'content', remaining: size, padding: paddingFor(size) }
	}

	private completeEntry(): void {
		const hash = this.descriptorHash
		if (hash === undefined) return
		this.descriptorHash = undefined
		const digest = hash.digest('hex')
		if (digest !== this.input.descriptorSha256) {
			throw new SourceFailure('descriptor_mismatch', 'archive', false, 409)
		}
		this.descriptorDigest = digest
	}

	private writeEntryHeader(
		path: string,
		mode: number,
		size: number,
		controller: TransformStreamDefaultController<SourceBytes>,
	): void {
		let name = path
		if (new TextEncoder().encode(path).byteLength > 100) {
			const record = paxPathRecord(path)
			controller.enqueue(
				tarHeader(`PaxHeaders/${this.paxIndex}`, 0o644, record.byteLength, 'x'),
			)
			controller.enqueue(record)
			const padding = paddingFor(record.byteLength)
			if (padding > 0) controller.enqueue(new Uint8Array(padding))
			name = `PaxEntry/${this.paxIndex}`
			this.paxIndex++
		}
		controller.enqueue(
			tarHeader(name, (mode & 0o111) === 0 ? 0o644 : 0o755, size, '0'),
		)
	}

	private beginPax(size: number, global: boolean): void {
		if (size <= 0 || size > MAX_PAX_PAYLOAD_BYTES) throw archiveRejected()
		this.phase = {
			kind: 'pax',
			global,
			payload: new Uint8Array(size),
			filled: 0,
			padding: paddingFor(size),
		}
	}

	private applyPax(payload: SourceBytes, global: boolean): void {
		const records = parsePaxRecords(payload)
		if (global) {
			if (records.get('comment') !== this.input.commitSha) throw commitMismatch()
			this.commitConfirmed = true
			return
		}
		const path = records.get('path')
		if (path !== undefined) this.pendingPath = path
		const size = records.get('size')
		if (size === undefined) return
		if (!DECIMAL_PATTERN.test(size)) throw archiveRejected()
		const parsed = Number(size)
		if (!Number.isSafeInteger(parsed)) throw archiveRejected()
		this.pendingSize = parsed
	}
}

/** Only `path` and `size` may reshape an entry; `linkpath` would make it something we refuse to carry. */
function parsePaxRecords(payload: SourceBytes): Map<string, string> {
	const records = new Map<string, string>()
	let offset = 0
	while (offset < payload.byteLength) {
		const space = payload.subarray(offset).indexOf(0x20)
		if (space <= 0) throw archiveRejected()
		const declared = decodeUtf8(payload.subarray(offset, offset + space))
		if (!DECIMAL_PATTERN.test(declared)) throw archiveRejected()
		const length = Number(declared)
		if (
			!Number.isSafeInteger(length)
			|| length <= space + 1
			|| offset + length > payload.byteLength
			|| byteAt(payload, offset + length - 1) !== 0x0a
		) {
			throw archiveRejected()
		}
		const record = decodeUtf8(
			payload.subarray(offset + space + 1, offset + length - 1),
		)
		const separator = record.indexOf('=')
		if (separator <= 0) throw archiveRejected()
		const keyword = record.slice(0, separator)
		if (keyword === 'linkpath') throw archiveRejected()
		records.set(keyword, record.slice(separator + 1))
		offset += length
	}
	return records
}

function parseHeader(block: Uint8Array): TarEntryHeader {
	const magic = headerText(block, 257, 6).trim()
	if (magic !== 'ustar') throw archiveRejected()
	const name = headerText(block, 0, 100)
	const prefix = headerText(block, 345, 155)
	const typeflag = byteAt(block, 156)
	return {
		path: prefix === '' ? name : `${prefix}/${name}`,
		mode: headerOctal(block, 100, 8),
		size: headerOctal(block, 124, 12),
		typeflag: typeflag === 0 ? '0' : String.fromCharCode(typeflag),
	}
}

function verifyChecksum(block: Uint8Array): void {
	const stored = headerOctal(block, 148, 8)
	let sum = 0
	let index = 0
	for (const byte of block) {
		sum += index >= 148 && index < 156 ? 0x20 : byte
		index++
	}
	if (sum !== stored) throw archiveRejected()
}

function headerText(block: Uint8Array, offset: number, length: number): string {
	const field = block.subarray(offset, offset + length)
	const end = field.indexOf(0)
	return decodeUtf8(field.subarray(0, end === -1 ? field.byteLength : end))
}

function headerOctal(block: Uint8Array, offset: number, length: number): number {
	const raw = headerText(block, offset, length).trim()
	if (raw === '') return 0
	if (!/^[0-7]+$/.test(raw)) throw archiveRejected()
	const value = Number.parseInt(raw, 8)
	if (!Number.isSafeInteger(value) || value < 0) throw archiveRejected()
	return value
}

function decodeUtf8(bytes: Uint8Array): string {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
	} catch {
		throw archiveRejected()
	}
}

function byteAt(bytes: Uint8Array, index: number): number {
	const value = bytes[index]
	if (value === undefined) throw archiveRejected()
	return value
}

function isZeroBlock(block: Uint8Array): boolean {
	for (const byte of block) {
		if (byte !== 0) return false
	}
	return true
}

function skipPhase(size: number): Phase {
	const total = size + paddingFor(size)
	return total === 0 ? { kind: 'header' } : { kind: 'discard', remaining: total }
}

function paddingFor(size: number): number {
	return (BLOCK_BYTES - (size % BLOCK_BYTES)) % BLOCK_BYTES
}

export function safeRepositoryPath(path: string): boolean {
	if (
		path === ''
		|| path.startsWith('/')
		|| path.includes('\\')
		|| [...path].some(
			(character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f,
		)
	) {
		return false
	}
	return path
		.split('/')
		.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

function paxPathRecord(path: string): SourceBytes {
	const body = `path=${path}\n`
	let length = new TextEncoder().encode(body).byteLength + 3
	while (true) {
		const bytes = new TextEncoder().encode(`${length} ${body}`)
		if (bytes.byteLength === length) return bytes
		length = bytes.byteLength
	}
}

function tarHeader(
	path: string,
	mode: number,
	size: number,
	type: '0' | 'x',
): SourceBytes {
	const header = new Uint8Array(BLOCK_BYTES)
	writeTarText(header, 0, 100, path)
	writeTarOctal(header, 100, 8, mode)
	writeTarOctal(header, 108, 8, 0)
	writeTarOctal(header, 116, 8, 0)
	writeTarOctal(header, 124, 12, size)
	writeTarOctal(header, 136, 12, 0)
	header.fill(0x20, 148, 156)
	header[156] = type.charCodeAt(0)
	writeTarText(header, 257, 6, 'ustar')
	writeTarText(header, 263, 2, '00')
	let checksum = 0
	for (const byte of header) checksum += byte
	writeTarText(header, 148, 6, checksum.toString(8).padStart(6, '0'))
	header[154] = 0
	header[155] = 0x20
	return header
}

function writeTarText(
	target: Uint8Array,
	offset: number,
	length: number,
	value: string,
): void {
	const bytes = new TextEncoder().encode(value)
	if (bytes.byteLength > length) throw archiveRejected()
	target.set(bytes, offset)
}

function writeTarOctal(
	target: Uint8Array,
	offset: number,
	length: number,
	value: number,
): void {
	const encoded = value.toString(8).padStart(length - 1, '0')
	if (encoded.length >= length) {
		throw new SourceFailure('archive_rejected', 'archive', false, 413)
	}
	writeTarText(target, offset, length - 1, encoded)
	target[offset + length - 1] = 0
}

function archiveRejected(): SourceFailure {
	return new SourceFailure('archive_rejected', 'archive', false, 422)
}

function commitMismatch(): SourceFailure {
	return new SourceFailure('commit_mismatch', 'archive', false, 409)
}
