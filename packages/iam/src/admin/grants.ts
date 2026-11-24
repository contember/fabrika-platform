import {
	type CreateGrantRequest,
	type GrantChangeResponse,
	type GrantDto,
	type OkResponse,
	type PendingGrantChange,
	type UpdateGrantInput,
} from '@fabrika/iam-contract'
import { contractGrantProblem, externalGrantProblem } from '../contract-rules'
import { ExternalGrantError, type GrantRow } from '../db'
import { parseStoredPermissions } from '../stored-permissions'
import { type AdminContext, adminEvent, fail } from './context'
import { type GrantChangeRequest, grantsWait, requestGrantChange } from './grant-requests'
import { appField, grantIdOf, parseRoleOrInline, parseScope, RoleKnownCache, toGrantDto } from './grant-support'
import { requireGrantablePrincipal, requireManagedApp } from './user-admin'

export async function createGrantUseCase(c: AdminContext, input: CreateGrantRequest): Promise<GrantChangeResponse> {
	const principalId = input.principalId
	if (principalId.trim() === '') return fail(400, 'principalId required')
	if (await c.services.repositories.grants.isWorkloadPrincipal(principalId)) {
		return fail(409, 'a job, a webhook or a connector holds no grant: its actions come from the application schema')
	}
	const appResult = await appField(c, input)
	if (!appResult.ok) {
		return fail(400, 'unknown app')
	}
	const app = appResult.app
	requireManagedApp(c, app)
	const roleOrInline = await parseRoleOrInline(c, input, app)
	if (!roleOrInline.ok) {
		return fail(400, roleOrInline.message)
	}
	const scope = parseScope(input)
	if (!scope.ok) {
		return fail(400, scope.message)
	}
	const principal = await c.services.repositories.principals.getPrincipalById(principalId)
	if (!principal) {
		return fail(404, 'principal not found')
	}
	const contractProblem = await contractGrantProblem(
		c.services.repositories.appSchema,
		app,
		{ ...roleOrInline, scopeType: scope.scopeType },
		principal.type === 'user',
	)
	if (contractProblem !== null) {
		return fail(400, contractProblem)
	}
	const expiresAt = Number.isFinite(input.expiresAt) ? input.expiresAt ?? null : null
	requireGrantablePrincipal(c, principal)
	const external = await externalGrantProblem(c.services.repositories.appSchema, principal, app, roleOrInline)
	if (external !== null) {
		return fail(409, external)
	}
	const { scopeType, scopeValues } = scope
	const values = { principalId, app, scopeType, grantedBy: c.admin.id, expiresAt }
	const roleKey = roleOrInline.roleKey
	if (app !== null && await grantsWait(c.services, app)) {
		if (roleKey !== null) {
			const held = await findHeldRoleGrant(c, { ...values, roleKey, scopeValues })
			if (held !== undefined && (held.expires_at === null || held.expires_at > Math.floor(Date.now() / 1000))) {
				return fail(409, `principal ${principalId} already holds this grant: ${grantIdOf(held)}`)
			}
		}
		return await pendingChange(c, {
			app,
			kind: 'create',
			principalId,
			grantId: null,
			roleKey,
			permissions: roleOrInline.permissions,
			scopeType,
			scopeValues,
			grantExpiresAt: expiresAt,
			requestedBy: c.admin.id,
		})
	}
	const record = (grantId: string) =>
		adminEvent(c, {
			action: 'iam.grant.create',
			resourceType: 'grant',
			resourceId: grantId,
			metadata: {
				principalId,
				roleKey: roleOrInline.roleKey,
				permissions: roleOrInline.permissions,
				scopeType,
				scopeValue: scopeValues?.[0] ?? null,
				...(scopeValues !== null && scopeValues.length > 1 ? { scopeValues } : {}),
				app,
			},
		})
	const heldMessage = (held: GrantRow | undefined) =>
		`principal ${principalId} already holds this grant${held === undefined ? '' : `: ${grantIdOf(held)}`}`
	const findHeld = (key: string) => findHeldRoleGrant(c, { ...values, roleKey: key, scopeValues }).catch(() => undefined)
	let rows: GrantRow[]
	try {
		if (scopeValues !== null && scopeValues.length > 1) {
			// One row per value: a value the principal already holds this role in fails the unique index, so name it first.
			const held = roleKey === null ? undefined : await findHeld(roleKey)
			if (held !== undefined) return fail(409, heldMessage(held))
			try {
				rows = await c.services.repositories.grants.createGrantSet({ ...values, roleKey, permissions: roleOrInline.permissions, scopeValues }, record)
			} catch (cause) {
				if (cause instanceof ExternalGrantError || roleKey === null) throw cause
				const raced = await findHeld(roleKey)
				if (raced !== undefined) return fail(409, heldMessage(raced))
				throw cause
			}
		} else if (roleKey === null) {
			rows = [
				await c.services.repositories.grants.createGrant(
					{ ...values, scopeValue: scopeValues?.[0] ?? null, permissions: roleOrInline.permissions },
					record,
				),
			]
		} else {
			const created = await c.services.repositories.grants.createRoleGrantUnlessHeld(
				{ ...values, scopeValue: scopeValues?.[0] ?? null, roleKey },
				record,
			)
			if (created === null) return fail(409, heldMessage(await findHeld(roleKey)))
			rows = [created]
		}
	} catch (cause) {
		// A reconcile narrowed the role between the check above and the write, which carries the condition itself.
		if (cause instanceof ExternalGrantError) return fail(409, cause.message)
		throw cause
	}
	return grantDto(rows, new RoleKnownCache(c.services))
}

