/** JSON response helpers for the control-plane API. */
export function json(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: { 'content-type': 'application/json; charset=utf-8', ...init?.headers },
	})
}

/** A structured JSON error with an HTTP status. `extra` merges extra fields into the body (e.g. a
 * `loginUrl` on a 401 so the dashboard can bounce the browser to IAM's SSO login). */
export function error(status: number, message: string, extra?: Record<string, unknown>): Response {
	return json({ error: message, ...extra }, { status })
}

/** The bearer of an `Authorization: Bearer …` header, or `null`. */
export function bearerOf(request: Request): string | null {
	const match = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '')
	return match?.[1] ?? null
}

/** The body as UTF-8 text, or `null` when it is larger than `maxBytes`, unreadable or not UTF-8. */
export async function readBoundedText(request: Request, maxBytes: number): Promise<string | null> {
	const declared = Number(request.headers.get('content-length') ?? '')
	if (Number.isFinite(declared) && declared > maxBytes) {
		await request.body?.cancel().catch(() => {})
		return null
	}
	if (request.body === null) return ''
	const reader = request.body.getReader()
	const chunks: Uint8Array[] = []
	let size = 0
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			size += value.byteLength
			if (size > maxBytes) {
				await reader.cancel().catch(() => {})
				return null
			}
			chunks.push(value)
		}
	} catch {
		return null
	}
	const bytes = new Uint8Array(size)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
	} catch {
		return null
	}
}
