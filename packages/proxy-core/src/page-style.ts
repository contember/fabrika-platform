import type { BrandImage, InstallationBrand } from './brand'

/**
 * The one stylesheet of every page fabrika renders outside the console and an application's own interface: IAM's
 * sign-in, account, invitation and consent pages, Control's GitHub handoff, and the proxy's error pages (`./pages`).
 * Each page is the console's welcome (`packages/dashboard/src/styles.css`, `.welcome`) set for a page that stands alone:
 * one panel in the middle of the window, the page's own words at the left, the fabrika mark drawn large on the
 * blueprint grid at the right, and fabrika named once, quietly, in a footer under it. Unlike the console's welcome the
 * panel follows the scheme: a plate on the floor in light, the welcome's dark panel in dark. Buttons are the console's:
 * outlined, and the brand blue fills only the page's one constructive step, the first button of a form or of its `.actions` row.
 * `pageBody` writes the frame, so every page has the same one; the account page, which a person works on, takes
 * `WORKSPACE_STYLE` after this one and `workspaceBody` instead. `page-style.test.ts` fails when a token here drifts from
 * the console's.
 *
 * It imports nothing at runtime and loads nothing: every page that carries it admits only its own inline style, so the
 * console's IBM Plex is used where the machine has it and a system face otherwise. The values the console mixes with
 * `color-mix()` are written out here, and `light-dark()` is a media query, because these pages reach every browser
 * that follows a sign-in link, not only the console's.
 *
 * The proxy's Caddy configuration serves it inside a `static_response` body, where Caddy expands `{name}`
 * placeholders. Every block therefore opens with `{` and a newline, never `{` and a name.
 */
