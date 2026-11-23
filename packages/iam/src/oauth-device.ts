import { OAUTH_CLI_CLIENT_ID, parseOAuthScopes } from '@fabrika/auth-core'
import {
	OAUTH_DEVICE_CODE_GRANT_TYPE,
	type OAuthDeviceAuthorizationRequest,
	type OAuthDeviceAuthorizationResponse,
	type OAuthResourceDto,
	type OAuthTokenRequest,
	resolveOAuthScopeToken,
} from '@fabrika/iam-contract'
import { uuidv7 } from '@fabrika/platform'
import type { Env } from './env'
import { parseJsonOrNull } from './json'
import { type EstablishedClient, grantRevocation, mintForGrant, type OAuthTokenOutcome, storedResourceList } from './oauth'
import type { OAuthConfig } from './oauth-config'
import type { OAuthDeviceAuthorizationRow, OAuthGrantRow } from './repositories/oauth'
import { unixNow } from './repositories/sql'
import { generateToken, hashToken } from './secret'
import type { Services } from './services'

type SigningEnv = Pick<Env, 'FABRIKA_IAM_SIGNING_KEYS' | 'ENVIRONMENT'>

export const OAUTH_DEVICE_PATH = '/oauth/device'
/** RFC 8628 §3.2 `expires_in`: a person has five minutes to enter the code and decide. */
export const OAUTH_DEVICE_ATTEMPT_TTL_SECONDS = 300
export const OAUTH_DEVICE_POLL_INTERVAL_SECONDS = 5

/** RFC 8628 §6.1: twenty consonants, eight of them (about 34 bits), typed without ambiguity. */
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'
const USER_CODE_LENGTH = 8

const START_WINDOW_SECONDS = 600
/**
 * Starts per client in a window. With one device client this is installation-wide, so it is set high enough that
 * blocking it takes a sustained flood, not a burst; the attempts it bounds expire in five minutes.
 */
const STARTS_PER_CLIENT = 600
/** Starts per client address, only where the composition names one (`client-address.ts`). */
const STARTS_PER_ADDRESS = 30

/** RFC 8628 §5.1: wrong user codes a signed-in person may enter before code entry is blocked for them. */
const CODE_ENTRY_WINDOW_SECONDS = 600
const CODE_ENTRIES_PER_PRINCIPAL = 10

export type DeviceStartOutcome =
	| { ok: true; body: OAuthDeviceAuthorizationResponse }
	| { ok: false; error: 'unauthorized_client' | 'invalid_target' | 'invalid_scope' | 'temporarily_unavailable' }

/** The user code as a person types it: upper case, without the separator or spaces. Null when it cannot be one. */
export function normalizeUserCode(raw: string): string | null {
	if (raw.length > 32) return null
	const code = raw.toUpperCase().replaceAll(/[\s-]/g, '')
	return code.length === USER_CODE_LENGTH && [...code].every((letter) => USER_CODE_ALPHABET.includes(letter)) ? code : null
}

export function formatUserCode(code: string): string {
	return `${code.slice(0, 4)}-${code.slice(4)}`
}

function generateUserCode(): string {
	let code = ''
	while (code.length < USER_CODE_LENGTH) {
		for (const byte of crypto.getRandomValues(new Uint8Array(USER_CODE_LENGTH))) {
			// 240 is the largest multiple of 20 below 256, so every letter is equally likely.
			if (byte < 240 && code.length < USER_CODE_LENGTH) code += USER_CODE_ALPHABET.charAt(byte % USER_CODE_ALPHABET.length)
		}
	}
	return code
}

export function userCodeHash(code: string): Promise<string> {
	return hashToken(`oauth-device-user-code:${code}`)
}

/** The resources a device request names, when the server serves every one of them for one app. */
function requestedResources(config: OAuthConfig, uris: readonly string[]): OAuthResourceDto[] | null {
	const resources: OAuthResourceDto[] = []
	for (const uri of uris) {
		const resource = config.resources.find((entry) => entry.resource === uri)
		const first = resources[0]
		if (resource === undefined || (first !== undefined && resource.app !== first.app)) return null
		resources.push(resource)
	}
	return resources
}

