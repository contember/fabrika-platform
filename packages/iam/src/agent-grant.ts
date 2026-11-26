// The exchange of an agent's device grant for the approving person's application token (ADR-0090 §3). Only the proxy
// calls it, on the mint surface, after it verified the agent's resource token for its own host.

import { AGENT_CLIENT_ID, DEFAULT_TOKEN_TTL_SECONDS, type MintFromGrantInput, type MintFromGrantResult, narrowToValue } from '@fabrika/auth-core'
import { agentModeServed, agentWriteGate } from './agent-resource'
import type { Env } from './env'
import { grantAuthority, grantResources } from './oauth'
import { unixNow } from './repositories/sql'
import { authorityDeadline, resolveAuthorityAt } from './resolve'
import type { Services } from './services'
import { getSigner, verifyResourceAccessToken } from './signing'
import { boundedToken, mailboxClaim, proxyMintedBound, signAccessToken } from './tokens'

type MintEnv = Pick<Env, 'FABRIKA_IAM_SIGNING_KEYS' | 'ENVIRONMENT'>

export interface MintFromGrantOutcome {
	result: MintFromGrantResult
	/** The grant's person, for the `auth_log` row; null when the token named none IAM could trust. */
	principalId: string | null
}

const INVALID_GRANT: MintFromGrantResult = { ok: false, reason: 'invalid_grant' }

/**
 * Exchange the agent's resource token for the person's application token at `input.app`: the person's live permissions,
 * narrowed to the grant's scope value when it names one, with `act`. The token, its grant, the approving login and the
 * person are checked again here, so a revocation, a sign-out or a disabled person ends the agent at its next exchange.
 */
export async function mintFromGrant(services: Services, env: MintEnv, input: MintFromGrantInput): Promise<MintFromGrantOutcome> {
	const claims = await verifyResourceAccessToken(await getSigner(env), input.token, { issuer: services.config.issuer })
	const oauth = claims?.oauth
	if (claims === null || oauth === undefined || claims.aud !== input.resource || oauth.app !== input.app || oauth.clientId !== AGENT_CLIENT_ID) {
		return { result: INVALID_GRANT, principalId: null }
	}
	const refused = { result: INVALID_GRANT, principalId: claims.sub }
	const grant = await services.repositories.oauth.grant(oauth.grantId)
	if (
		grant === null || grant.client_id !== AGENT_CLIENT_ID || grant.app !== input.app || grant.principal_id !== claims.sub
		|| !grantResources(grant).includes(input.resource)
	) {
		return refused
	}
	const now = unixNow()
	const authority = await grantAuthority(services, grant, now, input.resource)
	const scope = authority?.agent
	if (authority === null || scope === undefined) return refused
	if (!agentModeServed(scope.mode, await agentWriteGate(services, grant.app))) {
		return { result: { ok: false, reason: 'write_refused' }, principalId: claims.sub }
	}
	const live = await resolveAuthorityAt(services, authority.principal, grant.app)
	const permissions = scope.within === null ? live.permissions : narrowToValue(live.permissions, scope.within)
	// A revocation may have landed while authority was resolved; read the grant once more, as `mintForGrant` does.
	const current = await services.repositories.oauth.grant(grant.id)
	if (current === null || current.revoked_at !== null) return refused
	const expiresAt = Math.min(
		now + DEFAULT_TOKEN_TTL_SECONDS,
		claims.exp,
		grant.expires_at,
		authority.expiresAt ?? Number.POSITIVE_INFINITY,
		authorityDeadline(live, permissions, now) ?? Number.POSITIVE_INFINITY,
	)
	const principal = authority.principal
	const bound = await proxyMintedBound(services, grant.app)
	const token = await boundedToken(
		signAccessToken(services, env, {
			app: grant.app,
			subject: principal.id,
			type: principal.type,
			label: principal.label,
			...mailboxClaim(principal),
			permissions,
			issuedAt: now,
			expiresAt,
			act: {
				sub: AGENT_CLIENT_ID,
				grant: grant.id,
				scope,
				...(grant.agent_label === null ? {} : { label: grant.agent_label }),
			},
		}, bound),
		{ app: grant.app, subject: principal.id, bytes: bound },
	)
	if (token === null) return { result: { ok: false, reason: 'token_too_large' }, principalId: principal.id }
	return { result: { ok: true, token, expiresAt }, principalId: principal.id }
}
