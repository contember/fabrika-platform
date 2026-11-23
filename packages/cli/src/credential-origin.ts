// The origin check every credential the CLI sends passes before it goes anywhere.

/** Plain http may carry a credential to loopback only: 127.0.0.0/8, [::1], and the names RFC 6761 reserves for it, `localhost` and `*.localhost`. */
const LOOPBACK_HOST = /^(?:localhost|.+\.localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/

/** Which origin a check reads, so its refusals name the right flag and variable. `hint` follows a refusal of the value. */
export interface OriginSource {
	readonly label: string
	readonly flag: string
	readonly variable: string
	readonly hint?: string
}

type OriginCheck = { readonly origin: string } | { readonly refusal: 'not_url' | 'scheme' | 'not_origin' }

/** `raw`'s origin when it may carry a credential: https, or http to a loopback host, and nothing but scheme, host and port. */
function checkOrigin(raw: string): OriginCheck {
	let url: URL
	try {
		url = new URL(raw.trim())
	} catch {
		return { refusal: 'not_url' }
	}
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOST.test(url.hostname))) return { refusal: 'scheme' }
	if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '' || /[?#]/.test(raw)) {
		return { refusal: 'not_origin' }
	}
	return { origin: url.origin }
}

/** The origin of a value another party published (an authorization server), or null when no credential may go there. */
export const credentialOriginOf = (raw: string): string | null => {
	const checked = checkOrigin(raw)
	return 'origin' in checked ? checked.origin : null
}

/**
 * An origin a credential is sent to, checked before the credential goes anywhere. A refusal never repeats the value,
 * which may hold userinfo.
 */
export const credentialOrigin = (raw: string | undefined, source: OriginSource): string => {
	const { label, flag, variable } = source
	if (raw === undefined || raw.trim() === '') {
		throw new Error(`${label} origin is required. Pass --${flag}=<origin> or set ${variable}.`)
	}
	const checked = checkOrigin(raw)
	if ('origin' in checked) return checked.origin
	const reason = {
		not_url: `--${flag} or ${variable} is not a URL`,
		scheme: `--${flag} or ${variable} must be https; plain http only to localhost, *.localhost, 127.0.0.0/8 or [::1]`,
		not_origin: `--${flag} or ${variable} must be an origin only: no credentials, path, query or fragment`,
	}[checked.refusal]
	throw new Error(source.hint === undefined ? reason : `${reason}. ${source.hint}`)
}
