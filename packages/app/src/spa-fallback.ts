// Which request an SPA mount answers with its `index.html` when it names no file: a route of the page, not a missing
// asset. Both asset servers apply it (`diskAssets`, `bindingAssets`), so a missing script stays a 404 and never arrives
// as an HTML page with a 200.

import { rawRequestTarget } from '@fabrika/auth-core'

/** A GET or HEAD whose last path segment has no extension, or one that asks for HTML (a navigation to `/notes/v1.2`). */
export function isPageRoute(request: Request): boolean {
	if (request.method !== 'GET' && request.method !== 'HEAD') return false
	const last = rawRequestTarget(request.url).pathname.split('/').pop() ?? ''
	return !last.includes('.') || (request.headers.get('Accept') ?? '').includes('text/html')
}
