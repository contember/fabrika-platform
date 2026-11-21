import { randomBytes } from 'crypto'
import { chmodSync, readFileSync, writeFileSync } from 'fs'

/**
 * The browser UI's credential: a per-daemon secret the browser holds as a cookie. It reaches a browser only through a
 * one-time code on a link the CLI hands out, and the CLI hands a browser that link through a file only its owner reads,
 * never through a process argument.
 */

/** The path of a link that bootstraps the cookie, and its query parameter. */
export const UI_LINK_PATH = '/open'
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

function readToken(file: string): string | undefined {
	try {
		const token = readFileSync(file, 'utf-8').trim()
		return TOKEN_PATTERN.test(token) ? token : undefined
	} catch {
		return undefined
	}
}

function isAlreadyExists(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

/**
 * The UI secret kept in `file`, created on first use. It survives a daemon restart, which the CLI does on a version
 * change or a failed compile, so open tabs keep working; deleting the file revokes every browser. Daemons on other ports
 * share the file, so a first start creates it exclusively and takes the one another daemon wrote first.
 */
export function loadUiToken(file: string): string {
	let token = readToken(file)
	if (token === undefined) {
		const fresh = randomBytes(32).toString('base64url')
		try {
			writeFileSync(file, fresh, { mode: 0o600, flag: 'wx' })
			token = fresh
		} catch (error) {
			if (!isAlreadyExists(error)) throw error
			token = readToken(file)
			// A file that holds no token (empty, or edited by hand) is replaced.
			if (token === undefined) {
				writeFileSync(file, fresh, { mode: 0o600 })
				token = fresh
			}
		}
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

/** What redeeming a code gives: where its link leads (null: nowhere, the sign-in alone), and whether it was unspent. */
export interface RedeemedLink {
	destination: string | null
	fresh: boolean
}

/**
 * One-time codes for links that bootstrap the cookie, each with the destination the daemon chose for it, so a link is
 * never an open redirect. Held in memory: a restarted daemon honours no earlier link.
 */
export class UiLinks {
	private readonly codes = new Map<string, { expiresAt: number; destination: string | null; spent: boolean }>()

	constructor(private readonly port: number, private readonly now: () => number = Date.now) {}

	/** A link that sets the cookie once and then leads to `destination`: a path on the daemon or a review proxy URL. */
	issue(destination: string | null): string {
		const now = this.now()
		for (const [code, entry] of this.codes) if (entry.expiresAt <= now) this.codes.delete(code)
		const code = randomBytes(24).toString('base64url')
		this.codes.set(code, { expiresAt: now + CODE_TTL_MS, destination, spent: false })
		return `http://localhost:${this.port}${UI_LINK_PATH}?${UI_CODE_QUERY}=${code}`
	}

	/** The link of an unexpired code this daemon issued, or null; a code sets the cookie only the first time. */
	redeem(code: string): RedeemedLink | null {
		const entry = this.codes.get(code)
		if (entry === undefined || entry.expiresAt <= this.now()) return null
		const fresh = !entry.spent
		entry.spent = true
		return { destination: entry.destination, fresh }
	}
}

function escapeHtml(text: string): string {
	return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

const PAGE_STYLE = '<style>body{font:15px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#1f2328}'
	+ 'code{background:#f0f1f3;padding:.15rem .35rem;border-radius:4px}</style>'

function page(title: string, body: string, init: { status: number; head?: string; headers?: Record<string, string> }): Response {
	const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title>${init.head ?? ''}${PAGE_STYLE}</head>
<body>
${body}
</body>
</html>
`
	return new Response(html, {
		status: init.status,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store',
			'Referrer-Policy': 'no-referrer',
			// No `sandbox`: it would stop the link page's refresh. These pages run no script either way.
			'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
			...init.headers,
		},
	})
}

/**
 * The answer to a link: the cookie (on its first use) and a refresh to the link's destination. A refresh is a navigation
 * the daemon's own page starts, so the browser sends the `SameSite=Strict` cookie on it; a redirect would keep the site
 * of whatever opened the link (a local file, another application) and arrive without it.
 */
export function linkResponse(link: RedeemedLink, setCookie: string | null): Response {
	const headers: Record<string, string> = setCookie === null ? {} : { 'Set-Cookie': setCookie }
	if (link.destination === null) {
		return page('agent-canvas: signed in', '<h1>This browser is signed in to agent-canvas</h1>\n<p>Reload the application you review.</p>', {
			status: 200,
			headers,
		})
	}
	const target = escapeHtml(link.destination)
	return page('agent-canvas', `<p><a href="${target}">Continue</a></p>`, {
		status: 200,
		head: `<meta http-equiv="refresh" content="0;url=${target}">`,
		headers,
	})
}

/** What a browser without the cookie gets instead of a page: the command that prints a fresh link. */
export function linkRequiredResponse(sessionId: string | null): Response {
	const commands = sessionId === null
		? '<p><code>agent-canvas open --session &lt;session-id&gt;</code> for a canvas, or <code>agent-canvas review open &lt;url&gt;</code> for a review.</p>'
		: `<p><code>${escapeHtml(`agent-canvas open --session ${sessionId}`)}</code></p>`
	return page(
		'agent-canvas: open the canvas from its link',
		`<h1>Open this canvas from its link</h1>
<p>The canvas opens only through a link the <code>agent-canvas</code> CLI prints, and each link signs in one browser. To get a fresh one, run this in the project's terminal and open the link it prints:</p>
${commands}`,
		{ status: 401 },
	)
}
