// What the anonymous kinds need beyond the request pipeline: a body read under its limit (the proxy never sees a
// body, so the framework enforces it), the share SPA's fragment bootstrap and GitHub's delivery signature. A form's
// admission is `form-admission.ts`.

import { LINK_BOOTSTRAP_FILE, SHARE_KEY_GLOBAL } from '../contract/defaults'
import { HttpError } from '../errors'
import { readBoundedBytes } from './bounded'

/** The body as bytes, read until `maxBytes`; a longer one stops the read and is a 413. */
export async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
	const body = await readBoundedBytes(request.body, { maxBytes, declaredLength: request.headers.get('Content-Length') })
	if (body === null) {
		throw new HttpError(413, 'too_large', `The body is larger than ${maxBytes} bytes`)
	}
	return body
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

const SIGNATURE_PREFIX = 'sha256='
const HEX = /^[0-9a-f]{64}$/

/** Whether `X-Hub-Signature-256` is GitHub's HMAC-SHA256 of the raw body under `secret`, compared in constant time. */
export async function verifyGithubSignature(header: string | null, secret: string, body: Uint8Array<ArrayBuffer>): Promise<boolean> {
	if (header === null || !header.startsWith(SIGNATURE_PREFIX)) {
		return false
	}
	const hex = header.slice(SIGNATURE_PREFIX.length).toLowerCase()
	if (!HEX.test(hex)) {
		return false
	}
	const signature = new Uint8Array(32)
	for (let index = 0; index < 32; index++) {
		signature[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
	}
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
	return crypto.subtle.verify('HMAC', key, signature, body)
}

/** The GitHub account a payload names, as a binding records it: `installation:<id>` or `repository:<id>`. */
export function githubAccounts(payload: unknown): readonly string[] {
	const accounts: string[] = []
	for (const kind of ['installation', 'repository'] as const) {
		const holder = ownField(payload, kind)
		const id = ownField(holder, 'id')
		if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) {
			accounts.push(`${kind}:${id}`)
		}
	}
	return accounts
}

function ownField(value: unknown, name: string): unknown {
	return typeof value === 'object' && value !== null && Object.hasOwn(value, name) ? Reflect.get(value, name) : undefined
}
