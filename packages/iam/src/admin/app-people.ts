// An application's own people, administered by the application's own administrator: a person
// holding the application's `members.manage` globally there grants and revokes the application's global roles through
// IAM's administration API, without being an installation admin. Every change writes its audit row under the
// application, in the change's own transaction. This is authorization, never an enforcement decision (ADR-0022).

import { MAX_APP_MEMBERS_PAGE, normalizeEmailIdentity, type PermissionEntry, permits } from '@fabrika/auth-core'
import type {
	AdministeredAppDto,
	AppPeopleDto,
	AppPeopleInput,
	GrantAppRoleRequest,
	GrantAppRoleResponse,
	RevokeAppRoleRequest,
	RevokeAppRoleResponse,
} from '@fabrika/iam-contract'
import type { IamAppContext } from '../app'
import { contractGrantProblem } from '../contract-rules'
import {
	type AppMembersRow,
	type AuditEventInput,
	auditLabelOf,
	type DelegatedAuthority,
	ExternalGrantError,
	type PrincipalRow,
	principalStatus,
	type RoleRow,
} from '../db'
import { appMemberPage } from '../membership'
import { unixNow } from '../repositories/sql'
import { authorityDeadline, type HeldEntry, resolveAuthorityAt } from '../resolve'
import { BUILTIN_ROLES } from '../roles'
import type { Services } from '../services'
import { parseStoredPermissions } from '../stored-permissions'
import { fail } from './context'
import { IAM_APP } from './router'

/** The person administering, as the console's token names it. */
interface PeopleAdministrator {
	readonly services: Services
	readonly principal: PrincipalRow
	readonly requestId: string
}

/**
 * An application the administrator holds `members.manage` of, globally, with its permissions there, and the authority
 * a change writes under: the administrator's grant revision and the app's schema revision, read before the check.
 */
interface AdministeredApp {
	readonly app: string
	readonly people: AppMembersRow
	readonly permissions: PermissionEntry[]
	readonly supports: readonly HeldEntry[]
	readonly authority: DelegatedAuthority
}

/**
 * The person behind the request. Only a person administers an application's people, and only through a signed-in
 * session: a `px_` key is refused, presented directly or exchanged by the proxy for a console token, because a key's own
 * grants narrow what it carries and these checks resolve the person's.
 */
async function administrator(ctx: IamAppContext): Promise<PeopleAdministrator> {
	const admin = ctx.admin
	if (admin === null) return fail(401, 'missing_token')
	if (admin.type !== 'user' || admin.audience === IAM_APP || !admin.session) {
		return fail(403, 'an application administrator is a person signed in to the console')
	}
	const principal = await ctx.services.repositories.principals.getPrincipalById(admin.id)
	if (principal === null || principalStatus(principal) === 'disabled') return fail(403, 'not_allowed')
	return { services: ctx.services, principal, requestId: ctx.requestId }
}

/** The application, when it declares its people and the administrator holds its `members.manage` globally there. */
async function administeredApp(admin: PeopleAdministrator, app: string): Promise<AdministeredApp | null> {
	const schemaRevision = await admin.services.repositories.appSchema.getSchemaRevision(app)
	const people = await admin.services.repositories.appSchema.getAppMembers(app)
	if (people === null) return null
	const live = await resolveAuthorityAt(admin.services, admin.principal, app)
	const permissions = live.permissions
	const authority = { administratorId: admin.principal.id, app, grantRevision: admin.principal.grant_revision, schemaRevision }
	return permits(permissions, people.manage) ? { app, people, permissions, supports: live.supports, authority } : null
}

/** A delegated change that wrote nothing because the authority its check read changed meanwhile. */
async function refuseIfStale(admin: PeopleAdministrator, administered: AdministeredApp): Promise<void> {
	if (!(await admin.services.repositories.grants.delegatedAuthorityHolds(administered.authority))) {
		fail(409, 'your authority over the application changed meanwhile; try again')
	}
}

/** One answer for an unknown application and one the caller does not administer, so neither is told apart. */
async function requireAdministered(admin: PeopleAdministrator, app: string): Promise<AdministeredApp> {
	return (await administeredApp(admin, app)) ?? fail(404, 'no application whose people you administer')
}

/**
 * The application's global roles the administrator may give and take: declared by the application (never a custom
 * policy or a built-in), not a membership role, and granting nothing the administrator lacks globally there.
 */
async function grantableRoles(admin: PeopleAdministrator, administered: AdministeredApp): Promise<RoleRow[]> {
	const roles = await admin.services.repositories.appSchema.listRolesByOrigin(administered.app, 'app')
	return roles.filter((role) =>
		role.member_scope === null && !Object.hasOwn(BUILTIN_ROLES, role.role_key)
		&& parseStoredPermissions(role.permissions).every((action) => permits(administered.permissions, action))
	)
}

