// The seven values `fabrika platform install --provider=zerops` GENERATES, and their shapes.
//
// Every one of them is written to a Zerops service and never stored anywhere else — there is no `.env`
// on this path, deliberately (see `init.ts`). Only the provisioning key is ever printed, once, at the
// end of the install, because `platform init` asks the operator for it afterwards.
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
// Nothing here re-reads an existing value. `install` is a bring-up; rotating a live installation's
// signing keys or vault KEK is not something a bring-up may do by accident, so the command refuses to
// run against a project that already carries these keys rather than generating over them.

import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'

/**
 * A 256-bit secret in base64url, never starting with `-` or `_`.
 *
 * The re-roll is copied from `@fabrika/local-stack`'s `prepare.ts` and it is not superstition: a
 * credential beginning with `-` reads as a FLAG to anything that later takes it on a command line, no
 * matter how it is quoted. One rolled password beginning with `-` made `mc alias set` print its usage
 * and loop forever. It costs nothing and removes a bug that appears about one install in sixteen.
 */
const randomSecret = (): string => {
	for (;;) {
		const value = randomBytes(32).toString('base64url')
		if (!value.startsWith('-') && !value.startsWith('_')) {
			return value
		}
	}
}

/** The `px_` prefix IAM's own credentials carry, so a key looks like what it is wherever it turns up. */
const randomPxKey = (): string => `px_${randomSecret()}`

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

/** Everything one installation is seeded with. Several of these are shared by more than one service. */
export interface InstallationSecrets {
	/** IAM's token-signing material: a JSON array of ES256 private JWKs, index 0 active. */
	readonly signingKeys: string
	/** Gates IAM's management `/rpc/*` surface. Held by IAM, control and Operations. */
	readonly rpcKey: string
	/** Gates IAM's `/auth/mint/*` surface, which the proxy calls on the cold path. */
	readonly proxyKey: string
	/** The `px_` admin bearer IAM admits as a synthetic global admin. The one value this command prints. */
	readonly provisioningKey: string
	/** The catalog credential control and Operations share. No `px_` prefix — it is not an IAM credential. */
	readonly operationsSyncKey: string
	/** Authenticates control to the private source RPC. */
	readonly sourceRpcKey: string
	/** The control plane's vault KEK: 32 raw bytes at base64. Its loss is unrecoverable by design. */
	readonly vaultKey: string
}

/** Roll one installation's secrets. Pure entropy in, no I/O, nothing persisted. */
export const generateInstallationSecrets = (): InstallationSecrets => ({
	signingKeys: JSON.stringify([generateEs256Jwk()]),
	rpcKey: randomPxKey(),
	proxyKey: randomPxKey(),
	provisioningKey: randomPxKey(),
	operationsSyncKey: randomSecret(),
	sourceRpcKey: randomSecret(),
	// base64, NOT base64url: the vault imports these bytes as an AES key.
	vaultKey: randomBytes(32).toString('base64'),
})
