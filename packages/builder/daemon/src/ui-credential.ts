import { openLinkResponse, type Route, UI_LINK_PATH, type UiCredential, type UiLinkPages, type UiLinks, uiPage } from '@fabrika/daemon-kit'

/** The dashboard's cookie, `fabrika-builder-ui-<port>`: a browser sends one loopback host's cookies to every port of it. */
export const BUILDER_UI_COOKIE_PREFIX = 'fabrika-builder-ui-'

/** The command that prints a fresh sign-in link; the pages that ask for one name it. */
export const DASHBOARD_COMMAND = 'fabrika builder dashboard'

/** What a browser without the cookie gets instead of the dashboard: the command that prints a fresh link. */
export function linkRequiredResponse(): Response {
	return uiPage(
		'Fabrika builder: open the dashboard from its link',
		`<h1>Open the builder dashboard from its link</h1>
<p>The dashboard opens only through a link the <code>fabrika builder</code> CLI prints or opens, and each link signs in one browser. To get a fresh one, run this in the project's directory and open the link it prints:</p>
<p><code>${DASHBOARD_COMMAND} --no-open</code></p>`,
		{ status: 401 },
	)
}

const LINK_PAGES: UiLinkPages = {
	title: 'Fabrika builder',
	linkRequired: linkRequiredResponse,
	// The builder issues links to a dashboard page only; one without a destination still signs the browser in.
	signedIn: (headers) => uiPage('Fabrika builder: signed in', '<h1>This browser is signed in to the builder dashboard</h1>', { status: 200, headers }),
}

/** The link route: a link's code sets the cookie once and leads on to the dashboard page the daemon chose for it. */
export function createLinkRoute(credential: () => UiCredential, links: UiLinks): Route {
	return {
		method: 'GET',
		pattern: new URLPattern({ pathname: UI_LINK_PATH }),
		handler: (req, url) => openLinkResponse(req, url, credential(), links, LINK_PAGES),
	}
}
