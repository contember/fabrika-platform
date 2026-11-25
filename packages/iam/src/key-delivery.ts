// A requested key leaves IAM only encrypted to the public key of the agent that asked (ADR-0083 §8): a compact JWE,
// `ECDH-ES` key agreement straight to that key and `A256GCM` content, whose `kid` is the key's RFC 7638 thumbprint.

import { recipientKeyThumbprint, type RecipientPublicKey, REQUESTED_KEY_JWE } from '@fabrika/iam-contract'
import { CompactEncrypt, importJWK } from 'jose'

/** `plaintext` encrypted to `recipient`; only the matching private key opens it. */
export async function encryptToRecipient(plaintext: string, recipient: RecipientPublicKey): Promise<string> {
	const key = await importJWK({ ...recipient }, REQUESTED_KEY_JWE.alg)
	return await new CompactEncrypt(new TextEncoder().encode(plaintext))
		.setProtectedHeader({ ...REQUESTED_KEY_JWE, kid: recipientKeyThumbprint(recipient) })
		.encrypt(key)
}
