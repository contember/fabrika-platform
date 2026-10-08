import type { Scope } from '@fabrika/auth-core'
import { parseJsonOrNull, prop } from './json'

/**
 * A share link's stored containment chain (`credentials.link_chain`), or null when the column does not
 * hold a non-empty array of `{type, value}`. A key whose chain does not parse resolves to nothing.
 */
export function parseStoredChain(json: string): Scope[] | null {
	const value = parseJsonOrNull(json)
	if (!Array.isArray(value) || value.length === 0) {
		return null
	}
	const chain: Scope[] = []
	for (const item of value) {
		const type = prop(item, 'type')
		const scopeValue = prop(item, 'value')
		if (typeof type !== 'string' || typeof scopeValue !== 'string') {
			return null
		}
		chain.push({ type, value: scopeValue })
	}
	return chain
}
