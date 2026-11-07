export type BoundedBody = { ok: true; text: string } | { ok: false; reason: 'too_large' | 'unreadable' }

/**
 * A public route's request body as text, never more than `maxBytes` of it: a declared `Content-Length` over the cap is
 * refused before reading, and a stream is cancelled at the first chunk past it. An absent body is the empty text.
 */
export async function readBoundedText(request: Request, maxBytes: number): Promise<BoundedBody> {
	const declared = Number(request.headers.get('Content-Length') ?? '0')
	if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: 'too_large' }
	if (request.body === null) return { ok: true, text: '' }
	const reader = request.body.getReader()
	const decoder = new TextDecoder()
	let text = ''
	let bytes = 0
	try {
		while (true) {
			const chunk = await reader.read()
			if (chunk.done) break
			bytes += chunk.value.byteLength
			if (bytes > maxBytes) {
				await reader.cancel()
				return { ok: false, reason: 'too_large' }
			}
			text += decoder.decode(chunk.value, { stream: true })
		}
		return { ok: true, text: text + decoder.decode() }
	} catch {
		return { ok: false, reason: 'unreadable' }
	} finally {
		reader.releaseLock()
	}
}
