import {
	type ListSessionsInput,
	type PrincipalIdInput,
	type RevokedSessionsResponse,
	type SessionDto,
	type SessionIdInput,
	type SessionList,
} from '@fabrika/iam-contract'
import { sessionUsable } from '../auth'
import type { ListedSessionRow } from '../repositories/sessions'

import { type AdminContext, adminEvent, fail } from './context'

import { cursorOf, normalizeLimit } from './pagination'
import { requireActableTarget } from './user-admin'

/** Stored lifecycle stays compatible; availability also reflects the parent, account and installation switches. */
function toSessionDto(c: AdminContext, row: ListedSessionRow, now: number, disabled: boolean): SessionDto {
	const unavailableReason = row.revoked_at !== null
		? 'revoked'
		: row.expires_at <= now
		? 'expired'
		: row.parent_session_id !== null && (row.parent_expires_at === null || row.parent_expires_at <= now || row.parent_revoked_at !== null)
		? 'parent_ended'
		: disabled
		? 'account_disabled'
		: !sessionUsable(row, c.services.config)
		? 'method_disabled'
		: null
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
		unavailableReason,
	}
}

/** Page by sign-in when requested, keeping all of that page's application sessions with their parent. */
export async function listSessionsUseCase(c: AdminContext, input: ListSessionsInput): Promise<SessionList> {
	const principal = await c.services.repositories.principals.getPrincipalById(input.principalId)
	if (!principal) {
		return fail(404, 'principal not found')
	}
	const limit = normalizeLimit(input.limit)
	const rows = await c.services.repositories.sessions.listSessionsForPrincipal(input.principalId, {
		...(input.before ? { before: input.before } : {}),
		limit,
		signInsOnly: input.signInsOnly,
	})
	const now = Math.floor(Date.now() / 1000)
	const items = rows.map((row) => toSessionDto(c, row, now, principal.disabled_at !== null))
	const children = input.signInsOnly ? await c.services.repositories.sessions.listChildren(rows.map((row) => row.id)) : []
	return {
		items,
		nextCursor: cursorOf(items, limit, (item) => item.id),
		applications: children.map((row) => toSessionDto(c, row, now, principal.disabled_at !== null)),
	}
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
