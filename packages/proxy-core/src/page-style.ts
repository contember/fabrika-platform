import type { BrandImage, InstallationBrand } from './brand'

/**
 * The one stylesheet of every page fabrika renders outside the console and an application's own interface: IAM's
 * sign-in, account, invitation and consent pages, Control's GitHub handoff, and the proxy's error pages (`./pages`).
 * Each page is the console's welcome (`packages/dashboard/src/styles.css`, `.welcome`) set for a page that stands alone:
 * one panel in the middle of the window, the page's own words at the left, the fabrika mark drawn large on the
 * blueprint grid at the right, and fabrika named once, quietly, in a footer under it. Unlike the console's welcome the
 * panel follows the scheme: a plate on the floor in light, the welcome's dark panel in dark. Buttons are the console's:
 * outlined, and the brand blue fills only the page's one constructive step, the first button of a form.
 * `pageBody` writes the frame, so every page has the same one. `page-style.test.ts` fails when a token here drifts from
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
	--rule: rgba(14, 20, 32, 0.1);
	--rule-strong: rgba(14, 20, 32, 0.18);
	--control: #ffffff;
	--control-rule: rgba(14, 20, 32, 0.16);
	--control-hover: #f2f4f7;
	--ink: #0e1117;
	--ink-2: #343d4a;
	--ink-3: #4b5563;
	--ink-4: #596372;
	--brand: #2544c2;
	--brand-hover: #1e389f;
	--brand-on: #ffffff;
	--blueprint: #2544c2;
	--blueprint-hover: #1e369b;
	--blueprint-wash: rgba(37, 68, 194, 0.07);
	--rule-focus: rgba(37, 68, 194, 0.28);
	--lamp-stop: #bf2f2f;
	--wash-stop: rgba(191, 47, 47, 0.09);
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
		--rule: rgba(255, 255, 255, 0.1);
		--rule-strong: rgba(255, 255, 255, 0.18);
		--control: #11151a;
		--control-rule: rgba(255, 255, 255, 0.15);
		--control-hover: #1b2027;
		--ink: #f1f3f6;
		--ink-2: #b0b2b8;
		--ink-3: #85878e;
		--ink-4: #5c5e64;
		--blueprint: #9dabe4;
		--blueprint-hover: #bec7ed;
		--blueprint-wash: rgba(37, 68, 194, 0.16);
		--rule-focus: rgba(37, 68, 194, 0.45);
		--lamp-stop: #f4736f;
		--wash-stop: rgba(244, 115, 111, 0.14);
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

form > button:first-of-type {
	color: var(--brand-on);
	background: var(--brand);
	border-color: var(--brand);
	font-weight: 600;
}

form > button:first-of-type:hover {
	color: var(--brand-on);
	background: var(--brand-hover);
	border-color: var(--brand-hover);
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
	const status = footer.status === undefined ? '' : `<span class="status">${footer.status}</span>`
	return `<main>
<div class="copy">
${content}
</div>
<div class="art" aria-hidden="true">${pageArt(brand)}</div>
</main>
<footer class="made-with"><span class="runs-on">${footer.runsOn} ${brandMark(12)} fabrika</span>${status}</footer>`
}
