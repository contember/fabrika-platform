/** Escape a value for HTML text and a quoted attribute. Every value a page or an e-mail inserts passes through it. */
export function escapeHtml(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}
