import type { InstallationBrand } from './brand'
import { PAGE_STYLE, pageBody } from './page-style'

/**
 * The pages a person reads when the proxy, not the application, answers their browser: a refusal, an unknown host, an
 * application that does not answer. Every enforcement point renders them from here, the auth service, the generated
 * Caddy configuration and the Cloudflare proxy Worker, so a refusal looks the same on both providers.
 *
 * A page is only for a top-level navigation (`isPageNavigation`). An XHR, a `fetch`, a key-carrying program or a client
 * that sends no `Sec-Fetch-Mode` gets the short text it always got, which is what each of them parses. The text of a
 * page is fixed per status and names no deny reason: the reasons stay coarse and stay in the log.
 *
 * They look like IAM's pages because they carry the same stylesheet and frame (`./page-style`). No script and no external
 * reference: a page is served on the application's own origin under its header policy, whose CSP admits inline styles
 * and nothing else that a page could load from elsewhere. A download endpoint's answers never get a page, because the
 * file treatment makes every one of them an attachment.
 */

/**
 * The browser's own description of what issued the request, written by the browser and not by the page: `Sec-` is a
 * forbidden header prefix, so a page's `fetch` cannot set it. Read from the FORWARDED headers like everything else a
 * decision depends on; caddy 2.10.2's `forward_auth` subrequest carries the original `Sec-Fetch-*` verbatim.
 */
export const FETCH_MODE_HEADER = 'Sec-Fetch-Mode'

/** The statuses the proxy answers on its own. */
export type ErrorPageStatus = 400 | 401 | 403 | 404 | 502 | 503 | 504

/** The console's refresh glyph (`packages/dashboard/src/components/Icon.tsx`), drawn as its `Icon` draws it. */
const REFRESH =
	`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20.4 12a8.4 8.4 0 1 1-2.6-6.05"/><path d="M20.4 3.85v4.3h-4.3"/></svg>`

/** A same-origin link under a page's text, drawn as the console's outlined button; an empty `href` reloads the page. */
export interface PageAction {
	readonly href: string
	readonly label: string
	/** Draws the console's refresh glyph before the label, as its Retry does. */
	readonly retry?: boolean
}

export interface PageContent {
	readonly title: string
	readonly detail: string
	readonly action?: PageAction
}

/**
 * Only an explicit `navigate`. Unlike the login bounce, an absent header is not read as a browser here: a client that
 * sends none (curl, a script, an old SDK) has always read the text, and a page instead of it helps nobody.
 */
export function isPageNavigation(headers: Headers): boolean {
	return headers.get(FETCH_MODE_HEADER) === 'navigate'
}

const START_PAGE: PageAction = { href: '/', label: 'Go to the start page' }
const TRY_AGAIN: PageAction = { href: '', label: 'Try again', retry: true }

const STATUS_PAGES: Record<ErrorPageStatus, PageContent> = {
	400: {
		title: 'This request could not be read',
		detail: 'The address or the request is malformed, so it was not passed on to the application.',
		action: START_PAGE,
	},
	401: {
		title: 'This page needs an access key',
		detail: 'This address answers programs that present a key. Opening it in a browser does not sign you in.',
		action: START_PAGE,
	},
	// The proxy also refuses a path the application does not serve with a 403, so the text cannot tell the two apart.
	403: {
		title: 'You cannot open this page',
		detail: 'The page does not exist, or your account has no access to it. If you expected to see it, ask whoever runs this application.',
		action: START_PAGE,
	},
	404: {
		title: 'Nothing is served here',
		detail: 'No application answers at this address. Check that it is spelled correctly.',
	},
	502: {
		title: 'The application is not responding',
		detail: 'It may be starting or restarting. Try again in a moment.',
		action: TRY_AGAIN,
	},
	503: {
		title: 'This page is unavailable for a moment',
		detail: 'A service it depends on could not be reached. Try again in a moment.',
		action: TRY_AGAIN,
	},
	504: {
		title: 'The application is not responding',
		detail: 'It did not answer in time. Try again in a moment.',
		action: TRY_AGAIN,
	},
}

export interface ErrorPageOptions {
	/**
	 * The code printed on the page, the status itself by default; the Caddy configuration passes
	 * `{http.error.status_code}`, a placeholder Caddy fills in for the status it answers with.
	 */
	readonly shownStatus?: string
	/** The installation's client logo (ADR-0066), from the manifest; the fabrika mark without one. */
	readonly brand?: InstallationBrand | null
}

/** The page of a status. */
export function errorPage(status: ErrorPageStatus, options: ErrorPageOptions = {}): string {
	return renderPage(STATUS_PAGES[status], options.shownStatus ?? String(status), options.brand ?? null)
}

/** The answer of a status: its page when `asPage`, `text` as plain text otherwise. The caller applies the header policy. */
export function errorAnswer(status: ErrorPageStatus, text: string, asPage: boolean, brand: InstallationBrand | null = null): Response {
	return asPage ? pageResponse(status, errorPage(status, { brand })) : textAnswer(status, text)
}

/** A rendered page as an answer; the caller applies the header policy. */
export function pageResponse(status: number, body: string): Response {
	return new Response(body, { status, headers: { 'content-type': PAGE_CONTENT_TYPE, 'cache-control': 'no-store' } })
}

export const PAGE_CONTENT_TYPE = 'text/html; charset=utf-8'

function textAnswer(status: number, body: string): Response {
	return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
}

/**
 * The page in the shared stylesheet and frame (`./page-style`): a heading, one sentence and an outlined button in the
 * panel, the status in the footer for whoever reports it. Every string that reaches the markup is a constant of this
 * module or a status code; nothing of the request is printed, so nothing is escaped.
 */
export function renderPage(content: PageContent, shownStatus: string, brand: InstallationBrand | null = null): string {
	const action = content.action === undefined
		? ''
		: `\n<a class="button" href="${content.action.href}">${content.action.retry === true ? REFRESH : ''}${content.action.label}</a>`
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${content.title}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
${pageBody(`<h1>${content.title}</h1>\n<p>${content.detail}</p>${action}`, { runsOn: 'Runs on', status: `Status ${shownStatus}` }, brand)}
</body>
</html>
`
}
