import { type PermissionEntry } from '@fabrika/auth-core'

import {
	type CursorList,
	type InviteRequest,
	type ListPrincipalsInput,
	type MeDto,
	type PrincipalDetail,
	type PrincipalIdInput,
	type PrincipalListItem,
	type UpdatePrincipalInput,
} from '@fabrika/iam-contract'
import { type PrincipalRow, principalStatus } from '../db'
import { normalizeEmailIdentity } from '../email-identity'
import { resolvePermissionsAt } from '../resolve'
import { type AdminContext, adminEvent, fail } from './context'
import { toGrantDtos } from './grant-support'
import { cursorOf, normalizeLimit } from './pagination'

function toPrincipalListItem(row: PrincipalRow): PrincipalListItem {
	return {
		id: row.id,
		type: row.type,
		label: row.label,
		email: row.email,
		externalId: row.external_id,
		status: principalStatus(row),
		affiliation: row.affiliation,
		createdAt: row.created_at,
	}
}

export function me(c: AdminContext): MeDto {
	const me: MeDto = {
		id: c.admin.id,
		type: c.admin.type,
		label: c.admin.label ?? c.admin.id,
		permissions: c.admin.permissions,
	}
	return me
}

export async function listPrincipalsUseCase(c: AdminContext, input: ListPrincipalsInput): Promise<CursorList<PrincipalListItem>> {
	const limit = normalizeLimit(input.limit)
	const rows = await c.services.repositories.principals.listPrincipals({
		...(input.type !== undefined ? { type: input.type } : {}),
		...(input.status !== undefined ? { status: input.status } : {}),
		...(input.q ? { q: input.q } : {}),
		...(input.before ? { before: input.before } : {}),
		limit,
	})
	const items = rows.map(toPrincipalListItem)
	return { items, nextCursor: cursorOf(items, limit, (item) => item.id) }
}

export async function getPrincipalUseCase(c: AdminContext, input: PrincipalIdInput): Promise<PrincipalDetail> {
	const id = input.principalId
	const row = await c.services.repositories.principals.getPrincipalById(id)
	if (!row) {
		return fail(404, 'principal not found')
	}
	const grants = await c.services.repositories.grants.listGrants(id)

	// Effective permissions: resolve them the same way authenticate() does, but
	// without the live token (groups need a cookie we don't have here) — so this
	// reflects explicit grants + bootstrap; group-derived perms are login-time.
	const permissions = await effectivePermissionsForAdmin(c, row)
	const passwordAccount = row.type === 'user' && c.services.config.authentication.password.enabled
		? await c.services.repositories.passwords.getAccount(row.id)
		: null

	const detail: PrincipalDetail = {
		...toPrincipalListItem(row),
		grants: await toGrantDtos(grants, c.services),
		permissions,
		authentication: {
			oidc: {
				state: !c.services.config.authentication.oidc.enabled
					? 'unavailable'
					: row.type === 'user' && row.external_id !== null
					? 'linked'
					: 'unlinked',
			},
			password: {
				state: !c.services.config.authentication.password.enabled
					? 'unavailable'
					: row.type !== 'user'
					? 'disabled'
					: passwordAccount?.state ?? 'disabled',
			},
		},
	}
	return detail
}

/**
 * Effective permissions for the admin detail view, resolved FOR IAM'S OWN APP — the same question
 * `authenticate()` answers, asked about `propustka`.
 *
 * It used to expand every app's grants against IAM's role table: a `vozka` grant naming role
 * `deploy-operator` was looked up among propustka's roles, so it either resolved to nothing or, on a
 * key collision, to the wrong permissions (CORR-8). The grant fetch is now app-filtered exactly as
 * `getActiveGrantsForApp` filters on the real authz path, so what this shows is a true answer to a
 * narrow question rather than an approximate answer to a broad one. Other apps' grants remain visible
 * in the grants list below, which is where a per-app view belongs.
 */
function effectivePermissionsForAdmin(c: AdminContext, row: PrincipalRow): Promise<PermissionEntry[]> {
	return resolvePermissionsAt(c.services, row, c.app)
}

export async function invitePrincipalUseCase(c: AdminContext, input: InviteRequest): Promise<PrincipalListItem> {
	const email = input.email.trim()
	if (email === '') return fail(400, 'email required')
	const normalizedEmail = normalizeEmailIdentity(email)
	const existing = await c.services.repositories.passwords.lookupActionUser(normalizedEmail)
	if (existing.status !== 'missing') {
		return fail(409, 'a user with this email already exists')
	}
	let principal: PrincipalRow
	try {
		// The mailbox is what identifies the human; the spelling the admin typed survives as the label.
		const affiliation = input.affiliation ?? 'internal'
		principal = await c.services.repositories.principals.inviteUser(
			normalizedEmail,
			email,
			(principalId) => adminEvent(c, { action: 'iam.principal.invite', resourceType: 'principal', resourceId: principalId, metadata: { affiliation } }),
			affiliation,
		)
	} catch (cause) {
		if ((await c.services.repositories.passwords.lookupActionUser(normalizedEmail)).status !== 'missing') {
			return fail(409, 'a user with this email already exists')
		}
		throw cause
	}
	return toPrincipalListItem(principal)
}

export async function updatePrincipalUseCase(c: AdminContext, input: UpdatePrincipalInput): Promise<PrincipalListItem> {
	const { principalId: id, disabled } = input
	const row = await c.services.repositories.principals.getPrincipalById(id)
	if (!row) {
		return fail(404, 'principal not found')
	}
	// Recorded only when it changes something: disabling a disabled principal is not a change.
	if (disabled) {
		await c.services.repositories.principals.disablePrincipal(
			id,
			adminEvent(c, { action: 'iam.principal.disable', resourceType: 'principal', resourceId: id }),
		)
	} else {
		await c.services.repositories.principals.enablePrincipal(
			id,
			adminEvent(c, { action: 'iam.principal.enable', resourceType: 'principal', resourceId: id }),
		)
	}
	const updated = await c.services.repositories.principals.getPrincipalById(id)
	if (!updated) return fail(404, 'principal not found')
	return toPrincipalListItem(updated)
}

/**
 * Make an external user internal (ADR-0051). It grants nothing: the user keeps its grants, every one of a role declared
 * external, and from now on an OIDC login presenting its address may claim it. There is no demotion.
 */
export async function promotePrincipalUseCase(c: AdminContext, input: PrincipalIdInput): Promise<PrincipalListItem> {
	const id = input.principalId
	const row = await c.services.repositories.principals.getPrincipalById(id)
	if (!row) {
		return fail(404, 'principal not found')
	}
	const promoted = await c.services.repositories.principals.promoteToInternal(
		id,
		adminEvent(c, { action: 'iam.principal.promote', resourceType: 'principal', resourceId: id }),
	)
	if (!promoted) {
		return fail(409, 'the principal is not external')
	}
	const updated = await c.services.repositories.principals.getPrincipalById(id)
	if (!updated) return fail(404, 'principal not found')
	return toPrincipalListItem(updated)
}
