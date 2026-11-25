// The one way the framework adds to an SPA's document: tags right after `<head>`, before anything the document loads.

/**
 * The HTML answer with `tags` right after its `<head>` (at the very start when it has none). A response that is not
 * HTML passes unchanged.
 */
export async function injectIntoHead(response: Response, tags: string): Promise<Response> {
	const type = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase()
	if (type !== 'text/html') {
		return response
	}
	const html = await response.text()
	const head = /<head(?:\s[^>]*)?>/i.exec(html)
	const injected = head === null ? `${tags}${html}` : `${html.slice(0, head.index + head[0].length)}${tags}${html.slice(head.index + head[0].length)}`
	const headers = new Headers(response.headers)
	headers.delete('Content-Length')
	return new Response(injected, { status: response.status, statusText: response.statusText, headers })
}
