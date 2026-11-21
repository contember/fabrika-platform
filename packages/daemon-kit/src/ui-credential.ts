import { randomBytes, randomUUID } from 'crypto'
import { readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { matchesCapability } from './capability'
import { ensureRuntimeDir } from './runtime-dir'

/**
 * A daemon's browser UI credential: a secret the browser holds as a cookie, made fresh by every daemon start (the daemon
 * makes it with `createCapability` and keeps it in memory). It reaches a browser only through a one-time code on a link
 * the CLI hands out, and the CLI hands a browser that link through a file only its owner reads, never through a process
 * argument.
 */

/** The path of a link that bootstraps the cookie, and its query parameter. */
export const UI_LINK_PATH = '/open'
const UI_CODE_QUERY = 'code'

/** A link the CLI printed stays usable for as long as the CLI waits for feedback by default. */
const CODE_TTL_MS = 60 * 60 * 1000
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

/** The secret a daemon's UI cookie carries, and the cookie's name. */
export interface UiCredential {
	cookieName: string
	token: string
}

/** Cookies are not separated by port on a loopback host, so each daemon port names its own. */
export function uiCookieName(prefix: string, port: number): string {
	return `${prefix}${port}`
}

/** The value of cookie `name` in a `Cookie` header, or null. */
function cookieValue(header: string | null, name: string): string | null {
	if (header === null) return null
	for (const pair of header.split(';')) {
		const separator = pair.indexOf('=')
		if (separator !== -1 && pair.slice(0, separator).trim() === name) return pair.slice(separator + 1).trim()
	}
	return null
}

/** The `Cookie` header without any cookie whose name starts with `prefix`, or null when nothing else is left. */
export function withoutCookies(header: string | null, prefix: string): string | null {
	if (header === null) return null
	const kept = header.split(';').map((pair) => pair.trim()).filter((pair) => pair !== '' && !pair.startsWith(prefix))
	return kept.length === 0 ? null : kept.join('; ')
}

function uiCookieHeader(credential: UiCredential): string {
	return `${credential.cookieName}=${credential.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}`
}

/** Whether the request carries the daemon's UI cookie with its secret, compared in constant time. */
export function hasUiCookie(req: Request, credential: UiCredential): boolean {
	return matchesCapability(cookieValue(req.headers.get('Cookie'), credential.cookieName), credential.token)
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

	/**
	 * `origin` gives the daemon's own origin, the one its UI is served from, so the cookie is set for that host; a daemon
	 * bound to port 0 knows it only once it listens.
	 */
	constructor(private readonly origin: () => string, private readonly now: () => number = Date.now) {}

	/** A link that sets the cookie once and then leads to `destination`: a path on the daemon or a URL it chose. */
	issue(destination: string | null): string {
		const now = this.now()
		for (const [code, entry] of this.codes) if (entry.expiresAt <= now) this.codes.delete(code)
		const code = randomBytes(24).toString('base64url')
		this.codes.set(code, { expiresAt: now + CODE_TTL_MS, destination, spent: false })
		return `${this.origin()}${UI_LINK_PATH}?${UI_CODE_QUERY}=${code}`
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

export function escapeHtml(text: string): string {
	return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

const PAGE_STYLE = '<style>body{font:15px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#1f2328}'
	+ 'code{background:#f0f1f3;padding:.15rem .35rem;border-radius:4px}</style>'

/** A static page of the daemon's own (a link, the sign-in it asks for): no script, no referrer, not cached, not framed. */
export function uiPage(title: string, body: string, init: { status: number; head?: string; headers?: Record<string, string> }): Response {
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

/** The pages a link route answers with that name the daemon: the sign-in a browser needs, and a link with no destination. */
export interface UiLinkPages {
	/** The daemon's name, the title of the page that leads on. */
	title: string
	/** Answers a browser without the cookie: how to get a fresh link. */
	linkRequired(): Response
	/** Answers a link without a destination, with the cookie when the code was unspent. */
	signedIn(headers: Record<string, string>): Response
}

/**
 * The answer to a link: the cookie (on its first use) and a refresh to the link's destination. A refresh is a navigation
 * the daemon's own page starts, so the browser sends the `SameSite=Strict` cookie on it; a redirect would keep the site
 * of whatever opened the link (a local file, another application) and arrive without it. A spent code still leads a
 * browser that holds the cookie on, so the code stays out of the destination's history entry.
 */
export function openLinkResponse(req: Request, url: URL, credential: UiCredential, links: UiLinks, pages: UiLinkPages): Response {
	const code = url.searchParams.get(UI_CODE_QUERY)
	const link = code === null ? null : links.redeem(code)
	if (link === null) return pages.linkRequired()
	let headers: Record<string, string>
	if (link.fresh) headers = { 'Set-Cookie': uiCookieHeader(credential) }
	else if (hasUiCookie(req, credential)) headers = {}
	else return pages.linkRequired()
	if (link.destination === null) return pages.signedIn(headers)
	const target = escapeHtml(link.destination)
	return uiPage(pages.title, `<p><a href="${target}">Continue</a></p>`, {
		status: 200,
		head: `<meta http-equiv="refresh" content="0;url=${target}">`,
		headers,
	})
}

const LINK_FILE = /^open-[0-9a-f-]+\.html$/
/** Long enough for a browser to start and read the file; a later `openLinkThroughFile` removes it. */
const LINK_FILE_TTL_MS = 60_000

function removeStaleLinkFiles(directory: string, now: number): void {
	for (const name of readdirSync(directory)) {
		if (!LINK_FILE.test(name)) continue
		const file = join(directory, name)
		try {
			if (now - statSync(file).mtimeMs > LINK_FILE_TTL_MS) rmSync(file, { force: true })
		} catch {
			// Removed meanwhile by another CLI.
		}
	}
}

/**
 * Opens a link that carries a secret (a one-time sign-in code) in the browser. Never as a process argument: other OS
 * users read every process's arguments. The link goes into a file only its owner reads, in the CLI's runtime
 * `directory` (`ensureRuntimeDir`), and `openUrl` gets that file's URL, which refreshes to the link.
 */
export function openLinkThroughFile(link: string, directory: string, title: string, openUrl: (url: string) => void): void {
	ensureRuntimeDir(directory)
	removeStaleLinkFiles(directory, Date.now())
	const target = escapeHtml(link)
	const file = join(directory, `open-${randomUUID()}.html`)
	writeFileSync(
		file,
		`<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${target}"><title>${
			escapeHtml(title)
		}</title><a href="${target}">Continue</a>\n`,
		{ mode: 0o600, flag: 'wx' },
	)
	openUrl(pathToFileURL(file).href)
}
