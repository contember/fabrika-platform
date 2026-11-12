import type { GitHubSourceOwnerType } from '@fabrika/control-contract'
import { PAGE_STYLE, pageBody } from '@fabrika/proxy-core/page-style'

/** `console`: the administrator's own browser. `handoff`: the GitHub account's owner, who opened a handoff link. */
export type ManifestHandoffMode = 'console' | 'handoff'

/** What the manifest handoff page needs; every value is escaped where it is written. */
export interface ManifestHandoffPage {
	/** GitHub's App-creation URL for the owner, carrying the one-use state. */
	readonly action: string
	readonly manifest: string
	readonly owner: string
	readonly ownerType: GitHubSourceOwnerType
	readonly appName: string
	/** Admits this page's one style element and, for an organization, its one script element, and nothing else. */
	readonly nonce: string
	readonly mode: ManifestHandoffMode
}

export function manifestHandoffCsp(nonce: string): string {
	return [
		"default-src 'none'",
		`style-src 'nonce-${nonce}'`,
		`script-src 'nonce-${nonce}'`,
		'form-action https://github.com',
		"base-uri 'none'",
		"frame-ancestors 'none'",
	].join('; ')
}

/**
 * The page posts an organization's manifest to GitHub by itself. It does not when the browser came back to it through
 * history, so the back button from GitHub stays on this page instead of bouncing forward again. A personal account's
 * page waits for the click: GitHub creates that App on whichever account is signed in, so the person reads which
 * account to be signed in as before anything reaches GitHub.
 */
export function manifestHandoffHtml(page: ManifestHandoffPage): string {
	const owner = html(page.owner)
	const personal = page.ownerType === 'User'
	const where = personal
		? `on the personal account <strong>${owner}</strong>. GitHub creates it on the account you are signed in as, so sign in to GitHub as ${owner} first`
		: `in the <strong>${owner}</strong> organization`
	const button = personal ? `Continue to GitHub as ${owner}` : 'Continue to GitHub'
	const script = personal ? '' : `<script nonce="${html(page.nonce)}">${AUTO_SUBMIT}</script>
`
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Connect GitHub</title>
<style nonce="${html(page.nonce)}">${HANDOFF_STYLE}</style>
</head>
<body>
${
		pageBody(
			`<p class="eyebrow">Source connection</p>
<h1>Create the GitHub App</h1>
<p>Fabrika asks GitHub to create the private App <strong>${html(page.appName)}</strong> ${where}.</p>
<ol class="steps">
<li class="current"><strong>Create the App.</strong> GitHub shows its settings. Confirm them with <em>Create GitHub App</em>.</li>
<li><strong>Install it on ${owner}.</strong> GitHub opens the installation next. Choose the repositories and confirm.</li>
${
				page.mode === 'console'
					? '<li><strong>Return to the console.</strong> Fabrika verifies the installation and shows the connection.</li>'
					: '<li><strong>Done.</strong> Fabrika verifies the installation, and your administrator sees the connection in the console.</li>'
			}
</ol>
<form id="handoff" method="post" action="${html(page.action)}">
<input type="hidden" name="manifest" value="${html(page.manifest)}">
<button type="submit">${button}</button>
</form>`,
			{ runsOn: 'Runs on' },
		)
	}
${script}</body>
</html>`
}

export function handoffOpeningCsp(nonce: string): string {
	return [
		"default-src 'none'",
		`style-src 'nonce-${nonce}'`,
		`script-src 'nonce-${nonce}'`,
		"form-action 'self'",
		"base-uri 'none'",
		"frame-ancestors 'none'",
	].join('; ')
}

/**
 * The page a handoff link opens. The token is in the fragment, which the browser never sends, so it reaches no request
 * log; the script takes it out of the address bar and posts it to this same URL, which answers the manifest page.
 */
export function handoffOpeningHtml(nonce: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Connect GitHub</title>
<style nonce="${html(nonce)}">${PAGE_STYLE}</style>
</head>
<body>
${
		pageBody(
			`<p class="eyebrow">Source connection</p>
<h1>Opening the GitHub setup</h1>
<p id="message">Your administrator sent you this link to connect a GitHub organization. If nothing happens, open the link again exactly as you received it.</p>
<form id="open" method="post">
<input type="hidden" name="token">
<button type="submit" hidden>Continue</button>
</form>`,
			{ runsOn: 'Runs on' },
		)
	}
<script nonce="${html(nonce)}">${OPEN_FROM_FRAGMENT}</script>
</body>
</html>`
}

