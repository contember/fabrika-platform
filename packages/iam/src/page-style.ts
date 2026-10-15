/**
 * The one stylesheet of every IAM page, in the console's palette (`packages/dashboard/src/styles.css`) so sign-in and
 * console read as one product. It loads nothing: the CSP admits only this nonce'd element, so fonts stay system fonts.
 */
export const PAGE_STYLE = `
:root {
	color-scheme: light dark;
	--floor: #edf0f5;
	--plate: #ffffff;
	--recess: #e4e8ef;
	--rule: rgba(16, 27, 40, 0.1);
	--control: #ffffff;
	--control-rule: #8593a5;
	--control-rule-hover: #5d6b7e;
	--control-hover: #f1f4f8;
	--ink: #111820;
	--ink-2: #455262;
	--accent: #2544c2;
	--accent-hover: #1c369f;
	--accent-on: #ffffff;
	--accent-wash: rgba(37, 68, 194, 0.08);
	--focus-ring: rgba(37, 68, 194, 0.3);
	--danger: #bf2f2f;
	--danger-ink: #9c2020;
	--danger-wash: rgba(191, 47, 47, 0.07);
	--danger-rule: rgba(191, 47, 47, 0.28);
	--shadow: 0 1px 2px rgba(16, 27, 40, 0.05), 0 18px 40px -20px rgba(16, 27, 40, 0.22);
	--radius-control: 8px;
	--radius-card: 14px;
	--font-ui: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
	--font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
}

@media (prefers-color-scheme: dark) {
	:root {
		--floor: #101419;
		--plate: #171c22;
		--recess: #0d1115;
		--rule: rgba(178, 202, 232, 0.12);
		--control: #10151b;
		--control-rule: #566476;
		--control-rule-hover: #7f8ea1;
		--control-hover: #1e242c;
		--ink: #e7edf4;
		--ink-2: #a6b4c5;
		--accent: #7e98ff;
		--accent-hover: #96abff;
		--accent-on: #0c1016;
		--accent-wash: rgba(126, 152, 255, 0.12);
		--focus-ring: rgba(126, 152, 255, 0.38);
		--danger: #f4736f;
		--danger-ink: #ffaba7;
		--danger-wash: rgba(244, 115, 111, 0.1);
		--danger-rule: rgba(244, 115, 111, 0.32);
		--shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 18px 40px -20px rgba(0, 0, 0, 0.7);
	}
}

*, *::before, *::after {
	box-sizing: border-box;
}

[hidden] {
	display: none !important;
}

html {
	-webkit-text-size-adjust: 100%;
	text-size-adjust: 100%;
}

body {
	display: grid;
	place-items: center;
	min-height: 100vh;
	min-height: 100dvh;
	margin: 0;
	padding: 3rem 1rem;
	background: var(--floor);
	color: var(--ink);
	font: 400 1rem/1.5 var(--font-ui);
	-webkit-font-smoothing: antialiased;
	-moz-osx-font-smoothing: grayscale;
}

main {
	width: 100%;
	max-width: 27rem;
	padding: 2.25rem 2.25rem 2rem;
	background: var(--plate);
	border: 1px solid var(--rule);
	border-radius: var(--radius-card);
	box-shadow: var(--shadow);
	overflow-wrap: anywhere;
}

main::before {
	content: '';
	display: block;
	width: 2rem;
	height: 0.25rem;
	margin-bottom: 1.5rem;
	border-radius: 2px;
	background: var(--accent);
}

main > :last-child {
	margin-bottom: 0;
}

h1 {
	margin: 0 0 0.75rem;
	font-size: 1.5rem;
	font-weight: 650;
	line-height: 1.25;
	letter-spacing: -0.02em;
	text-wrap: balance;
}

p {
	margin: 0 0 1rem;
	color: var(--ink-2);
	text-wrap: pretty;
}

strong {
	color: var(--ink);
	font-weight: 600;
}

a {
	color: var(--accent);
	font-weight: 500;
	text-decoration: none;
	border-radius: 2px;
}

a:hover {
	color: var(--accent-hover);
	text-decoration: underline;
	text-underline-offset: 0.2em;
}

:focus-visible {
	outline: 2px solid var(--accent);
	outline-offset: 2px;
}

code {
	padding: 0.1em 0.35em;
	font-family: var(--font-mono);
	font-size: 0.875em;
	background: var(--recess);
	border-radius: 4px;
}

ul {
	margin: 0 0 1rem;
	padding: 0;
	list-style: none;
	border: 1px solid var(--rule);
	border-radius: var(--radius-control);
}

li {
	padding: 0.5rem 0.75rem;
	color: var(--ink-2);
}

li + li {
	border-top: 1px solid var(--rule);
}

hr {
	margin: 1.5rem 0;
	border: 0;
	border-top: 1px solid var(--rule);
}

form {
	display: grid;
	gap: 1.25rem;
	margin: 1.5rem 0 0;
}

form + p {
	margin: 1.25rem 0 0;
	text-align: center;
	font-size: 0.9375rem;
}

label {
	display: grid;
	gap: 0.375rem;
	font-size: 0.875rem;
	font-weight: 600;
}

input {
	width: 100%;
	min-width: 0;
	min-height: 2.75rem;
	margin: 0;
	padding: 0.625rem 0.75rem;
	font: inherit;
	font-size: 1rem;
	font-weight: 400;
	color: var(--ink);
	background: var(--control);
	border: 1px solid var(--control-rule);
	border-radius: var(--radius-control);
	transition: border-color 0.12s ease, outline-color 0.12s ease;
}

input:hover {
	border-color: var(--control-rule-hover);
}

input:focus {
	border-color: var(--accent);
	outline: 3px solid var(--focus-ring);
	outline-offset: 0;
}

button,
.button {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 100%;
	min-height: 2.75rem;
	margin: 0;
	padding: 0.625rem 1rem;
	font: inherit;
	font-size: 0.9375rem;
	font-weight: 600;
	line-height: 1.25;
	text-align: center;
	text-decoration: none;
	color: var(--accent-on);
	background: var(--accent);
	border: 1px solid var(--accent);
	border-radius: var(--radius-control);
	cursor: pointer;
	transition: background-color 0.12s ease, border-color 0.12s ease;
}

button:hover {
	background: var(--accent-hover);
	border-color: var(--accent-hover);
}

.button,
button + button {
	color: var(--ink);
	background: var(--control);
	border-color: var(--control-rule);
}

.button:hover,
button + button:hover {
	color: var(--ink);
	text-decoration: none;
	background: var(--control-hover);
	border-color: var(--control-rule-hover);
}

.password {
	display: flex;
	background: var(--control);
	border: 1px solid var(--control-rule);
	border-radius: var(--radius-control);
	transition: border-color 0.12s ease, outline-color 0.12s ease;
}

.password:hover {
	border-color: var(--control-rule-hover);
}

.password:focus-within {
	border-color: var(--accent);
	outline: 3px solid var(--focus-ring);
}

.password input {
	flex: 1;
	min-height: calc(2.75rem - 2px);
	background: transparent;
	border: 0;
	outline: 0;
}

.password button {
	flex: none;
	width: auto;
	min-height: 0;
	margin: 0.3125rem;
	padding: 0 0.75rem;
	font-size: 0.8125rem;
	color: var(--accent);
	background: transparent;
	border: 0;
	border-radius: 5px;
}

.password button:hover {
	background: var(--accent-wash);
}

.password button:focus-visible {
	outline-offset: 0;
}

.error {
	display: flex;
	gap: 0.625rem;
	padding: 0.75rem 0.875rem;
	font-size: 0.9375rem;
	font-weight: 500;
	color: var(--danger-ink);
	background: var(--danger-wash);
	border: 1px solid var(--danger-rule);
	border-radius: var(--radius-control);
}

.error::before {
	content: '';
	flex: none;
	width: 0.5rem;
	height: 0.5rem;
	margin-top: 0.5em;
	border-radius: 50%;
	background: var(--danger);
	box-shadow: 0 0 0 3px var(--danger-wash);
}

@media (max-width: 30rem) {
	body {
		place-items: start center;
		padding: 1.5rem 1rem;
	}

	main {
		padding: 1.75rem 1.25rem 1.5rem;
	}
}

@media (prefers-reduced-motion: reduce) {
	* {
		transition: none !important;
	}
}
`
