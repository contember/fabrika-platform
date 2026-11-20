/**
 * A canvas view's string literal for a value from the repository: every character outside a small safe set becomes a
 * `\uXXXX` escape, because the canvas compiler runs regex passes over the raw source, string contents included.
 */
type Literal = string | readonly Literal[]

const SAFE_CHAR = /^[A-Za-z0-9 .,:_/-]$/

export function literal(value: Literal): string {
	if (typeof value !== 'string') return `[${value.map(literal).join(', ')}]`
	let out = '"'
	for (let i = 0; i < value.length; i++) {
		const ch = value.charAt(i)
		out += SAFE_CHAR.test(ch) ? ch : `\\u${value.charCodeAt(i).toString(16).padStart(4, '0')}`
	}
	return out + '"'
}
