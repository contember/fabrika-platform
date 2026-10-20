import { PAGE_STYLE, pageBody } from '@fabrika/proxy-core/page-style'

/** What the manifest handoff page needs; every value is escaped where it is written. */
export interface ManifestHandoffPage {
	/** GitHub's App-creation URL for the organization, carrying the one-use state. */
	readonly action: string
	readonly manifest: string
	readonly organization: string
	readonly appName: string
	/** Admits this page's one style and one script element, and nothing else. */
	readonly nonce: string
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
 * The page posts the manifest to GitHub by itself. It does not when the browser came back to it through history,
 * so the back button from GitHub stays on this page instead of bouncing forward again.
 */
export function manifestHandoffHtml(page: ManifestHandoffPage): string {
	const organization = html(page.organization)
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
<p>Fabrika asks GitHub to create the private App <strong>${html(page.appName)}</strong> in the <strong>${organization}</strong> organization.</p>
<ol class="steps">
<li class="current"><strong>Create the App.</strong> GitHub shows its settings. Confirm them with <em>Create GitHub App</em>.</li>
<li><strong>Install it on ${organization}.</strong> GitHub opens the installation next. Choose the repositories and confirm.</li>
<li><strong>Return to the console.</strong> Fabrika verifies the installation and shows the connection.</li>
</ol>
<form id="handoff" method="post" action="${html(page.action)}">
<input type="hidden" name="manifest" value="${html(page.manifest)}">
<button type="submit">Continue to GitHub</button>
</form>`,
			{ runsOn: 'Runs on' },
		)
	}
<script nonce="${html(page.nonce)}">${AUTO_SUBMIT}</script>
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
