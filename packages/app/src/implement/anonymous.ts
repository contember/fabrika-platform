// What the anonymous kinds need beyond the request pipeline: a body read under its limit (the proxy never sees a
// body, so the framework enforces it) and the share SPA's fragment bootstrap. A form's admission is
// `form-admission.ts`, a webhook's signature `verifiers.ts`.

import { bodyDeadlineMs, LINK_BOOTSTRAP_FILE, SHARE_KEY_GLOBAL } from '../contract/defaults'
import { HttpError } from '../errors'
import { deadline, readBoundedBytes } from './bounded'

/**
 * The body as bytes, read until `maxBytes`; a longer one stops the read and is a 413. A body whose stream fails before
 * its end (the client closed the connection) is the sender's 400 `aborted`, never a failure of the application.
 */
export async function readBoundedBody(request: Request, maxBytes: number, deadline?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
	let body: Uint8Array<ArrayBuffer> | null
	try {
		body = await readBoundedBytes(request.body, {
			maxBytes,
			declaredLength: request.headers.get('Content-Length'),
			...(deadline === undefined ? {} : { signal: deadline }),
		})
	} catch {
		throw deadline?.aborted === true ? new HttpError(408, 'body_timeout', 'The body did not arrive within its deadline') : abortedBody()
	}
	if (body === null) {
		throw new HttpError(413, 'too_large', `The body is larger than ${maxBytes} bytes`)
	}
	return body
}

/** `readBoundedBody` within the deadline `maxBytes` derives; the deadline ends with the read. */
export async function readBodyInTime(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
	const timer = deadline(bodyDeadlineMs(maxBytes))
	try {
		return await readBoundedBody(request, maxBytes, timer.signal)
	} finally {
		timer.clear()
	}
}

/** What a request answers whose body did not arrive whole: nobody reads it, and no failure is reported. */
export function abortedBody(): HttpError {
	return new HttpError(400, 'aborted', 'The body could not be read to its end')
}

/**
 * Runs before any other script of the share SPA: it takes the key out of the fragment, removes the fragment from the
 * address with `history.replaceState`, and keeps the key in a closure. Telemetry that reads `location` later finds
 * no key; the SPA reads it through `shareKey()` of `@fabrika/app/client`.
 */
export const LINK_BOOTSTRAP_SCRIPT = `(function () {
	var fragment = window.location.hash.slice(1)
	var key = /^px_[A-Za-z0-9_-]+$/.test(fragment) ? fragment : null
	if (window.location.hash !== '') {
		window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
	}
	Object.defineProperty(window, '${SHARE_KEY_GLOBAL}', {
		value: function () {
			return key
		},
		writable: false,
		configurable: false,
		enumerable: false,
	})
})()
`

/** The share SPA's bootstrap path under the link prefix. */
export function bootstrapPath(prefix: string): string {
	return `${prefix}/${LINK_BOOTSTRAP_FILE}`
}

export function bootstrapResponse(): Response {
	return new Response(LINK_BOOTSTRAP_SCRIPT, { status: 200, headers: { 'Content-Type': 'text/javascript; charset=utf-8' } })
}

/**
 * The share SPA's document with the bootstrap as its first script: right after `<head>`, so it runs before every
 * module script and every script the document loads. A response that is not HTML passes unchanged.
 */
export async function withBootstrap(response: Response, prefix: string): Promise<Response> {
	const type = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase()
	if (type !== 'text/html') {
		return response
	}
	const html = await response.text()
	const tag = `<script src="${bootstrapPath(prefix)}"></script>`
	const head = /<head(?:\s[^>]*)?>/i.exec(html)
	const injected = head === null ? `${tag}${html}` : `${html.slice(0, head.index + head[0].length)}${tag}${html.slice(head.index + head[0].length)}`
	const headers = new Headers(response.headers)
	headers.delete('Content-Length')
	return new Response(injected, { status: response.status, statusText: response.statusText, headers })
}
