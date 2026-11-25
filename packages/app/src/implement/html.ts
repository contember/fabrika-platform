// The one way the framework adds to an SPA's document: tags at the start of its head, before anything the document
// loads, and never before its DOCTYPE.

/** U+FEFF, the byte order mark a document may start with; kept as a code so no source file holds the invisible character. */
const BYTE_ORDER_MARK = 0xfeff

/**
 * What a document may hold before its head's content, after an optional byte order mark: whitespace and comments, the
 * DOCTYPE, the `<html>` start tag and the `<head>` start tag, each optional (HTML lets a document omit both tags). Read
 * only at the document's start, so a `<head>` written later (in a script, in the body's text) is never taken for the
 * head.
 */
const PROLOGUE =
	/^(?:\s|<!--[\s\S]*?-->)*(?:<!doctype[^>]*>)?(?:\s|<!--[\s\S]*?-->)*(?:<html(?:\s[^>]*)?>)?(?:\s|<!--[\s\S]*?-->)*(?:<head(?:\s[^>]*)?>)?/i

/**
 * Where `tags` go in `html`: right after the `<head>` start tag, or, where the document omits it, after its DOCTYPE and
 * `<html>` start tag, where the parser opens the head itself. Before a DOCTYPE they would put the page in quirks mode.
 */
export function headInsertionPoint(html: string): number {
	const start = html.charCodeAt(0) === BYTE_ORDER_MARK ? 1 : 0
	return start + (PROLOGUE.exec(html.slice(start))?.[0].length ?? 0)
}

/** The HTML answer with `tags` at the start of its head (`headInsertionPoint`). A response that is not HTML passes unchanged. */
export async function injectIntoHead(response: Response, tags: string): Promise<Response> {
	const type = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase()
	if (type !== 'text/html') {
		return response
	}
	const html = await response.text()
	const at = headInsertionPoint(html)
	const headers = new Headers(response.headers)
	headers.delete('Content-Length')
	return new Response(`${html.slice(0, at)}${tags}${html.slice(at)}`, { status: response.status, statusText: response.statusText, headers })
}