function grantDto(rows: readonly GrantRow[], cache: RoleKnownCache): Promise<GrantDto> {
	const [first, ...rest] = rows
	if (first === undefined) return fail(409, 'The access changed. Refresh and try again.')
	return toGrantDto([first, ...rest], cache)
}

export async function deleteGrantUseCase(c: AdminContext, input: { id: string }): Promise<OkResponse & Partial<PendingGrantChange>> {
	const read = await c.services.repositories.grants.getGrantSet(input.id)
	if (read === null) {
		return fail(404, 'grant not found')
	}
	const [grant] = read.rows
	requireManagedApp(c, grant.app)
	const principal = await c.services.repositories.principals.getPrincipalById(grant.principal_id)
	if (!principal) {
		return fail(404, 'grant not found')
	}
	requireGrantablePrincipal(c, principal)
	const id = grantIdOf(grant)
	const scopeValues = scopeValuesOf(read.rows)
	if (grant.app !== null && await grantsWait(c.services, grant.app)) {
		return {
			ok: true,
			...await pendingChange(c, {
				app: grant.app,
				kind: 'revoke',
				principalId: grant.principal_id,
				grantId: id,
				roleKey: grant.role_key,
				permissions: grant.permissions === null ? null : parseStoredPermissions(grant.permissions),
				scopeType: grant.scope_type,
				scopeValues,
				grantExpiresAt: grant.expires_at,
				requestedBy: c.admin.id,
			}),
		}
	}
	await c.services.repositories.grants.deleteGrantSet(
		id,
		grant.principal_id,
		adminEvent(c, {
			action: 'iam.grant.revoke',
			resourceType: 'grant',
			resourceId: id,
			metadata: {
				principalId: grant.principal_id,
				roleKey: grant.role_key,
				scopeType: grant.scope_type,
				scopeValue: scopeValues?.[0] ?? null,
				...(scopeValues !== null && scopeValues.length > 1 ? { scopeValues } : {}),
			},
		}),
	)
	return { ok: true }
}