export const PAGE_STYLE = `
:root {
	color-scheme: light dark;
	--floor: #f6f7f9;
	--panel: #ffffff;
	--panel-rule: rgba(14, 20, 32, 0.1);
	--art-rule: rgba(14, 20, 32, 0.08);
	--logo: #2544c2;
	--recess: #f1f3f6;
	--tile: rgba(14, 20, 32, 0.045);
	--plate-raised: #ffffff;
	--rule-soft: rgba(14, 20, 32, 0.05);
	--rule: rgba(14, 20, 32, 0.1);
	--rule-strong: rgba(14, 20, 32, 0.18);
	--control: #ffffff;
	--control-rule: rgba(14, 20, 32, 0.16);
	--control-hover: #f2f4f7;
	--ink: #0e1117;
	--ink-2: #343d4a;
	--ink-3: #4b5563;
	--ink-4: #596372;
	--engrave: #4b5563;
	--brand: #2544c2;
	--brand-hover: #1e389f;
	--brand-on: #ffffff;
	--blueprint: #2544c2;
	--blueprint-hover: #1e369b;
	--blueprint-wash: rgba(37, 68, 194, 0.07);
	--rule-focus: rgba(37, 68, 194, 0.28);
	--lamp-stop: #bf2f2f;
	--wash-stop: rgba(191, 47, 47, 0.09);
	--rule-stop: rgba(191, 47, 47, 0.45);
	--r-1: 4px;
	--r-2: 6px;
	--font-ui: 'IBM Plex Sans Variable', 'IBM Plex Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
	--font-mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

@media (prefers-color-scheme: dark) {
	:root {
		--floor: #080a0d;
		--panel: #080a0d;
		--panel-rule: rgba(255, 255, 255, 0.08);
		--art-rule: rgba(255, 255, 255, 0.08);
		--logo: #e6e9ee;
		--recess: #0a0d11;
		--tile: #15191f;
		--plate-raised: #1b2027;
		--rule-soft: rgba(255, 255, 255, 0.055);
		--rule: rgba(255, 255, 255, 0.1);
		--rule-strong: rgba(255, 255, 255, 0.18);
		--control: #11151a;
		--control-rule: rgba(255, 255, 255, 0.15);
		--control-hover: #1b2027;
		--ink: #f1f3f6;
		--ink-2: #b0b2b8;
		--ink-3: #85878e;
		--ink-4: #5c5e64;
		--engrave: #8b8d94;
		--blueprint: #9dabe4;
		--blueprint-hover: #bec7ed;
		--blueprint-wash: rgba(37, 68, 194, 0.16);
		--rule-focus: rgba(37, 68, 194, 0.45);
		--lamp-stop: #f4736f;
		--wash-stop: rgba(244, 115, 111, 0.14);
		--rule-stop: rgba(244, 115, 111, 0.45);
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

/* The panel and its footer, together in the middle of the window; a page taller than the window grows down. */
body {
	display: grid;
	align-content: center;
	min-height: 100vh;
	min-height: 100dvh;
	margin: 0;
	padding: 3rem 1rem;
	background: var(--floor);
	color: var(--ink);
	font: 400 0.875rem/1.5 var(--font-ui);
	font-variant-numeric: tabular-nums;
	-webkit-font-smoothing: antialiased;
	-moz-osx-font-smoothing: grayscale;
}

::selection {
	background: var(--blueprint-wash);
}

main {
	display: grid;
	grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr);
	gap: 2.5rem;
	width: 100%;
	max-width: 60rem;
	margin: 0 auto;
	padding: 2.75rem;
	background: var(--panel);
	border: 1px solid var(--panel-rule);
	border-radius: var(--r-2);
	color: var(--ink-2);
	overflow-wrap: anywhere;
}

.copy {
	min-width: 0;
	align-self: center;
}

.copy > :last-child {
	margin-bottom: 0;
}

/* The mark on the grid of the console's welcome, in the brand blue on both panels. */
.art {
	display: grid;
	place-items: center;
	min-height: 15rem;
	color: var(--brand);
	background-image:
		linear-gradient(var(--art-rule) 1px, transparent 1px),
		linear-gradient(90deg, var(--art-rule) 1px, transparent 1px);
	background-size: 24px 24px;
	background-position: center;
	border-radius: var(--r-1);
}

.art svg {
	display: block;
	width: min(70%, 10rem);
	height: auto;
}

/* The client's logo (ADR-0066), fitted inside the grid whatever its proportions: a wordmark runs wide, a symbol tall. */
.art img {
	display: block;
	max-width: 80%;
	max-height: 8rem;
	width: auto;
	height: auto;
}

.made-with {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 1rem;
	width: 100%;
	max-width: 60rem;
	margin: 1rem auto 0;
	padding-inline: 0.25rem;
	color: var(--ink-3);
	font-size: 0.75rem;
}

.runs-on {
	display: inline-flex;
	align-items: center;
	gap: 0.3125rem;
}

.runs-on svg {
	display: block;
}

.eyebrow {
	margin: 0 0 0.75rem;
	color: var(--ink-3);
	font-size: 0.8125rem;
	font-weight: 500;
}

h1 {
	margin: 0 0 1rem;
	font-size: clamp(1.75rem, 4vw, 2.5rem);
	font-weight: 700;
	line-height: 1.05;
	letter-spacing: -0.04em;
	color: var(--ink);
	text-wrap: balance;
}

h2 {
	margin: 1.25rem 0 0.125rem;
	color: var(--ink);
	font-size: 0.9375rem;
	font-weight: 600;
	line-height: 1.4;
}

p {
	max-width: 34rem;
	margin: 0 0 0.75rem;
	color: var(--ink-2);
	font-size: 0.9375rem;
	line-height: 1.6;
	text-wrap: pretty;
}

strong {
	color: var(--ink);
	font-weight: 600;
}

a {
	color: var(--blueprint);
	text-decoration: none;
	border-radius: 2px;
}

a:hover {
	color: var(--blueprint-hover);
	text-decoration: underline;
	text-underline-offset: 2px;
	text-decoration-thickness: 1px;
}

:focus-visible {
	outline: 2px solid var(--blueprint);
	outline-offset: 2px;
}

code {
	padding: 0.1em 0.35em;
	font-family: var(--font-mono);
	font-size: 0.92em;
	background: var(--recess);
	border-radius: var(--r-1);
}

/* An address under a heading: secondary, small, and broken anywhere rather than overflowing. */
.uri {
	margin: 0 0 0.5rem;
	color: var(--ink-3);
	font-family: var(--font-mono);
	font-size: 0.75rem;
	overflow-wrap: anywhere;
}

ul {
	margin: 0 0 0.75rem;
	padding: 0;
	list-style: none;
	border: 1px solid var(--rule);
	border-radius: var(--r-2);
	font-size: 0.875rem;
}

li {
	padding: 0.5rem 0.75rem;
	color: var(--ink-2);
}

li + li {
	border-top: 1px solid var(--rule);
}

/* A row of a name and its qualifier, the qualifier at the right and under the name when the row is narrow. */
.rows li {
	display: flex;
	flex-wrap: wrap;
	justify-content: space-between;
	gap: 0.25rem 1rem;
}

.rows li > span {
	color: var(--ink-3);
}

hr {
	margin: 1.25rem 0;
	border: 0;
	border-top: 1px solid var(--rule);
}

form {
	display: grid;
	gap: 1rem;
	margin: 1rem 0 0;
}

form + p {
	margin: 1rem 0 0;
}

label {
	display: grid;
	gap: 0.375rem;
	color: var(--ink-2);
	font-size: 0.8125rem;
	font-weight: 600;
}

fieldset {
	display: grid;
	gap: 0.5rem;
	min-width: 0;
	margin: 0;
	padding: 0;
	border: 0;
}

legend {
	margin: 0 0 0.5rem;
	padding: 0;
	color: var(--ink-2);
	font-size: 0.8125rem;
	font-weight: 600;
}

/* A radio or a checkbox with its words at its right. */
.choice {
	display: flex;
	align-items: center;
	gap: 0.5rem;
	color: var(--ink);
	font-size: 0.875rem;
	font-weight: 400;
	cursor: pointer;
}

input {
	width: 100%;
	min-width: 0;
	min-height: 2.25rem;
	margin: 0;
	padding: 0.375rem 0.625rem;
	font: inherit;
	font-size: 0.875rem;
	font-weight: 400;
	color: var(--ink);
	background: var(--control);
	border: 1px solid var(--control-rule);
	border-radius: var(--r-1);
	transition: border-color 0.12s ease, box-shadow 0.12s ease;
}

input::placeholder {
	color: var(--ink-4);
}

input:hover {
	border-color: var(--rule-strong);
}

input:focus {
	outline: none;
	border-color: var(--blueprint);
	box-shadow: 0 0 0 3px var(--rule-focus);
}

input[type='radio'],
input[type='checkbox'] {
	flex: none;
	width: 1rem;
	height: 1rem;
	min-height: 0;
	padding: 0;
	accent-color: var(--blueprint);
	box-shadow: none;
}

input[type='radio']:focus-visible,
input[type='checkbox']:focus-visible {
	outline: 2px solid var(--blueprint);
	outline-offset: 2px;
}

button,
.button {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	justify-self: start;
	gap: 0.375rem;
	min-height: 2.25rem;
	margin: 0;
	padding: 0.375rem 0.875rem;
	font: inherit;
	font-size: 0.8125rem;
	font-weight: 500;
	white-space: nowrap;
	text-decoration: none;
	color: var(--ink);
	background: var(--control);
	border: 1px solid var(--control-rule);
	border-radius: var(--r-1);
	cursor: pointer;
	transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
}

button:hover,
.button:hover {
	color: var(--ink);
	text-decoration: none;
	background: var(--control-hover);
	border-color: var(--rule-strong);
}

form > button:first-of-type,
.actions > button:first-of-type {
	color: var(--brand-on);
	background: var(--brand);
	border-color: var(--brand);
	font-weight: 600;
}

form > button:first-of-type:hover,
.actions > button:first-of-type:hover {
	color: var(--brand-on);
	background: var(--brand-hover);
	border-color: var(--brand-hover);
}

/* A form's decisions in one row, the constructive one first. */
.actions {
	display: flex;
	flex-wrap: wrap;
	gap: 0.5rem;
}

.actions > button {
	min-width: 6.5rem;
}

.password {
	display: flex;
	background: var(--control);
	border: 1px solid var(--control-rule);
	border-radius: var(--r-1);
	transition: border-color 0.12s ease, box-shadow 0.12s ease;
}

.password:hover {
	border-color: var(--rule-strong);
}

.password:focus-within {
	border-color: var(--blueprint);
	box-shadow: 0 0 0 3px var(--rule-focus);
}

.password input {
	flex: 1;
	min-height: calc(2.25rem - 2px);
	background: transparent;
	border: 0;
	box-shadow: none;
}

.password button {
	flex: none;
	min-height: 0;
	margin: 0.25rem;
	padding: 0 0.625rem;
	font-size: 0.75rem;
	color: var(--blueprint);
	background: transparent;
	border: 0;
}

.password button:hover {
	color: var(--blueprint);
	background: var(--blueprint-wash);
}

.error {
	display: flex;
	gap: 0.625rem;
	padding: 0.75rem 1rem;
	color: var(--ink);
	background: var(--wash-stop);
	border-radius: var(--r-2);
}

.error::before {
	content: '';
	flex: none;
	width: 0.5rem;
	height: 0.5rem;
	margin-top: 0.55em;
	border-radius: 50%;
	background: var(--lamp-stop);
	box-shadow: 0 0 0 3px var(--wash-stop);
}

/* On a phone the art becomes a band above the copy. */
@media (max-width: 40rem) {
	body {
		padding: 1.5rem 1rem;
	}

	main {
		grid-template-columns: minmax(0, 1fr);
		gap: 1.5rem;
		padding: 1.5rem;
	}

	.art {
		order: -1;
		min-height: 7rem;
	}

	.art svg {
		width: 4.5rem;
	}

	.art img {
		max-height: 4.5rem;
	}

	/* A smaller input makes a phone zoom the page in when it is focused. */
	input {
		font-size: 1rem;
	}
}

@media (prefers-reduced-motion: reduce) {
	* {
		transition: none !important;
	}
}
`

