import type { CursorList, GrantIdInput, ListSessionsInput, OkResponse, UserConnectionDto } from '@fabrika/iam-contract'
import { grantAuthority } from '../oauth'
import { parseStoredPermissions } from '../stored-permissions'
import { type AdminContext, adminEvent, fail } from './context'
import { cursorOf, normalizeLimit } from './pagination'

/** OAuth consents are installation administration, like the audit and credentials pages. */
export async function listConnections(c: AdminContext, input: ListSessionsInput): Promise<CursorList<UserConnectionDto>> {
	const principal = await c.services.repositories.principals.getPrincipalById(input.principalId)
	if (principal === null) return fail(404, 'principal not found')
	const limit = normalizeLimit(input.limit)
	const rows = await c.services.repositories.oauth.listForPrincipal(principal.id, input.before, limit)
	const now = Math.floor(Date.now() / 1000)
	const items = await Promise.all(rows.map(async (row): Promise<UserConnectionDto> => {
		const authority = await grantAuthority(c.services, row, now)
		return {
			id: row.id,
			clientId: row.client_id,
			app: row.app,
			resource: row.resource,
			scopes: parseStoredPermissions(row.scopes),
			createdAt: row.created_at,
			expiresAt: row.expires_at,
			status: row.revoked_at !== null ? 'revoked' : row.expires_at <= now
				? 'expired'
				: authority === null
				? 'unavailable'
				: 'active',
		}
	}))
	return { items, nextCursor: cursorOf(items, limit, (item) => item.id) }
}

export async function revokeConnection(c: AdminContext, input: GrantIdInput): Promise<OkResponse> {
	const grant = await c.services.repositories.oauth.grant(input.id)
	if (grant === null) return fail(404, 'connection not found')
	await c.services.repositories.oauth.revokeGrant(
		grant.id,
		Math.floor(Date.now() / 1000),
		adminEvent(c, {
			action: 'iam.oauth.grant.revoke',
			resourceType: 'oauth_grant',
			resourceId: grant.id,
			metadata: { principalId: grant.principal_id, clientId: grant.client_id, app: grant.app, reason: 'administrator' },
		}),
	)
	return { ok: true }
}