/** RFC 8628 §3.1–3.2: record an attempt for the CLI client and answer its codes. */
export async function startDeviceAuthorization(
	services: Services,
	config: OAuthConfig,
	request: OAuthDeviceAuthorizationRequest,
	clientAddress: string | null,
): Promise<DeviceStartOutcome> {
	if (request.client_id !== OAUTH_CLI_CLIENT_ID) return { ok: false, error: 'unauthorized_client' }
	const resources = requestedResources(config, request.resources)
	const app = resources?.[0]?.app
	if (resources === null || app === undefined) return { ok: false, error: 'invalid_target' }
	if (!resources.every((resource) => request.scope.every((token) => resolveOAuthScopeToken(token, resource) !== null))) {
		return { ok: false, error: 'invalid_scope' }
	}
	const buckets = [{ key: `oauth-device-start:client:${request.client_id}`, maxAttempts: STARTS_PER_CLIENT }]
	if (clientAddress !== null) buckets.push({ key: `oauth-device-start:address:${clientAddress}`, maxAttempts: STARTS_PER_ADDRESS })
	const now = unixNow()
	for (const bucket of buckets) {
		const throttle = await services.repositories.passwords.recordLoginFailure({
			loginKeyHash: await hashToken(bucket.key),
			windowSeconds: START_WINDOW_SECONDS,
			maxAttempts: bucket.maxAttempts,
			blockSeconds: START_WINDOW_SECONDS,
		})
		if (throttle.blocked_until !== null && throttle.blocked_until > now) return { ok: false, error: 'temporarily_unavailable' }
	}
	// A collision of either code with a live attempt is improbable; drawing again settles it.
	for (let attempt = 0; attempt < 3; attempt++) {
		const deviceCode = generateToken()
		const userCode = generateUserCode()
		const started = await services.repositories.oauth.startDeviceAuthorization({
			device_code_hash: await hashToken(deviceCode),
			user_code_hash: await userCodeHash(userCode),
			client_id: request.client_id,
			app,
			resources: JSON.stringify(request.resources),
			scopes: JSON.stringify(request.scope),
			interval_seconds: OAUTH_DEVICE_POLL_INTERVAL_SECONDS,
			created_at: now,
			expires_at: now + OAUTH_DEVICE_ATTEMPT_TTL_SECONDS,
		})
		if (!started) continue
		const verificationUri = `${services.config.issuer}${OAUTH_DEVICE_PATH}`
		return {
			ok: true,
			body: {
				device_code: deviceCode,
				user_code: formatUserCode(userCode),
				verification_uri: verificationUri,
				verification_uri_complete: `${verificationUri}?${new URLSearchParams({ user_code: formatUserCode(userCode) })}`,
				expires_in: OAUTH_DEVICE_ATTEMPT_TTL_SECONDS,
				interval: OAUTH_DEVICE_POLL_INTERVAL_SECONDS,
			},
		}
	}
	throw new Error('could not draw unused device codes')
}

export type CodeEntry =
	| { kind: 'found'; attempt: OAuthDeviceAuthorizationRow; userCode: string }
	| { kind: 'unknown' }
	| { kind: 'throttled' }

/**
 * The pending attempt a signed-in person's code names. Every code that names none counts against that person, and once
 * blocked even a right code is refused until the block ends (RFC 8628 §5.1).
 */
export async function enterUserCode(services: Services, principalId: string, raw: string): Promise<CodeEntry> {
	const key = await hashToken(`oauth-device-code:principal:${principalId}`)
	const now = unixNow()
	const before = await services.repositories.passwords.getLoginThrottle(key)
	if (before?.blocked_until != null && before.blocked_until > now) return { kind: 'throttled' }
	const userCode = normalizeUserCode(raw)
	const attempt = userCode === null ? null : await services.repositories.oauth.pendingDeviceAuthorization(await userCodeHash(userCode), now)
	if (attempt !== null && userCode !== null) return { kind: 'found', attempt, userCode }
	const after = await services.repositories.passwords.recordLoginFailure({
		loginKeyHash: key,
		windowSeconds: CODE_ENTRY_WINDOW_SECONDS,
		maxAttempts: CODE_ENTRIES_PER_PRINCIPAL,
		blockSeconds: CODE_ENTRY_WINDOW_SECONDS,
	})
	return after.blocked_until !== null && after.blocked_until > now ? { kind: 'throttled' } : { kind: 'unknown' }
}

