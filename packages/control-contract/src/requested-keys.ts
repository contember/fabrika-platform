// The public key an agent sends with a request for a key for someone else (ADR-0083 §8), checked where it enters:
// Control, at the request's creation, and IAM, which encrypts the issued key to it.

import { RECIPIENT_CURVES, type RecipientPublicKey } from '@fabrika/iam-contract'
import { z } from 'zod'

/** 32 bytes, base64url without padding: a P-256 coordinate or an X25519 public key. */
const coordinate = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'must be 32 bytes, base64url without padding')

/**
 * A recipient key as a caller states it: P-256 or X25519, its public members and nothing else. A JWK carrying `d` is a
 * private key and is refused by name.
 */
export const recipientPublicKeySchema: z.ZodType<RecipientPublicKey, z.ZodTypeDef, unknown> = z.unknown().superRefine((value, ctx) => {
	if (typeof value === 'object' && value !== null && 'd' in value) {
		ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'is a private key: send the public key only, and keep the private key with the agent' })
	}
}).pipe(z.union([
	z.object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: coordinate, y: coordinate }).strict(),
	z.object({ kty: z.literal('OKP'), crv: z.literal('X25519'), x: coordinate }).strict(),
], { errorMap: () => ({ message: `must be a public JWK on one of ${RECIPIENT_CURVES.join(', ')}, with its public members only` }) }))