const OPEN_FROM_FRAGMENT = `
(function () {
	var token = location.hash.slice(1);
	history.replaceState(null, '', location.pathname);
	if (!token) {
		document.getElementById('message').textContent = 'This link is incomplete. Open it again exactly as your administrator sent it, or ask them for a new one.';
		return;
	}
	var form = document.getElementById('open');
	form.elements.token.value = token;
	form.submit();
})();
`

/** A result page has no script and only its one style element. */
export function handoffResultCsp(nonce: string): string {
	return ["default-src 'none'", `style-src 'nonce-${nonce}'`, "base-uri 'none'", "frame-ancestors 'none'"].join('; ')
}

export type HandoffOutcome = 'connected' | 'approval-requested' | 'unverified' | 'setup-incomplete'

const OUTCOMES: Readonly<Record<HandoffOutcome, { readonly title: string; readonly body: string }>> = {
	'connected': {
		title: 'GitHub is connected',
		body: 'Fabrika verified the installation. Your administrator now sees the connection in the console. You can close this page.',
	},
	'approval-requested': {
		title: 'Waiting for approval',
		body:
			'GitHub asked an owner of the organization to approve the installation. Once it is approved, your administrator verifies it from the console.',
	},
	'unverified': {
		title: 'The installation is not verified yet',
		body:
			'Fabrika could not confirm the installation on GitHub. Check that the App is installed on the organization, then ask your administrator to verify it from the console.',
	},
	'setup-incomplete': {
		title: 'The App needs your administrator',
		body:
			'GitHub created the App, but Fabrika could not finish setting it up. Tell your administrator: they can repair the connection from the console.',
	},
}

/** What a handoff route shows the account's owner, who has no console to be sent back to. */
export function handoffResultHtml(outcome: HandoffOutcome, nonce: string): string {
	const { title, body } = OUTCOMES[outcome]
	return ownerPage(title, body, nonce)
}

const LINK_SPENT = {
	title: 'This link is not valid any more',
	body: 'It expired, a newer link replaced it, it was already used, or the setup was cancelled. Ask your administrator for a new link.',
}

/**
 * A refusal as the owner reads it: by its status, never the workflow's own message, which speaks to an administrator
 * ("connect again") about a console the owner does not have.
 */
export function handoffRefusalHtml(status: number, nonce: string): string {
	if (status === 400) {
		return ownerPage(
			'This address is incomplete',
			'Open the link again exactly as your administrator sent it. If GitHub sent you here, ask your administrator to verify the installation from the console.',
			nonce,
		)
	}
	if (status === 404 || status === 409) return ownerPage(LINK_SPENT.title, LINK_SPENT.body, nonce)
	if (status === 422) {
		return ownerPage(
			'GitHub created the App on another account',
			'The App must belong to the account your administrator named. Delete it in your GitHub developer settings, sign in to GitHub as that account (for an organization, as one of its owners), and ask your administrator for a new link.',
			nonce,
		)
	}
	return ownerPage(
		'This step did not finish',
		'Fabrika could not complete it. Tell your administrator: they see the setup in the console and can repair it or start again.',
		nonce,
	)
}

function ownerPage(title: string, body: string, nonce: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${html(title)}</title>
<style nonce="${html(nonce)}">${PAGE_STYLE}</style>
</head>
<body>
${pageBody(`<p class="eyebrow">Source connection</p>\n<h1>${html(title)}</h1>\n<p>${html(body)}</p>`, { runsOn: 'Runs on' })}
</body>
</html>`
}

function html(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

const AUTO_SUBMIT = `
(function () {
	var navigation = performance.getEntriesByType('navigation')[0];
	if (navigation && navigation.type === 'back_forward') return;
	var form = document.getElementById('handoff');
	form.querySelector('button').textContent = 'Opening GitHub…';
	form.submit();
})();
`

// The shared stylesheet of fabrika's own pages, so the handoff reads as part of the console, plus its numbered steps.
// The shared `li` rules are for a bordered list, so the steps reset them.
const HANDOFF_STYLE = `${PAGE_STYLE}
.steps {
	margin: 0 0 1.75rem;
	padding: 0;
	list-style: none;
	counter-reset: step;
}

.steps li {
	position: relative;
	margin: 0 0 0.75rem;
	padding: 0.125rem 0 0 2.5rem;
	border: 0;
	color: var(--ink-2);
	counter-increment: step;
}

.steps li::before {
	content: counter(step);
	position: absolute;
	top: 0;
	left: 0;
	display: grid;
	place-items: center;
	width: 1.75rem;
	height: 1.75rem;
	border: 1px solid var(--rule);
	border-radius: 50%;
	font-size: 0.8125rem;
	font-weight: 600;
}

.steps li.current::before {
	background: var(--brand);
	border-color: var(--brand);
	color: var(--brand-on);
}

form {
	margin: 0;
}
`
