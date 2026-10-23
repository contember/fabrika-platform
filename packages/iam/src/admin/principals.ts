import {
	type CursorList,
	type InviteRequest,
	type ListPrincipalsInput,
	type MeDto,
	type PrincipalDetail,
	type PrincipalGrantDto,
	type PrincipalIdInput,
	type PrincipalListItem,
	type UpdatePrincipalInput,
} from '@fabrika/iam-contract'
import { type PrincipalRow, principalStatus } from '../db'
import { normalizeEmailIdentity } from '../email-identity'
import { resolvePermissionsAt } from '../resolve'
import { listRolesUseCase } from './app-schema'
import { type AdminContext, adminEvent, fail } from './context'
import { toGrantDtos } from './grant-support'
import { cursorOf, normalizeLimit } from './pagination'
import { canManagePrincipal, managesApp, requireActableTarget } from './user-admin'

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

	const permissions = row.disabled_at === null ? await resolvePermissionsAt(c.services, row, c.app) : []
	const canManage = await canManagePrincipal(c, row)
	const lastSignIns = await c.services.repositories.sessions.lastAppSignIns(id)
	const apps = new Set([...grants.flatMap((grant) => grant.app === null ? [] : [grant.app]), ...lastSignIns.map((login) => login.app)])
	if (grants.some((grant) => grant.app === null) || (bootstrapMailbox(c, row) && row.affiliation === 'internal')) {
		for (const app of c.services.config.platformAudiences) apps.add(app)
	}
	const access = await Promise.all(
		[...apps].sort().map(async (app) => ({
			app,
			permissions: row.disabled_at === null ? await resolvePermissionsAt(c.services, row, app) : [],
			lastSignInAt: lastSignIns.find((login) => login.app === app)?.signed_in_at ?? null,
		})),
	)
	const roles = new Map(
		await Promise.all([...new Set(grants.map((grant) => grant.app))].map(async (app) => [app, (await listRolesUseCase(c, { app })).items] as const)),
	)
	const authors = new Map(
		await Promise.all([...new Set(grants.flatMap((grant) => grant.granted_by === null ? [] : [grant.granted_by]))]
			.map(async (author) => [author, (await c.services.repositories.principals.getPrincipalById(author))?.label ?? author] as const)),
	)
	const grantDetails: PrincipalGrantDto[] = (await toGrantDtos(grants, c.services)).map((grant) => {
		const role = roles.get(grant.app)?.find((role) => role.key === grant.roleKey)
		return {
			...grant,
			roleName: role?.name ?? null,
			rolePermissions: role?.permissions ?? [],
			grantedByLabel: grant.grantedBy === null ? null : authors.get(grant.grantedBy) ?? grant.grantedBy,
			canManage: (c.administration.kind === 'installation' || row.type === 'user') && managesApp(c.services, c.administration, grant.app),
		}
	})
	const latestAction = await c.services.repositories.passwords.latestAction(id)
	const passwordAccount = row.type === 'user' && c.services.config.authentication.password.enabled
		? await c.services.repositories.passwords.getAccount(row.id)
		: null

	const detail: PrincipalDetail = {
		...toPrincipalListItem(row),
		bootstrapMailbox: bootstrapMailbox(c, row),
		grants: grantDetails,
		permissions,
		access,
		management: {
			account: canManage,
			passwordLinks: canManage && (c.services.email !== null || c.administration.kind === 'installation'),
			audit: c.administration.kind === 'installation',
		},
		activatedAt: row.activated_at,
		disabledAt: row.disabled_at,
		authentication: {
			oidc: {
				state: !c.services.config.authentication.oidc.enabled
					? 'unavailable'
					: row.type === 'user' && row.external_id !== null
					? 'linked'
					: 'unlinked',
			},
			password: {
				delivery: c.services.email === null ? 'manual' : 'email',
				latestAction: latestAction === null ? null : {
					purpose: latestAction.purpose,
					createdAt: latestAction.created_at,
					expiresAt: latestAction.expires_at,
					closedAt: latestAction.consumed_at,
				},
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
	await requireActableTarget(c, row)
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
 * Make an external user internal (ADR-0051). Its grant rows stay as they are, but what it may reach widens: it may then
 * hold any role, an OIDC login presenting its address may claim it, and a mailbox listed in `IAM_BOOTSTRAP_ADMINS`
 * becomes an installation admin at once. So the promotion revokes every session of the user and spends its pending
 * password actions in the same transaction, and its record says whether the mailbox is a bootstrap admin. There is no
 * demotion.
 */
export async function promotePrincipalUseCase(c: AdminContext, input: PrincipalIdInput): Promise<PrincipalListItem> {
	const id = input.principalId
	const row = await c.services.repositories.principals.getPrincipalById(id)
	if (!row) {
		return fail(404, 'principal not found')
	}
	const promoted = await c.services.repositories.principals.promoteToInternal(
		id,
		adminEvent(c, {
			action: 'iam.principal.promote',
			resourceType: 'principal',
			resourceId: id,
			metadata: { bootstrapAdmin: bootstrapMailbox(c, row) },
		}),
	)
	if (!promoted) {
		return fail(409, 'the principal is not external')
	}
	const updated = await c.services.repositories.principals.getPrincipalById(id)
	if (!updated) return fail(404, 'principal not found')
	return toPrincipalListItem(updated)
}

/** Whether the user's mailbox is listed in `IAM_BOOTSTRAP_ADMINS`: internal, it is an installation admin. */
function bootstrapMailbox(c: AdminContext, row: PrincipalRow): boolean {
	return row.type === 'user' && row.email !== null && c.services.config.bootstrapAdmins.has(normalizeEmailIdentity(row.email))
}