/** The attempt's stored scope tokens and resources, or null when either does not parse. */
export function attemptRequest(attempt: OAuthDeviceAuthorizationRow): { scopes: string[]; resources: string[] } | null {
	const scopes = parseOAuthScopes(parseJsonOrNull(attempt.scopes))
	const resources = storedResourceList(attempt.resources)
	return scopes === null || resources === null ? null : { scopes, resources }
}

/**
 * RFC 8628 §3.4–3.5: one poll of the token endpoint. An approved attempt is spent for a new grant, bound to the IAM
 * session it was approved under, and answers a token for the requested resource and the grant's first refresh token.
 */
export async function redeemDeviceCode(
	services: Services,
	env: SigningEnv,
	client: EstablishedClient,
	input: Extract<OAuthTokenRequest, { grant_type: typeof OAUTH_DEVICE_CODE_GRANT_TYPE }>,
	requestId: string,
): Promise<OAuthTokenOutcome> {
	if (client.kind !== 'cli') return { ok: false, error: 'unauthorized_client' }
	const repository = services.repositories.oauth
	const now = unixNow()
	const hash = await hashToken(input.device_code)
	const attempt = await repository.deviceAuthorization(hash)
	if (attempt === null || attempt.client_id !== input.client_id) return { ok: false, error: 'invalid_grant' }
	if (attempt.status === 'redeemed') {
		// A spent device code presented again may have leaked: revoke what it gave, as for a replayed authorization code.
		if (attempt.grant_id !== null) {
			await repository.revokeGrant(attempt.grant_id, now, grantRevocation(requestId, attempt.grant_id, input.client_id, 'device_code_replay'))
		}
		return { ok: false, error: 'invalid_grant' }
	}
	if (attempt.expires_at <= now) return { ok: false, error: 'expired_token' }
	if (!await repository.admitDevicePoll(hash, now)) return { ok: false, error: 'slow_down' }
	if (attempt.status === 'denied') return { ok: false, error: 'access_denied' }
	if (attempt.status === 'pending') return { ok: false, error: 'authorization_pending' }
	const request = attemptRequest(attempt)
	// Checked before the attempt is spent, so a wrong resource does not cost the approval.
	if (request === null || !request.resources.includes(input.resource)) return { ok: false, error: 'invalid_grant' }
	const grantId = uuidv7()
	const claimed = await repository.claimDeviceAuthorization(hash, grantId, now)
	const [first] = request.resources
	if (claimed?.principal_id == null || claimed.session_id === null || claimed.grant_expires_at === null || first === undefined) {
		return { ok: false, error: 'invalid_grant' }
	}
	const grant: OAuthGrantRow = {
		id: grantId,
		principal_id: claimed.principal_id,
		session_id: claimed.session_id,
		client_id: claimed.client_id,
		app: claimed.app,
		resource: first,
		resources: JSON.stringify(request.resources),
		scopes: JSON.stringify(request.scopes),
		created_at: now,
		expires_at: claimed.grant_expires_at,
		revoked_at: null,
	}
	await repository.createGrant(grant, null, {
		requestId,
		principalId: grant.principal_id,
		principalLabel: grant.principal_id,
		app: 'propustka',
		action: 'iam.oauth.grant.create',
		resourceType: 'oauth_grant',
		resourceId: grantId,
		metadata: { clientId: grant.client_id, app: grant.app, resources: request.resources, scopes: request.scopes, flow: 'device' },
	})
	const access = await mintForGrant(services, env, grant, input.resource, now)
	if (access === null) return { ok: false, error: 'invalid_grant' }
	const refreshToken = generateToken()
	await repository.insertRefreshToken({ token_hash: await hashToken(refreshToken), grant_id: grant.id, expires_at: grant.expires_at })
	return { ok: true, body: { ...access, refresh_token: refreshToken } }
}
