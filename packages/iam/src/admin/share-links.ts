import { type IssueKeyInput, type PermissionEntry, type RoleDef } from '@fabrika/auth-core'

import {
	type CursorList,
	type IssuedShareLinkResponse,
	type IssueShareLinkRequest,
	type ListShareLinksInput,
	type OkResponse,
	type ShareLinkListItem,
} from '@fabrika/iam-contract'
import { type CredentialGrantRow, type CredentialRow } from '../db'
import { normalizeEmailIdentity } from '../email-identity'
import { issueKey } from '../issue'
import { computePermissions } from '../resolve'
import { makeRoleSource } from '../roles'
import { adminAudit, type AdminContext, fail } from './context'
import { dbRoleToDef, knownApps } from './grant-support'
import { cursorOf, groupBy, normalizeLimit } from './pagination'

function toShareLinkListItem(row: CredentialRow, grants: CredentialGrantRow[]): ShareLinkListItem {
	return {
		id: row.id,
		label: row.label,
		app: row.app,
		issuedBy: row.issued_by,
		expiresAt: row.expires_at,
		revokedAt: row.revoked_at,
		createdAt: row.created_at,
		grants: grants.map((g) => ({
			action: g.action,
			scope: g.scope_type === null || g.scope_value === null ? null : { type: g.scope_type, value: g.scope_value },
		})),
	}
}

/**
 * One page of share links. Two queries per page (the credentials read plus one grants read for the
 * page's ids), revoked links hidden unless asked for, and `app` finally filterable now that an
 * anonymous credential carries one (SEC-2, SEC-22).
 */
export async function listShareLinksUseCase(c: AdminContext, input: ListShareLinksInput): Promise<CursorList<ShareLinkListItem>> {
	const limit = normalizeLimit(input.limit)
	const creds = await c.services.repositories.credentials.listAnonymousCredentials({
		...(input.app !== undefined ? { app: input.app } : {}),
		...(input.includeRevoked === true ? { includeRevoked: true } : {}),
		...(input.before ? { before: input.before } : {}),
		limit,
	})
	const grants = groupBy(
		await c.services.repositories.credentials.getCredentialGrantsFor(creds.map((cred) => cred.id)),
		(row) => row.credential_id,
	)
	const items = creds.map((cred) => toShareLinkListItem(cred, grants.get(cred.id) ?? []))
	return { items, nextCursor: cursorOf(items, limit, (item) => item.id) }
}

/**
 * Issue an anonymous share link FOR ONE APP.
 *
 * `app` is required and is not IAM's own. A share link's grants are frozen at issue and spent
 * wherever the holder presents them, so the app has to be stated: it is what `resolveCredential`
 * checks at every mint, and without it an admin of one app could mint authority good at every other
 * app behind the proxy (SEC-2). Delegation still runs against the admin's permissions — resolved for
 * that app, which is the same question the credential will later ask.
 */
export async function createShareLinkUseCase(c: AdminContext, input: IssueShareLinkRequest): Promise<IssuedShareLinkResponse> {
	if (input.grants.length === 0 || input.grants.some((grant) => !grant.action)) return fail(400, 'grants required (each: { action, scope? })')
	const grants = input.grants.map(({ action, scope }) => ({ action, scope: scope == null ? null : { type: scope.type, value: scope.value } }))
	const { app, label, expiresAt } = input
	if (!(await knownApps(c)).includes(app)) return fail(404, 'unknown app')

	// The issuer is the resolved admin (`c.admin`) passed directly to `issueKey`, so `credential` is
	// unused here (the RPC entrypoint resolves it; this admin path already has the caller).
	const issueInput: IssueKeyInput = {
		app,
		credential: null,
		requestId: c.requestId,
		permissions: grants,
		...(label !== undefined ? { label } : {}),
		...(expiresAt !== undefined ? { expiresAt } : {}),
	}

	// An admin holding the cross-app `admin` role keeps `*` at every app; an app-scoped admin only
	// delegates what they hold THERE, which is the whole point of naming the app.
	const issuer = { id: c.admin.id, permissions: await effectiveIssuerPermissions(c, app) }
	const { result, auditLabel } = await issueKey(c.services, issueInput, issuer, app)
	if (!result.ok) {
		// Admin already gated; the only failure here is the delegation rule.
		return fail(403, `not allowed: ${result.reason}`)
	}
	await adminAudit(c, {
		action: 'iam.credential.create',
		resourceType: 'credential',
		resourceId: result.id,
		metadata: { app, label: auditLabel ?? null, grants },
	})
	const issued: IssuedShareLinkResponse = { id: result.id, token: result.token }
	return issued
}

/**
 * The admin's permissions AT THE TARGET APP, for the delegation check. `c.admin.permissions` were
 * resolved against IAM's own app; delegating into another app has to be measured there.
 */
async function effectiveIssuerPermissions(c: AdminContext, app: string): Promise<PermissionEntry[]> {
	const principal = await c.services.repositories.principals.getPrincipalById(c.admin.id)
	if (!principal) {
		// A synthetic caller (the provisioning key / the local-dev bypass) has no row; it already
		// carries its own resolved permission set, which is global by construction.
		return c.admin.permissions
	}
	const grants = await c.services.repositories.grants.getActiveGrantsForApp(principal.id, app)
	const isBootstrapAdmin = principal.type === 'user' && principal.email !== null
		&& c.services.config.bootstrapAdmins.has(normalizeEmailIdentity(principal.email))
	const appRoles: Record<string, RoleDef> = {}
	for (const dbRole of await c.services.repositories.appSchema.listRoles(app)) {
		appRoles[dbRole.role_key] = dbRoleToDef(dbRole)
	}
	return computePermissions({ app, grants, isBootstrapAdmin }, makeRoleSource(appRoles))
}

export async function revokeShareLinkUseCase(c: AdminContext, input: { id: string }): Promise<OkResponse> {
	const id = input.id
	// Only anonymous credentials are share links; a principal-bound key is managed on the api-keys
	// page, so it reads as not-found here.
	const cred = await c.services.repositories.credentials.getCredentialById(id)
	if (!cred || cred.principal_id !== null) {
		return fail(404, 'share link not found')
	}
	await c.services.repositories.credentials.revokeCredential(id)
	await adminAudit(c, {
		action: 'iam.credential.revoke',
		resourceType: 'credential',
		resourceId: id,
		metadata: { label: cred.label },
	})
	return { ok: true }
}