async function grantableRole(admin: PeopleAdministrator, administered: AdministeredApp, roleKey: string): Promise<RoleRow> {
	const role = (await grantableRoles(admin, administered)).find((candidate) => candidate.role_key === roleKey)
	if (role === undefined) {
		return fail(403, `'${roleKey}' is not a global role of the application whose every action you hold`)
	}
	return role
}

/** The record of a change the administrator made, filed under the application. A user's audit label is its id. */
function peopleEvent(admin: PeopleAdministrator, app: string, event: { action: string; resourceId: string; metadata: unknown }): AuditEventInput {
	return {
		requestId: admin.requestId,
		principalId: admin.principal.id,
		principalLabel: auditLabelOf(admin.principal),
		app,
		resourceType: 'grant',
		...event,
	}
}

export async function listAdministeredApps(ctx: IamAppContext): Promise<{ items: AdministeredAppDto[] }> {
	const admin = await administrator(ctx)
	const items: AdministeredAppDto[] = []
	for (const row of await admin.services.repositories.appSchema.listAppMembers()) {
		const administered = await administeredApp(admin, row.app)
		if (administered === null) continue
		const presentation = await admin.services.repositories.appSchema.getPresentation(row.app)
		items.push({
			app: row.app,
			displayName: presentation?.display_name ?? null,
			roles: (await grantableRoles(admin, administered)).map((role) => ({
				key: role.role_key,
				name: role.name,
				permissions: parseStoredPermissions(role.permissions),
			})),
		})
	}
	return { items }
}

export async function listAppPeople(ctx: IamAppContext, input: AppPeopleInput): Promise<AppPeopleDto> {
	const admin = await administrator(ctx)
	const administered = await requireAdministered(admin, input.app)
	const page = await appMemberPage(admin.services, administered.app, administered.people, true, input.after ?? null, MAX_APP_MEMBERS_PAGE)
	return { app: administered.app, ...page }
}

export async function grantAppRole(ctx: IamAppContext, input: GrantAppRoleRequest): Promise<GrantAppRoleResponse> {
	const admin = await administrator(ctx)
	const administered = await requireAdministered(admin, input.app)
	const role = await grantableRole(admin, administered, input.role)
	const { principals, grants, appSchema } = admin.services.repositories
	const target = await principals.getUserByEmail(normalizeEmailIdentity(input.email))
	if (target === null || target.type !== 'user') {
		return fail(404, 'IAM knows no person by that address; an IAM administrator invites people')
	}
	const contract = await contractGrantProblem(appSchema, administered.app, { roleKey: role.role_key, permissions: null, scopeType: null })
	if (contract !== null) return fail(400, contract)
	try {
		// S8: the grant ends no later than the administrator's own grants of `manage` and of every action of the role.
		const carried = [administered.people.manage, ...parseStoredPermissions(role.permissions)].map(
			(action): PermissionEntry => ({ action, scope: null, source: 'grant' }),
		)
		const expiresAt = authorityDeadline(administered, carried, unixNow())
		const granted = await grants.createDelegatedRoleGrant(
			{ principalId: target.id, roleKey: role.role_key, grantedBy: admin.principal.id, expiresAt },
			administered.authority,
			(grantId) =>
				peopleEvent(admin, administered.app, {
					action: 'iam.grant.create',
					resourceId: grantId,
					metadata: { principalId: target.id, roleKey: role.role_key, scopeType: null, scopeValue: null, delegated: true },
				}),
		)
		if (granted === null) await refuseIfStale(admin, administered)
		return { principalId: target.id, role: role.role_key, granted: granted !== null }
	} catch (cause) {
		if (cause instanceof ExternalGrantError) return fail(409, cause.message)
		throw cause
	}
}

export async function revokeAppRole(ctx: IamAppContext, input: RevokeAppRoleRequest): Promise<RevokeAppRoleResponse> {
	const admin = await administrator(ctx)
	const administered = await requireAdministered(admin, input.app)
	const role = await grantableRole(admin, administered, input.role)
	const { grants } = admin.services.repositories
	const held = (await grants.listGrants(input.principalId)).find((grant) =>
		grant.app === administered.app && grant.role_key === role.role_key && grant.scope_type === null && grant.scope_value === null
	)
	if (held === undefined) return { revoked: false }
	const revoked = await grants.deleteDelegatedGrant(
		held,
		administered.authority,
		peopleEvent(admin, administered.app, {
			action: 'iam.grant.revoke',
			resourceId: held.id,
			metadata: { principalId: input.principalId, roleKey: role.role_key, scopeType: null, scopeValue: null, delegated: true },
		}),
	)
	if (!revoked) await refuseIfStale(admin, administered)
	return { revoked }
}
