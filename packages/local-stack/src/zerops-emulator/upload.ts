import { createHash, timingSafeEqual } from 'node:crypto'
import {
	LOCAL_SOURCE_MAX_COMPRESSED_BYTES,
	LOCAL_SOURCE_MAX_EXPANDED_BYTES,
	type LocalSourceUploadGrant,
	type LocalSourceUploadReceipt,
} from '../local-source-contract'

/** What one completed upload carried: its transport receipt and, when it is a source tarball, its descriptor digest. */
export interface UploadedSource {
	receipt: LocalSourceUploadReceipt
	descriptorSha256?: string
}

const TAR_BLOCK = 512
const DESCRIPTOR_PATH = 'zerops.yaml'

const tarText = (block: Uint8Array, start: number, length: number): string => {
	const field = block.subarray(start, start + length)
	const end = field.indexOf(0)
	return new TextDecoder().decode(end < 0 ? field : field.subarray(0, end))
}

/**
 * The sha256 of the root `zerops.yaml` in an uploaded gzip tarball, or undefined when the bytes are not
 * one. Synthetic test uploads are opaque bytes, so this never refuses an upload.
 */
export function uploadedDescriptorDigest(compressed: Uint8Array<ArrayBuffer>): string | undefined {
	let tar: Uint8Array
	try {
		tar = Bun.gunzipSync(compressed)
	} catch {
		return undefined
	}
	if (tar.byteLength > LOCAL_SOURCE_MAX_EXPANDED_BYTES * 2) return undefined
	for (let offset = 0; offset + TAR_BLOCK <= tar.byteLength;) {
		const header = tar.subarray(offset, offset + TAR_BLOCK)
		if (header.every((byte) => byte === 0)) return undefined
		const size = Number.parseInt(tarText(header, 124, 12).trim() || '0', 8)
		if (!Number.isSafeInteger(size) || size < 0) return undefined
		const prefix = tarText(header, 345, 155)
		const name = tarText(header, 0, 100)
		const path = prefix === '' ? name : `${prefix}/${name}`
		const contentStart = offset + TAR_BLOCK
		if (path === DESCRIPTOR_PATH && tarText(header, 156, 1) === '0') {
			return createHash('sha256').update(tar.subarray(contentStart, contentStart + size)).digest('hex')
		}
		offset = contentStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
	}
	return undefined
}

export const capabilityDigest = (capability: string): string => createHash('sha256').update(capability).digest('hex')

export function matchesCapability(grant: LocalSourceUploadGrant, capability: string): boolean {
	return timingSafeEqual(Buffer.from(grant.capabilitySha256, 'hex'), Buffer.from(capabilityDigest(capability), 'hex'))
}

export async function readUploadedSource(request: Request): Promise<UploadedSource> {
	if (request.body === null) throw new Error('empty upload')
	const reader = request.body.getReader()
	const hash = createHash('sha256')
	const chunks: Uint8Array[] = []
	let compressedBytes = 0
	const abort = () => {
		void reader.cancel().catch(() => {})
	}
	request.signal.addEventListener('abort', abort, { once: true })
	try {
		request.signal.throwIfAborted()
		while (true) {
			const chunk = await reader.read()
			request.signal.throwIfAborted()
			if (chunk.done) break
			compressedBytes += chunk.value.byteLength
			if (compressedBytes > LOCAL_SOURCE_MAX_COMPRESSED_BYTES) throw new Error('upload exceeds local byte limit')
			hash.update(chunk.value)
			chunks.push(chunk.value)
		}
		if (compressedBytes === 0) throw new Error('empty upload')
		const receipt = { compressedBytes, compressedSha256: hash.digest('hex') }
		const descriptorSha256 = uploadedDescriptorDigest(new Uint8Array(Buffer.concat(chunks)))
		return descriptorSha256 === undefined ? { receipt } : { receipt, descriptorSha256 }
	} catch {
		void reader.cancel().catch(() => {})
		throw new Error('incomplete local source upload')
	} finally {
		request.signal.removeEventListener('abort', abort)
		reader.releaseLock()
	}
}
