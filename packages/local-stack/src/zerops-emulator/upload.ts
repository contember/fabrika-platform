import { createHash, timingSafeEqual } from 'node:crypto'
import { LOCAL_SOURCE_MAX_COMPRESSED_BYTES, type LocalSourceUploadGrant, type LocalSourceUploadReceipt } from '../local-source-contract'

export const capabilityDigest = (capability: string): string => createHash('sha256').update(capability).digest('hex')

export function matchesCapability(grant: LocalSourceUploadGrant, capability: string): boolean {
	return timingSafeEqual(Buffer.from(grant.capabilitySha256, 'hex'), Buffer.from(capabilityDigest(capability), 'hex'))
}

export async function readUploadReceipt(request: Request): Promise<LocalSourceUploadReceipt> {
	if (request.body === null) throw new Error('empty upload')
	const reader = request.body.getReader()
	const hash = createHash('sha256')
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
		}
		if (compressedBytes === 0) throw new Error('empty upload')
		return { compressedBytes, compressedSha256: hash.digest('hex') }
	} catch {
		void reader.cancel().catch(() => {})
		throw new Error('incomplete local source upload')
	} finally {
		request.signal.removeEventListener('abort', abort)
		reader.releaseLock()
	}
}
