import { randomBytes } from 'crypto'
import { chmodSync, readFileSync, writeFileSync } from 'fs'

/**
 * The browser UI's credential: a per-daemon secret the browser holds as a cookie. It reaches a browser only through a
 * one-time code on a link the CLI hands out, so a local client that can reach the port but cannot read the owner's files
 * gets neither.
 */

/** The query parameter of a link that bootstraps the cookie. */
export const UI_CODE_QUERY = 'code'

/** Every daemon's cookie name starts with it; the review proxy withholds them from the application it forwards to. */
export const UI_COOKIE_PREFIX = 'agent-canvas-ui-'

/** A link the CLI printed stays usable for as long as the CLI waits for feedback by default. */
const CODE_TTL_MS = 60 * 60 * 1000
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

/** Cookies are not separated by port on localhost, so each daemon port names its own. */
export function uiCookieName(port: number): string {
	return `${UI_COOKIE_PREFIX}${port}`
}

/**
 * The UI secret kept in `file`, created on first use. It survives a daemon restart, which the CLI does on a version
 * change or a failed compile, so open tabs keep working; deleting the file revokes every browser.
 */
export function loadUiToken(file: string): string {
	let token: string | undefined
	try {
		token = readFileSync(file, 'utf-8').trim()
	} catch {
		token = undefined
	}
	if (token === undefined || !TOKEN_PATTERN.test(token)) {
		token = randomBytes(32).toString('base64url')
		writeFileSync(file, token, { mode: 0o600 })
	}
	chmodSync(file, 0o600)
	return token
}

/** The value of cookie `name` in a `Cookie` header, or null. */
export function cookieValue(header: string | null, name: string): string | null {
	if (header === null) return null
	for (const pair of header.split(';')) {
		const separator = pair.indexOf('=')
		if (separator !== -1 && pair.slice(0, separator).trim() === name) return pair.slice(separator + 1).trim()
	}
	return null
}

/** The `Cookie` header without any daemon's UI cookie, or null when nothing else is left. */
export function withoutUiCookies(header: string | null): string | null {
	if (header === null) return null
	const kept = header.split(';').map((pair) => pair.trim()).filter((pair) => pair !== '' && !pair.startsWith(UI_COOKIE_PREFIX))
	return kept.length === 0 ? null : kept.join('; ')
}

export function uiCookieHeader(port: number, token: string): string {
	return `${uiCookieName(port)}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}`
}

/** One-time codes for links that bootstrap the cookie. Held in memory: a restarted daemon honours no earlier link. */
export class UiLinks {
	private readonly codes = new Map<string, number>()

	constructor(private readonly port: number, private readonly now: () => number = Date.now) {}

	/** A link to the session's page that sets the cookie once. */
	issue(sessionId: string): string {
		const now = this.now()
		for (const [code, expiresAt] of this.codes) if (expiresAt <= now) this.codes.delete(code)
		const code = randomBytes(24).toString('base64url')
		this.codes.set(code, now + CODE_TTL_MS)
		return `http://localhost:${this.port}/s/${encodeURIComponent(sessionId)}?${UI_CODE_QUERY}=${code}`
	}

	/** Whether `code` is an unexpired code this daemon issued; it is spent either way. */
	redeem(code: string): boolean {
		const expiresAt = this.codes.get(code)
		this.codes.delete(code)
		return expiresAt !== undefined && expiresAt > this.now()
	}
}

function escapeHtml(text: string): string {
	return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

/** What a browser without the cookie gets instead of a page: the command that prints a fresh link. */
export function linkRequiredResponse(sessionId: string | null): Response {
	const command = sessionId === null ? 'agent-canvas open --session <session-id>' : `agent-canvas open --session ${sessionId}`
	const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>agent-canvas: open the canvas from its link</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#1f2328}code{background:#f0f1f3;padding:.15rem .35rem;border-radius:4px}</style>
</head>
<body>
<h1>Open this canvas from its link</h1>
<p>The canvas opens only through a link the <code>agent-canvas</code> CLI prints, and each link works once. To get a fresh one, run this in the project's terminal and open the link it prints:</p>
<p><code>${escapeHtml(command)}</code></p>
</body>
</html>
`
	return new Response(html, {
		status: 401,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store',
			'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; sandbox",
		},
	})
}
