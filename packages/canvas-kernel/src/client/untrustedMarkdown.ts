import { Marked } from 'marked'

/**
 * Markdown to HTML for text the canvas author did not write: submitted feedback,
 * which quotes annotation fields verbatim, including those a share reviewer sent
 * back. marked passes raw HTML through and keeps any link scheme, so this
 * instance escapes every raw HTML token and renders a link or image whose URL
 * is not http(s), mailto or relative as its plain text. What comes out carries
 * no markup the markdown syntax did not produce and no script URL.
 *
 * It is a separate instance on purpose: canvas modules render their own
 * markdown with the shared `marked`, raw HTML included, and configure it
 * globally.
 */
const untrustedMarked = new Marked({
	gfm: true,
	breaks: false,
	renderer: {
		html({ text }) {
			return escapeHtml(text)
		},
		link({ href, tokens }) {
			if (isSafeUrl(href)) return false
			return this.parser.parseInline(tokens)
		},
		image({ href, text }) {
			if (isSafeUrl(href)) return false
			return escapeHtml(text)
		},
	},
})

export function renderUntrustedMarkdown(md: string): string {
	return untrustedMarked.parse(md, { async: false })
}

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])
// Resolves a relative URL so the scheme check sees what a browser would; it is
// never fetched or rendered.
const RELATIVE_BASE = 'https://relative.invalid/'

/**
 * Whether a link or image URL may be rendered. The URL parser normalizes the
 * way a browser does: it strips leading control characters and spaces, drops
 * tabs and newlines inside the scheme and lowercases it, so an obfuscated
 * `javascript:` does not slip past. A URL without a scheme resolves against the
 * base and passes as relative.
 */
export function isSafeUrl(href: string): boolean {
	if (!URL.canParse(href, RELATIVE_BASE)) return false
	return SAFE_PROTOCOLS.has(new URL(href, RELATIVE_BASE).protocol)
}

const HTML_ESCAPES: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;',
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch)
}