/**
 * The second frame, for a page a person works on rather than passes through (IAM's account page): no panel and no art,
 * the brand in a bar across the top as the console's rail carries it, and the page's sections on tiles in one column as
 * wide as the console's content, with the console's page head, tables, chips, quiet destructive buttons and dialog.
 * It follows `PAGE_STYLE` under the same nonce and overrides only what the frame changes. Every block opens with `{` and
 * a newline, as there.
 */
export const WORKSPACE_STYLE = `
body {
	display: block;
	padding: 0;
}

/* The bar's mark lines up with the content column under it. */
.topbar {
	display: flex;
	align-items: center;
	min-height: 4rem;
	padding: 0 max(1.5rem, calc((100% - 72rem) / 2));
	border-bottom: 1px solid var(--rule);
	color: var(--logo);
}

.topbar svg,
.topbar img {
	display: block;
}

.topbar img {
	max-width: 10rem;
	max-height: 1.75rem;
	width: auto;
	height: auto;
}

main.workspace {
	display: block;
	max-width: 75rem;
	padding: 2rem 1.5rem 1rem;
	background: none;
	border: 0;
	border-radius: 0;
	overflow-wrap: normal;
}

.workspace + .made-with {
	max-width: 75rem;
	margin: 0 auto;
	padding: 0 1.5rem 2rem;
}

.workspace h1 {
	margin: 0;
	font-size: 1.75rem;
	font-weight: 600;
	line-height: 1.2;
	letter-spacing: -0.025em;
}

.page-head {
	margin: 0 0 1.25rem;
}

.subtitle {
	max-width: none;
	margin: 0.5rem 0 0;
	color: var(--ink-3);
	font-size: 0.8125rem;
}

/* The page's sections, as links: each section stays on the page, so this is a way down it, not a set of tabs. */
.section-nav {
	display: flex;
	flex-wrap: wrap;
	gap: 0 0.25rem;
	margin: 0 0 1.5rem;
	border-bottom: 1px solid var(--rule);
}

.section-nav a {
	display: inline-flex;
	align-items: center;
	gap: 0.375rem;
	margin-bottom: -1px;
	padding: 0.5rem 0.75rem;
	color: var(--ink-2);
	font-size: 0.8125rem;
	font-weight: 500;
	border-bottom: 2px solid transparent;
	border-radius: 0;
}

.section-nav a:first-child {
	padding-left: 0;
}

.section-nav a:hover {
	color: var(--ink);
	text-decoration: none;
	border-bottom-color: var(--rule-strong);
}

.count {
	color: var(--ink-3);
	font-size: 0.8125rem;
	font-weight: 400;
}

/* An outcome at the top of the section it concerns, on a wash that stands out of the tile. */
.card-body > .notice {
	max-width: none;
	margin: 0 0 1rem;
	padding: 0.75rem 1rem;
	color: var(--ink);
	background: var(--blueprint-wash);
	border-radius: var(--r-2);
	font-size: 0.875rem;
}

.card-body > .notice.error {
	background: var(--wash-stop);
}

.card {
	margin: 0 0 1.5rem;
	background: var(--tile);
	border-radius: var(--r-2);
	scroll-margin-top: 1rem;
}

.card-head {
	display: flex;
	align-items: baseline;
	gap: 0.5rem;
	padding: 1rem 1.5rem 0;
}

.card-head h2 {
	margin: 0;
	font-size: 0.9375rem;
	font-weight: 500;
	letter-spacing: -0.005em;
}

.card-body {
	padding: 0.5rem 1.5rem 1.25rem;
}

.card-body > p,
.hint {
	max-width: 74ch;
	color: var(--ink-3);
	font-size: 0.8125rem;
	line-height: 1.55;
}

.card-body > p {
	margin: 0 0 0.75rem;
}

.card-body > :last-child {
	margin-bottom: 0;
}

table {
	width: 100%;
	margin: 0 0 1rem;
	border-collapse: collapse;
	font-size: 0.875rem;
}

th,
td {
	padding: 0.625rem 0.75rem;
	text-align: left;
	vertical-align: top;
	border-bottom: 1px solid var(--rule-soft);
}

:is(th, td):first-child {
	padding-left: 0;
}

:is(th, td):last-child {
	padding-right: 0;
}

thead th {
	padding-top: 0.75rem;
	padding-bottom: 0.5rem;
	border-bottom-color: var(--rule);
	color: var(--engrave);
	font-family: var(--font-mono);
	font-size: 0.6875rem;
	font-weight: 500;
	letter-spacing: 0.1em;
	text-transform: uppercase;
	white-space: nowrap;
}

th.grow {
	width: 100%;
}

/* One application's rows under its name: what reaches what reads down the table. */
tbody th[scope='rowgroup'] {
	padding-top: 1.25rem;
	color: var(--ink);
	font-size: 0.8125rem;
	font-weight: 600;
	border-bottom-color: var(--rule);
}

td {
	color: var(--ink-2);
}

td.when {
	font-size: 0.8125rem;
	white-space: nowrap;
}

td.act {
	text-align: right;
	white-space: nowrap;
}

td.act form {
	display: inline-block;
	margin: 0;
}

.line {
	display: block;
	margin-top: 0.125rem;
	color: var(--ink-3);
	font-size: 0.8125rem;
}

.chips {
	display: flex;
	flex-wrap: wrap;
	gap: 0.25rem;
	margin-top: 0.25rem;
}

.chip {
	display: inline-flex;
	align-items: center;
	padding: 0.0625rem 0.375rem;
	color: var(--ink-2);
	background: var(--recess);
	border: 1px solid var(--rule);
	border-radius: var(--r-1);
	font-family: var(--font-mono);
	font-size: 0.6875rem;
	font-weight: 500;
	line-height: 1.55;
	white-space: nowrap;
}

/* Diagnostic detail off the main path: folded under one summary line. */
details {
	margin-top: 0.375rem;
}

summary {
	width: fit-content;
	padding: 0.25rem 0;
	color: var(--ink-3);
	font-size: 0.75rem;
	cursor: pointer;
}

summary:hover {
	color: var(--ink);
}

dl {
	display: grid;
	grid-template-columns: max-content minmax(0, 1fr);
	gap: 0.25rem 0.75rem;
	margin: 0.5rem 0 0;
	font-size: 0.75rem;
}

dt {
	color: var(--ink-3);
}

dd {
	margin: 0;
	overflow-wrap: anywhere;
}

dd code {
	display: block;
	width: fit-content;
	max-width: 100%;
}

dd code + code {
	margin-top: 0.25rem;
}

/* Destructive is quiet: it never out-shouts the constructive step, and confirms in a dialog that explains it. */
main.workspace button.danger,
dialog button.danger {
	color: var(--lamp-stop);
	background: none;
	border-color: transparent;
	font-weight: 500;
}

main.workspace button.danger:hover,
dialog button.danger:hover {
	color: var(--lamp-stop);
	background: var(--wash-stop);
	border-color: var(--rule-stop);
}

dialog button.danger.strong {
	background: var(--wash-stop);
	border-color: var(--rule-stop);
	font-weight: 600;
}

main.workspace button.small {
	min-height: 1.75rem;
	padding: 0.1875rem 0.5rem;
	font-size: 0.75rem;
}

/* A one-field form in a row: the field, its button beside it, the hint under both. */
.inline-form {
	grid-template-columns: minmax(0, 22rem) auto;
	align-items: end;
	gap: 0.375rem 0.75rem;
	margin-top: 0.75rem;
}

.inline-form .hint {
	grid-column: 1 / -1;
	margin: 0;
}

.subhead {
	margin: 1.25rem 0 0;
	color: var(--ink);
	font-size: 0.8125rem;
	font-weight: 600;
}

dialog {
	width: min(32rem, calc(100% - 2rem));
	padding: 0;
	color: var(--ink-2);
	background: var(--plate-raised);
	border: 1px solid var(--rule);
	border-radius: 10px;
	box-shadow: 0 1px 2px rgba(16, 27, 40, 0.08), 0 16px 40px -12px rgba(16, 27, 40, 0.22);
}

dialog::backdrop {
	background: rgba(16, 27, 40, 0.34);
}

dialog form {
	display: block;
	margin: 0;
}

dialog h2 {
	margin: 0;
	padding: 1rem 1.5rem;
	font-size: 0.875rem;
	border-bottom: 1px solid var(--rule);
}

dialog p {
	margin: 1.25rem 1.5rem 0;
	font-size: 0.875rem;
}

/* One fact per line, a date never broken at its hyphens. */
dialog .dialog-detail {
	margin-top: 0.75rem;
	color: var(--ink-3);
	font-size: 0.8125rem;
	white-space: pre;
}

.dialog-actions {
	display: flex;
	justify-content: flex-end;
	gap: 0.5rem;
	padding: 1.25rem 1.5rem;
}

@media (prefers-color-scheme: dark) {
	dialog {
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.5), 0 16px 40px -12px rgba(0, 0, 0, 0.7);
	}

	dialog::backdrop {
		background: rgba(4, 6, 9, 0.62);
	}
}

/* On a phone each row of a table stacks its cells, each under the column's name. */
@media (max-width: 40rem) {
	.topbar {
		padding: 0 1rem;
	}

	main.workspace {
		padding: 1.5rem 1rem 1rem;
	}

	.workspace + .made-with {
		padding: 0 1rem 1.5rem;
	}

	.card-head,
	.card-body {
		padding-left: 1rem;
		padding-right: 1rem;
	}

	table.stack thead {
		display: none;
	}

	table.stack,
	table.stack tbody,
	table.stack tr,
	table.stack th,
	table.stack td {
		display: block;
	}

	table.stack tr {
		padding: 0.625rem 0;
		border-bottom: 1px solid var(--rule-soft);
	}

	table.stack tr:has(> th) {
		padding-bottom: 0;
	}

	table.stack :is(th, td) {
		padding: 0.125rem 0;
		border: 0;
	}

	table.stack td[data-label]::before {
		content: attr(data-label);
		display: inline-block;
		min-width: 7.5rem;
		color: var(--ink-3);
		font-size: 0.75rem;
	}

	table.stack td.act {
		padding-top: 0.375rem;
		text-align: left;
	}

	.inline-form {
		grid-template-columns: minmax(0, 1fr);
		align-items: stretch;
	}
}
`

