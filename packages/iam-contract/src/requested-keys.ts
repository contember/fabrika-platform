// A key for someone else, asked for through a Control approval request (ADR-0083 §8): the agent that asks sends a public
// key, and IAM encrypts the key it issues to it before it answers, so the key's plaintext leaves IAM only as a JWE that
// the agent's private key opens. The request's id is the idempotency key: a repeat answers the same key.

import { canonicalJson, sha256Hex } from '@fabrika/auth-core'

/** The public keys a requested key may be encrypted to: P-256 or X25519, as a JWK without its private part. */
export type RecipientPublicKey =
	| { readonly kty: 'EC'; readonly crv: 'P-256'; readonly x: string; readonly y: string }
	| { readonly kty: 'OKP'; readonly crv: 'X25519'; readonly x: string }

export const RECIPIENT_CURVES = ['P-256', 'X25519'] as const

/** The JWE a requested key travels in: compact, key agreement `ECDH-ES` straight to the recipient, `A256GCM` content. */
export const REQUESTED_KEY_JWE = { alg: 'ECDH-ES', enc: 'A256GCM' } as const

/** The members of a recipient key its RFC 7638 thumbprint hashes: the required public ones, nothing else. */
function thumbprintMembers(key: RecipientPublicKey): Record<string, string> {
	return key.kty === 'EC' ? { crv: key.crv, kty: key.kty, x: key.x, y: key.y } : { crv: key.crv, kty: key.kty, x: key.x }
}

/**
 * The RFC 7638 thumbprint of a recipient key (SHA-256, base64url): what the approval page shows and the agent prints
 * beside the link, and the `kid` of the JWE IAM answers.
 */
export function recipientKeyThumbprint(key: RecipientPublicKey): string {
	const hex = sha256Hex(canonicalJson(thumbprintMembers(key)))
	let binary = ''
	for (let i = 0; i < hex.length; i += 2) binary += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16))
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** Who asked for a requested key, as IAM records it beside the approver. */
export interface RequestedKeyApprovalRequest {
	/** The Control approval request's id: the idempotency key of the issuance. At most 200 characters. */
	id: string
	requester: { id: string; label: string; clientId?: string }
}

/**
 * `apiKeys.provisionRequested`: a service key a person approved in Control, issued by that person in a signed-in session.
 * Its permissions are exact actions of `app`, in one scope value or global, and it expires at most 30 days ahead.
 */
export interface ProvisionRequestedApiKeyRequest {
	label: string
	app: string
	permissions: string[]
	scopeType: string | null
	scopeValue: string | null
	/** Unix seconds; at most `MAX_KEY_LIFETIME_SECONDS` ahead. */
	expiresAt: number
	recipient: RecipientPublicKey
	approvalRequest: RequestedKeyApprovalRequest
}

/** A requested key as IAM answers it: its service principal, and the key encrypted to the recipient. */
export interface RequestedApiKey {
	principalId: string
	/** The `px_` key, encrypted to the recipient (`REQUESTED_KEY_JWE`), whose thumbprint is the JWE's `kid`. */
	jwe: string
	expiresAt: number
}

export interface RequestedApiKeyInput {
	approvalRequestId: string
}

/** `apiKeys.requested`: the key an approval request issued, or null when it issued none. */
export interface RequestedApiKeyResponse {
	key: RequestedApiKey | null
}