/** Edit a grant in place within its original application. Both paths use the same role, scope and external-person rules. */
export async function updateGrantUseCase(c: AdminContext, input: UpdateGrantInput): Promise<GrantChangeResponse> {
	const read = await c.services.repositories.grants.getGrantSet(input.id)
	if (read === null) return fail(404, 'grant not found')
	const [grant] = read.rows
	requireManagedApp(c, grant.app)
	const principal = await c.services.repositories.principals.getPrincipalById(grant.principal_id)
	if (principal === null) return fail(404, 'principal not found')
	requireGrantablePrincipal(c, principal)
	const authorization = await parseRoleOrInline(c, input, grant.app)
	if (!authorization.ok) return fail(400, authorization.message)
	const scope = parseScope(input)
	if (!scope.ok) return fail(400, scope.message)
	const problem = await contractGrantProblem(
		c.services.repositories.appSchema,
		grant.app,
		{ ...authorization, scopeType: scope.scopeType },
		principal.type === 'user',
	)
		?? await externalGrantProblem(c.services.repositories.appSchema, principal, grant.app, authorization)
	if (problem !== null) return fail(409, problem)
	const expiresAt = input.expiresAt ?? null
	if (expiresAt !== null && expiresAt <= Math.floor(Date.now() / 1000)) return fail(400, 'Choose an expiration in the future, or no expiration.')
	const id = grantIdOf(grant)
	const before = scopeValuesOf(read.rows)
	const { scopeType, scopeValues } = scope
	if (
		grant.role_key === authorization.roleKey
		&& grant.permissions === (authorization.permissions === null ? null : JSON.stringify(authorization.permissions))
		&& grant.scope_type === scopeType && sameValues(before, scopeValues)
		&& read.rows.every((row) => row.expires_at === expiresAt)
	) {
		return toGrantDto(read.rows, new RoleKnownCache(c.services))
	}
	const duplicate = async () =>
		authorization.roleKey !== null
		&& (await c.services.repositories.grants.listGrants(principal.id)).some((other) =>
			grantIdOf(other) !== id && other.app === grant.app && other.role_key === authorization.roleKey
			&& other.scope_type === scopeType
			&& (scopeValues === null ? other.scope_value === null : other.scope_value !== null && scopeValues.includes(other.scope_value))
		)
	const held = principal.type === 'user'
		? 'This user already has that role in this scope. Edit the existing access instead.'
		: 'This key already has that role in this scope. Edit the existing grant instead.'
	if (await duplicate()) return fail(409, held)
	if (grant.app !== null && await grantsWait(c.services, grant.app)) {
		return await pendingChange(c, {
			app: grant.app,
			kind: 'update',
			principalId: principal.id,
			grantId: id,
			roleKey: authorization.roleKey,
			permissions: authorization.permissions,
			scopeType,
			scopeValues,
			grantExpiresAt: expiresAt,
			requestedBy: c.admin.id,
		})
	}
	let updated: GrantRow[] | null
	try {
		updated = await c.services.repositories.grants.replaceGrantSet(
			read,
			{
				principalId: principal.id,
				app: grant.app,
				...authorization,
				scopeType,
				scopeValues,
				grantedBy: grant.granted_by,
				expiresAt,
				createdAt: Math.min(...read.rows.map((row) => row.created_at)),
			},
			adminEvent(c, {
				action: 'iam.grant.update',
				resourceType: 'grant',
				resourceId: id,
				metadata: { principalId: principal.id, app: grant.app },
				diff: {
					before: {
						roleKey: grant.role_key,
						permissions: grant.permissions === null ? null : JSON.parse(grant.permissions),
						scopeType: grant.scope_type,
						scopeValue: before?.[0] ?? null,
						...(before !== null && before.length > 1 ? { scopeValues: before } : {}),
						expiresAt: grant.expires_at,
					},
					after: {
						roleKey: authorization.roleKey,
						permissions: authorization.permissions,
						scopeType,
						scopeValue: scopeValues?.[0] ?? null,
						...(scopeValues !== null && scopeValues.length > 1 ? { scopeValues } : {}),
						expiresAt,
					},
				},
			}),
		)
	} catch (cause) {
		if (cause instanceof ExternalGrantError) return fail(409, cause.message)
		if (await duplicate()) return fail(409, held)
		throw cause
	}
	if (updated === null) return fail(409, 'The access changed or is no longer allowed. Refresh and try again.')
	return grantDto(updated, new RoleKnownCache(c.services))
}

/** The sorted values of a grant's rows; null for a global grant. */
function scopeValuesOf(rows: readonly GrantRow[]): string[] | null {
	const values = rows.flatMap((row) => row.scope_value === null ? [] : [row.scope_value])
	return values.length === 0 ? null : values.sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
}

function sameValues(a: readonly string[] | null, b: readonly string[] | null): boolean {
	return a === null || b === null ? a === b : a.length === b.length && a.every((value, index) => value === b[index])
}

/** A held grant a refused role grant duplicates in one of its values, to name it in the 409; it may be gone by the time this reads. */
async function findHeldRoleGrant(
	c: AdminContext,
	candidate: { principalId: string; app: string | null; roleKey: string; scopeType: string | null; scopeValues: readonly string[] | null },
): Promise<GrantRow | undefined> {
	const held = await c.services.repositories.grants.listGrants(candidate.principalId)
	return held.find((row) =>
		row.role_key === candidate.roleKey
		&& row.app === candidate.app
		&& row.scope_type === candidate.scopeType
		&& (candidate.scopeValues === null ? row.scope_value === null : row.scope_value !== null && candidate.scopeValues.includes(row.scope_value))
	)
}

/** Record a grant change at an application whose grants wait (ADR-0083): nothing changes until another administrator approves. */
async function pendingChange(c: AdminContext, change: GrantChangeRequest): Promise<PendingGrantChange> {
	const pending = await requestGrantChange(
		c.services,
		change,
		(requestId, metadata) => adminEvent(c, { action: 'iam.grant.request', resourceType: 'grant_request', resourceId: requestId, metadata }),
	)
	return { pending }
}