/**
 * What the grid shows: the installation's client logo where it has one (ADR-0066), the designer's mark otherwise. The
 * dark variant takes over on a dark page; without one, the light logo stands on the dark panel as it is.
 */
export function pageArt(brand: InstallationBrand | null): string {
	if (brand === null) return brandMark(160)
	const dark = brand.dark === undefined ? '' : `<source media="(prefers-color-scheme: dark)" srcset="${dataUri(brand.dark)}">`
	return `<picture>${dark}<img src="${dataUri(brand.light)}" alt=""></picture>`
}

/** `brandImageDataUri` of `./brand`, written here so this module stays without a runtime import. Base64 holds no `{`. */
function dataUri(image: BrandImage): string {
	return `data:${image.type};base64,${image.base64}`
}

/** The designer's mark, as the console's `BrandMark` draws it: `height` tall and a hair narrower. */
export function brandMark(height: number): string {
	return `<svg width="${
		Math.round((height * 94) / 98)
	}" height="${height}" viewBox="0 0 94 98" fill="currentColor" aria-hidden="true" focusable="false"><path d="M0 31 53 0 94 22 94 98 54 98 54 31 25 48 25 98 0 98Z"/></svg>`
}

/** What the footer under the panel says: who runs the page, and the status the page answers with, if it has one. */
export interface PageFooter {
	/** The words before the mark and the name: "Runs on" in English. */
	readonly runsOn: string
	readonly status?: string
}

