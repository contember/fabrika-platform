import {
	type CursorList,
	type ListSessionsInput,
	type PrincipalIdInput,
	type RevokedSessionsResponse,
	type SessionDto,
	type SessionIdInput,
} from '@fabrika/iam-contract'
import { type SessionRow } from '../db'

import { type AdminContext, adminEvent, fail } from './context'

import { cursorOf, normalizeLimit } from './pagination'
import { requireActableTarget } from './user-admin'

/**
 * Sessions an operator can see and end.
 *
 * Before this, the only answer to "that session should not exist" was to disable the whole
 * principal, which also locks the person out — `revokeSessionByHash` is reachable from
 * `/auth/logout` and nowhere else, so only the session's own holder could end it. That is exactly
 * the wrong shape for the case that motivated it (backlog 52): an installation that switched
 * authentication method still honoured sessions minted under the old one for another thirty days.
 *
 * **Authorization is the same check every other principal-scoped operation uses**: the `iam.admin`
 * gate on the procedure. That action is scope-less, so it is satisfied only by a GLOBAL permission —
 * there is no such thing here as an admin who may administer some principals and not others, and a
 * caller who cannot pass the gate reaches none of this. The gate is enumerated from the contract and
 * asserted for a non-admin in `admin-rpc-gates.test.ts`, so a new procedure cannot lose it quietly.
 */
function toSessionDto(row: SessionRow, now: number): SessionDto {
	return {
		id: row.id,
		principalId: row.principal_id,
		authenticationMethod: row.authentication_method,
		app: row.app,
		parentSessionId: row.parent_session_id,
		status: row.revoked_at !== null ? 'revoked' : row.expires_at <= now ? 'expired' : 'active',
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		revokedAt: row.revoked_at,
	}
}

/**
 * One page of a principal's sessions, newest first, INCLUDING revoked and expired ones — an operator
 * asking "what did this account have open" needs the ones that are already dead too.
 *
 * A child session's own status is what is reported. It can read `active` while its parent is
 * revoked, because revocation cascades at LOOKUP (the join in `getActiveSessionByHash`) and does not
 * rewrite the child row; `parentSessionId` is on the DTO so the reader can follow it.
 */
export async function listSessionsUseCase(c: AdminContext, input: ListSessionsInput): Promise<CursorList<SessionDto>> {
	const principal = await c.services.repositories.principals.getPrincipalById(input.principalId)
	if (!principal) {
		return fail(404, 'principal not found')
	}
	const limit = normalizeLimit(input.limit)
	const rows = await c.services.repositories.sessions.listSessionsForPrincipal(input.principalId, {
		...(input.before ? { before: input.before } : {}),
		limit,
	})
	const now = Math.floor(Date.now() / 1000)
	const items = rows.map((row) => toSessionDto(row, now))
	return { items, nextCursor: cursorOf(items, limit, (item) => item.id) }
}

/**
 * Revoke ONE session.
 *
 * Revoking an IAM session ends every app session derived from it in the same write: a child is valid
 * only while its parent is, and the lookup joins to the parent on every use (ADR-0022). So there is
 * no sweep to run and no window in which a child outlives its parent.
 */
export async function revokeSessionUseCase(c: AdminContext, input: SessionIdInput): Promise<RevokedSessionsResponse> {
	const session = await c.services.repositories.sessions.getSessionById(input.id)
	if (!session) {
		return fail(404, 'session not found')
	}
	const holder = await c.services.repositories.principals.getPrincipalById(session.principal_id)
	if (!holder) {
		return fail(404, 'session not found')
	}
	await requireActableTarget(c, holder)
	const revoked = await c.services.repositories.sessions.revokeSessionById(
		input.id,
		adminEvent(c, {
			action: 'iam.session.revoke',
			resourceType: 'session',
			resourceId: input.id,
			metadata: {
				principalId: session.principal_id,
				authenticationMethod: session.authentication_method,
				app: session.app,
				parentSessionId: session.parent_session_id,
			},
		}),
	)
	// Already revoked: idempotent, reported as such rather than as a failure, and recorded nowhere.
	return { revoked: revoked ? 1 : 0 }
}

/** Revoke every live session a principal holds — the "sign them out everywhere" answer. */
export async function revokeSessionsForPrincipalUseCase(c: AdminContext, input: PrincipalIdInput): Promise<RevokedSessionsResponse> {
	const principal = await c.services.repositories.principals.getPrincipalById(input.principalId)
	if (!principal) {
		return fail(404, 'principal not found')
	}
	await requireActableTarget(c, principal)
	// The recorded count is the unrevoked sessions this request saw; the row itself is written only when some went.
	const unrevoked = await c.services.repositories.sessions.countUnrevokedSessions(input.principalId)
	const revoked = await c.services.repositories.sessions.revokeSessionsForPrincipal(
		input.principalId,
		adminEvent(c, { action: 'iam.session.revoke_all', resourceType: 'principal', resourceId: input.principalId, metadata: { revoked: unrevoked } }),
	)
	return { revoked }
}
