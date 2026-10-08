/** OAuth 2.1 primitives shared by IAM (issuer), the proxy (enforcement) and resource servers (verification). */

/** RFC 8707 resources are byte-exact; plain HTTP is reserved for loopback development. */
export function isOAuthResourceUri(value: unknown): value is string {
	if (!isUriText(value)) return false
	try {
		const url = new URL(value)
		const local = url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
		return (url.protocol === 'https:' || (url.protocol === 'http:' && local)) && !uriAuthority(value).includes('@') && !value.includes('#')
	} catch {
		return false
	}
}

/** Client ID Metadata Document identifier: HTTPS, explicit path, no userinfo, fragment or dot segments. */
export function isCimdClientId(value: unknown): value is string {
	if (!isUriText(value) || value.includes('#') || uriAuthority(value).includes('@')) return false
	try {
		const url = new URL(value)
		const authorityAndPath = value.slice(value.indexOf('://') + 3).split(/[?#]/)[0] ?? ''
		const pathStart = authorityAndPath.indexOf('/')
		if (url.protocol !== 'https:' || pathStart === -1) return false
		const segments = authorityAndPath.slice(pathStart).split('/').map((segment) => segment.replace(/%2e/gi, '.'))
		return !segments.some((segment) => segment === '.' || segment === '..')
	} catch {
		return false
	}
}

/** RFC 6749 scope-token syntax; duplicates and empty sets are refused. */
export function parseOAuthScopes(value: unknown): string[] | null {
	if (!Array.isArray(value) || value.length === 0 || value.length > 64) return null
	const scopes: string[] = []
	for (const item of value) {
		if (typeof item !== 'string' || item.length === 0 || item.length > 200 || !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(item) || scopes.includes(item)) {
			return null
		}
		scopes.push(item)
	}
	return scopes
}

function isUriText(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\s\\<>"{}|^`]/.test(value)
		&& !/%(?![A-Fa-f0-9]{2})/.test(value) && /^https?:\/\/[^/?#]+(?:[/?#]|$)/i.test(value)
}

function uriAuthority(value: string): string {
	return value.split('://')[1]?.split(/[/?#]/)[0] ?? ''
}
