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
<style nonce="${html(page.nonce)}">${PAGE_STYLE}</style>
</head>
<body>
<main>
<p class="eyebrow">Source connection</p>
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
</form>
</main>
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

// The console's palette (`packages/dashboard/src/styles.css`), so the handoff reads as part of the console.
const PAGE_STYLE = `
:root {
	color-scheme: light dark;
	--floor: #edf0f5;
	--plate: #ffffff;
	--rule: rgba(16, 27, 40, 0.1);
	--ink: #111820;
	--ink-2: #455262;
	--accent: #2544c2;
	--accent-hover: #1c369f;
	--accent-on: #ffffff;
	--accent-wash: rgba(37, 68, 194, 0.08);
	--focus-ring: rgba(37, 68, 194, 0.3);
	--shadow: 0 1px 2px rgba(16, 27, 40, 0.05), 0 18px 40px -20px rgba(16, 27, 40, 0.22);
}
@media (prefers-color-scheme: dark) {
	:root {
		--floor: #101419;
		--plate: #171c22;
		--rule: rgba(178, 202, 232, 0.12);
		--ink: #e7edf4;
		--ink-2: #a6b4c5;
		--accent: #7e98ff;
		--accent-hover: #96abff;
		--accent-on: #0c1016;
		--accent-wash: rgba(126, 152, 255, 0.12);
		--focus-ring: rgba(126, 152, 255, 0.38);
		--shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 18px 40px -20px rgba(0, 0, 0, 0.7);
	}
}
*, *::before, *::after { box-sizing: border-box; }
body {
	display: grid;
	place-items: center;
	min-height: 100vh;
	margin: 0;
	padding: 3rem 1rem;
	background: var(--floor);
	color: var(--ink);
	font: 400 1rem/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
}
main {
	width: 100%;
	max-width: 30rem;
	padding: 2.25rem;
	background: var(--plate);
	border: 1px solid var(--rule);
	border-radius: 14px;
	box-shadow: var(--shadow);
	overflow-wrap: anywhere;
}
.eyebrow {
	margin: 0 0 0.5rem;
	color: var(--ink-2);
	font-size: 0.75rem;
	font-weight: 600;
	letter-spacing: 0.08em;
	text-transform: uppercase;
}
h1 { margin: 0 0 0.75rem; font-size: 1.5rem; font-weight: 650; line-height: 1.25; letter-spacing: -0.02em; }
p { margin: 0 0 1.25rem; color: var(--ink-2); }
strong { color: var(--ink); font-weight: 600; }
.steps { margin: 0 0 1.75rem; padding: 0; list-style: none; counter-reset: step; }
.steps li {
	position: relative;
	margin: 0 0 0.75rem;
	padding: 0.125rem 0 0 2.5rem;
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
.steps li.current::before { background: var(--accent); border-color: var(--accent); color: var(--accent-on); }
form { margin: 0; }
button {
	width: 100%;
	padding: 0.75rem 1rem;
	border: 0;
	border-radius: 8px;
	background: var(--accent);
	color: var(--accent-on);
	font: inherit;
	font-weight: 600;
	cursor: pointer;
}
button:hover { background: var(--accent-hover); }
button:focus-visible { outline: 3px solid var(--focus-ring); outline-offset: 2px; }
`
