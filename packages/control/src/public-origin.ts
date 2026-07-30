const INVALID_PUBLIC_ORIGIN = 'publicOrigin must be an exact HTTP(S) origin'

export class PublicOriginValidationError extends Error {
	constructor() {
		super(INVALID_PUBLIC_ORIGIN)
		this.name = 'PublicOriginValidationError'
	}
}

export function canonicalPublicOrigin(value: string): string {
	if (value !== value.trim()) throw new PublicOriginValidationError()
	let url: URL
	try {
		url = new URL(value)
	} catch {
		throw new PublicOriginValidationError()
	}
	if (
		(url.protocol !== 'http:' && url.protocol !== 'https:')
		|| url.hostname === ''
		|| url.username !== ''
		|| url.password !== ''
		|| url.pathname !== '/'
		|| url.search !== ''
		|| url.hash !== ''
		|| url.href !== `${url.origin}/`
	) {
		throw new PublicOriginValidationError()
	}
	return url.origin
}
