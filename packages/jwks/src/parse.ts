import type { Jwks } from '@fabrika/auth-core'
import { z } from 'zod'

const publicJwkSchema = z.preprocess(
	(raw) => {
		if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw
		// Binding responses can carry prototypes; inherited fields are not part of a public key.
		const fields = Object.fromEntries(
			['kty', 'crv', 'x', 'y', 'kid', 'alg', 'use']
				.filter(field => Object.hasOwn(raw, field))
				.map(field => [field, Reflect.get(raw, field)]),
		)
		Object.setPrototypeOf(fields, null)
		return fields
	},
	z.object({
		kty: z.literal('EC'),
		crv: z.string().optional(),
		x: z.string().optional(),
		y: z.string().optional(),
		kid: z.string().optional(),
		alg: z.string().optional(),
		use: z.string().optional(),
	}).refine(key => Object.values(key).every(value => value !== undefined)),
)

const jwksSchema = z.preprocess((body) => {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) return body
	return { keys: Object.hasOwn(body, 'keys') ? Reflect.get(body, 'keys') : undefined }
}, z.object({ keys: z.array(publicJwkSchema) }))

/** Reject the whole set when a member cannot be represented; dropping one would misreport an outage as an invalid token. */
export function parseJwks(body: unknown): Jwks | null {
	const result = jwksSchema.safeParse(body)
	return result.success ? result.data : null
}
