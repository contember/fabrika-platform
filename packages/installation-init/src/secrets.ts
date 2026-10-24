// The credentials a platform installation is seeded with, and their shapes.
//
// The shapes are not free choices. Each one is what the consuming code already parses:
//
//   • `FABRIKA_IAM_SIGNING_KEYS` is a JSON array of PRIVATE JWKs, index 0 the active signer
//     (`@fabrika/iam`'s `Signer.fromPrivateJwks`). ES256 / P-256, RFC 7638 thumbprint `kid`.
//   • A `px_` key is IAM's own credential spelling, and every shared secret must be at least 32
//     characters or the service refuses to boot — 32 random bytes at base64url is 43.
//   • The vault KEK is 32 RAW BYTES at base64, not base64url: `@fabrika/control` imports it as an
//     AES key, and base64url is a different alphabet.
//
// Nothing here re-reads an existing value: whether a run generates or reuses one is the provider's flow.

import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'

/**
 * A 256-bit secret in base64url, never starting with `-` or `_`.
 *
 * The re-roll is copied from `@fabrika/local-stack`'s `prepare.ts` and it is not superstition: a
 * credential beginning with `-` reads as a FLAG to anything that later takes it on a command line, no
 * matter how it is quoted. One rolled password beginning with `-` made `mc alias set` print its usage
 * and loop forever. It costs nothing and removes a bug that appears about one install in sixteen.
 */
export const randomSecret = (): string => {
	for (;;) {
		const value = randomBytes(32).toString('base64url')
		if (!value.startsWith('-') && !value.startsWith('_')) {
			return value
		}
	}
}

/** The `px_` prefix IAM's own credentials carry, so a key looks like what it is wherever it turns up. */
export const randomPxKey = (): string => `px_${randomSecret()}`

/** The control plane's vault KEK. base64, NOT base64url: the vault imports these bytes as an AES key. */
export const generateVaultKey = (): string => randomBytes(32).toString('base64')

/**
 * One ES256 (EC P-256) private JWK with an RFC 7638 thumbprint `kid`, shaped exactly as IAM's
 * `Signer.fromPrivateJwks` loads it.
 */
const generateEs256Jwk = (): JsonWebKey & { kid: string; alg: string; use: string } => {
	const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
	const jwk = privateKey.export({ format: 'jwk' })
	// RFC 7638 thumbprint over the canonical EC members, in lexicographic order (crv, kty, x, y).
	const thumbprint = createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest('base64url')
	return { ...jwk, kid: thumbprint, alg: 'ES256', use: 'sig' }
}

/** IAM's token-signing material: a JSON array with one ES256 private JWK, index 0 the active signer. */
export const generateSigningKeys = (): string => JSON.stringify([generateEs256Jwk()])

/** Everything a container installation is seeded with. Several of these are shared by more than one service. */
export interface InstallationSecrets {
	/** IAM's token-signing material: a JSON array of ES256 private JWKs, index 0 active. */
	readonly signingKeys: string
	/** Authenticates IAM's management `/rpc/*` surface. Held by IAM, control and Operations. */
	readonly rpcKey: string
	/** Authenticates IAM's `/auth/mint/*` surface, which the proxy calls on the cold path. */
	readonly proxyKey: string
	/** The `px_` admin bearer IAM admits as a synthetic global admin. `platform init` and `admin` take it. */
	readonly provisioningKey: string
	/** The catalog credential control and Operations share. No `px_` prefix — it is not an IAM credential. */
	readonly operationsSyncKey: string
	/** The control plane's vault KEK: 32 raw bytes at base64. Its loss is unrecoverable by design. */
	readonly vaultKey: string
}

/** Roll one installation's secrets. Pure entropy in, no I/O, nothing persisted. */
export const generateInstallationSecrets = (): InstallationSecrets => ({
	signingKeys: generateSigningKeys(),
	rpcKey: randomPxKey(),
	proxyKey: randomPxKey(),
	provisioningKey: randomPxKey(),
	operationsSyncKey: randomSecret(),
	vaultKey: generateVaultKey(),
})
