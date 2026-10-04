import type { Jwks, PublicJwk } from '@fabrika/auth-core'

const EC_FIELDS: readonly ('crv' | 'x' | 'y' | 'kid' | 'alg' | 'use')[] = ['crv', 'x', 'y', 'kid', 'alg', 'use']

/** Reject the whole set when a member cannot be represented; dropping one would misreport an outage as an invalid token. */
export function parseJwks(body: unknown): Jwks | null {
	if (typeof body !== 'object' || body === null || Array.isArray(body) || !Object.hasOwn(body, 'keys')) {
		return null
	}
	const rawKeys: unknown = Reflect.get(body, 'keys')
	if (!Array.isArray(rawKeys)) {
		return null
	}
	const keys: PublicJwk[] = []
	for (const raw of rawKeys) {
		const key = parsePublicJwk(raw)
		if (key === null) {
			return null
		}
		keys.push(key)
	}
	return { keys }
}

function parsePublicJwk(raw: unknown): PublicJwk | null {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || !Object.hasOwn(raw, 'kty') || Reflect.get(raw, 'kty') !== 'EC') {
		return null
	}
	const key: PublicJwk = { kty: 'EC' }
	for (const field of EC_FIELDS) {
		if (!Object.hasOwn(raw, field)) {
			continue
		}
		const value: unknown = Reflect.get(raw, field)
		if (typeof value !== 'string') {
			return null
		}
		key[field] = value
	}
	return key
}