/**
 * The body every page in this stylesheet has: the panel with the page's `content` at the left and the art on the grid
 * at the right (`pageArt`), and the footer under it, which names fabrika whatever the art shows. Every value is markup
 * the caller has already escaped; the brand is checked where it was written and again where it was read.
 */
export function pageBody(content: string, footer: PageFooter, brand: InstallationBrand | null = null): string {
	return `<main>
<div class="copy">
${content}
</div>
<div class="art" aria-hidden="true">${pageArt(brand)}</div>
</main>
${madeWith(footer)}`
}

/**
 * The body of a page in `WORKSPACE_STYLE`: the brand in the bar at the top (the client logo where the installation has
 * one, the mark otherwise), the page's `content` under it, and the same footer. Every value is markup the caller has
 * already escaped.
 */
export function workspaceBody(content: string, footer: PageFooter, brand: InstallationBrand | null = null): string {
	return `<header class="topbar"><span aria-hidden="true">${brand === null ? brandMark(24) : pageArt(brand)}</span></header>
<main class="workspace">
${content}
</main>
${madeWith(footer)}`
}

function madeWith(footer: PageFooter): string {
	const status = footer.status === undefined ? '' : `<span class="status">${footer.status}</span>`
	return `<footer class="made-with"><span class="runs-on">${footer.runsOn} ${brandMark(12)} fabrika</span>${status}</footer>`
}
