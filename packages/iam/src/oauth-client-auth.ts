import type { OAuthClientCredential, OAuthClientMetadataDocument } from '@fabrika/iam-contract'
import { createLocalJWKSet, errors, type JSONWebKeySet, type JWTPayload, jwtVerify } from 'jose'
import type { EstablishedClient } from './oauth'
import { clientJwks, clientMetadata } from './oauth-client'
import type { OAuthConfig } from './oauth-config'
import { unixNow } from './repositories/sql'
import type { Services } from './services'

const CLOCK_TOLERANCE_SECONDS = 60
/** The common ceiling for a client assertion's lifetime; client libraries default to it. */
const MAX_ASSERTION_LIFETIME_SECONDS = 3600
const MAX_JTI_LENGTH = 256

type PrivateKeyJwtClient = Extract<OAuthClientMetadataDocument, { token_endpoint_auth_method: 'private_key_jwt' }>

/**
 * Authenticate the client of a token or revocation request (RFC 6749 §2.3). The method is the one the
 * client's own metadata document declares, never the one the request picks: a `private_key_jwt` client
 * that sends no assertion is refused, and a public client that sends one is refused too.
 * `audiences` are the values an assertion's `aud` may name.
 */
export async function authenticateOAuthClient(
	services: Services,
	config: OAuthConfig,
	input: { clientId: string; credential: OAuthClientCredential; audiences: string[] },
): Promise<EstablishedClient | null> {
	const registration = config.clients.find((client) => client.clientId === input.clientId)
	if (registration === undefined) return null
	const metadata = await clientMetadata(registration)
	if (metadata === null) return null
	if (metadata.token_endpoint_auth_method === 'none') return input.credential.method === 'none' ? { registration, metadata } : null
	if (input.credential.method !== 'private_key_jwt') return null
	const accepted = await verifyClientAssertion(services, metadata, input.credential.assertion, input.audiences)
	return accepted ? { registration, metadata } : null
}

/**
 * Whether a revocation request comes from its client (RFC 7009 §2.1). A confidential client authenticates as at the
 * token endpoint. A request without an assertion only names a registered client: the token's own client binding is
 * enough for a public client, so an unreachable metadata document never keeps a token alive. It is refused only when
 * the document is known and declares `private_key_jwt`.
 */
export async function authenticateRevokingClient(
	services: Services,
	config: OAuthConfig,
	input: { clientId: string; credential: OAuthClientCredential; audiences: string[] },
): Promise<boolean> {
	if (input.credential.method !== 'none') return await authenticateOAuthClient(services, config, input) !== null
	const registration = config.clients.find((client) => client.clientId === input.clientId)
	if (registration === undefined) return false
	const metadata = await clientMetadata(registration)
	return metadata?.token_endpoint_auth_method !== 'private_key_jwt'
}

/** RFC 7523 §3: signed by a key of the client's JWKS, `iss` = `sub` = client id, an IAM `aud`, a short `exp`, a fresh `jti`. */
async function verifyClientAssertion(services: Services, client: PrivateKeyJwtClient, assertion: string, audiences: string[]): Promise<boolean> {
	const cached = await clientJwks(client.jwks_uri, { refetch: false })
	if (cached === null) return false
	let payload = await verifyWith(cached, client, assertion, audiences)
	if (payload === 'unknown_key') {
		// The client may have rotated its keys since the set was cached.
		const refetched = await clientJwks(client.jwks_uri, { refetch: true })
		payload = refetched === null ? null : await verifyWith(refetched, client, assertion, audiences)
	}
	if (payload === null || payload === 'unknown_key') return false
	const now = unixNow()
	const { exp, jti } = payload
	if (exp === undefined || exp > now + MAX_ASSERTION_LIFETIME_SECONDS + CLOCK_TOLERANCE_SECONDS) return false
	if (typeof jti !== 'string' || jti.length === 0 || jti.length > MAX_JTI_LENGTH) return false
	// Kept past `exp` by the tolerance, which is how long the verifier still accepts the assertion.
	return services.repositories.oauth.recordClientAssertion(client.client_id, jti, exp + CLOCK_TOLERANCE_SECONDS)
}

async function verifyWith(
	jwks: JSONWebKeySet,
	client: PrivateKeyJwtClient,
	assertion: string,
	audiences: string[],
): Promise<JWTPayload | 'unknown_key' | null> {
	try {
		const { payload } = await jwtVerify(assertion, createLocalJWKSet(jwks), {
			algorithms: [client.token_endpoint_auth_signing_alg],
			issuer: client.client_id,
			subject: client.client_id,
			audience: audiences,
			requiredClaims: ['exp', 'jti'],
			clockTolerance: CLOCK_TOLERANCE_SECONDS,
		})
		return payload
	} catch (error) {
		return error instanceof errors.JWKSNoMatchingKey ? 'unknown_key' : null
	}
}
