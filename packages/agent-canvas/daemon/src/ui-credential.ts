import { escapeHtml, uiCookieName as cookieNameFor, type UiLinkPages, uiPage, withoutCookies } from '@fabrika/daemon-kit'

/**
 * The browser UI's credential, `@fabrika/daemon-kit`'s UI credential under agent-canvas' cookie name and pages. It
 * reaches a browser only through a one-time code on a link the CLI hands out.
 */

/** Every daemon's cookie name starts with it; the review proxy withholds them from the application it forwards to. */
export const UI_COOKIE_PREFIX = 'agent-canvas-ui-'

export function uiCookieName(port: number): string {
	return cookieNameFor(UI_COOKIE_PREFIX, port)
}

/** The `Cookie` header without any daemon's UI cookie, or null when nothing else is left. */
export function withoutUiCookies(header: string | null): string | null {
	return withoutCookies(header, UI_COOKIE_PREFIX)
}

/** What a browser without the cookie gets instead of a page: the command that prints a fresh link. */
export function linkRequiredResponse(sessionId: string | null): Response {
	const commands = sessionId === null
		? '<p><code>agent-canvas open --session &lt;session-id&gt;</code> for a canvas, or <code>agent-canvas review open &lt;url&gt;</code> for a review.</p>'
		: `<p><code>${escapeHtml(`agent-canvas open --session ${sessionId}`)}</code></p>`
	return uiPage(
		'agent-canvas: open the canvas from its link',
		`<h1>Open this canvas from its link</h1>
<p>The canvas opens only through a link the <code>agent-canvas</code> CLI prints, and each link signs in one browser. To get a fresh one, run this in the project's terminal and open the link it prints:</p>
${commands}`,
		{ status: 401 },
	)
}

/** The pages a link answers with: a review link has no destination and signs the browser in alone. */
export const LINK_PAGES: UiLinkPages = {
	title: 'agent-canvas',
	linkRequired: () => linkRequiredResponse(null),
	signedIn: (headers) =>
		uiPage('agent-canvas: signed in', '<h1>This browser is signed in to agent-canvas</h1>\n<p>Reload the application you review.</p>', {
			status: 200,
			headers,
		}),
}
