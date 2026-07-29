const REQUEST_ID_HEADER = 'X-Request-Id'
const CLOUDFLARE_REQUEST_ID_HEADER = 'cf-ray'

function headerValue(headers: Headers, name: string): string | null {
	const value = headers.get(name)
	return value === null || value === '' ? null : value
}

/** Prefer the proxy correlation id, then Cloudflare's ray id, then generate one. */
export function requestId(request: Request, generate: () => string = () => crypto.randomUUID()): string {
	return headerValue(request.headers, REQUEST_ID_HEADER) ?? headerValue(request.headers, CLOUDFLARE_REQUEST_ID_HEADER) ?? generate()
}
