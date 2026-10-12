import { API_KEY_PREFIX } from '@fabrika/auth-core'

import {
	type ApiKeyDto,
	type CursorList,
	type ListApiKeysInput,
	type OkResponse,
	type ProvisionApiKeyRequest,
	type ProvisionApiKeyResponse,
	type RotateApiKeyInput,
	type RotateApiKeyResponse,
} from '@fabrika/iam-contract'
import { uuidv7 } from '@fabrika/platform'
import { z } from 'zod'
import { contractGrantProblem } from '../contract-rules'
import { principalStatus } from '../db'
import { generateToken, hashToken } from '../secret'
import { type AdminContext, adminEvent, fail } from './context'
import { appField, parseRoleOrInline, parseScope, RoleKnownCache, toGrantDtos } from './grant-support'
import { cursorOf, groupBy, normalizeLimit } from './pagination'

/**
 * One page of service principals with their grants. TWO queries per page, whatever the page holds:
 * the roster read, and one grants read for the page's ids. It used to be 1+N over an unbounded
 * roster, with no pagination at all (SEC-22).
 */
export async function listApiKeysUseCase(c: AdminContext, input: ListApiKeysInput): Promise<CursorList<ApiKeyDto>> {
	const limit = normalizeLimit(input.limit)
	const principals = await c.services.repositories.principals.listPrincipals({
		type: 'service',
		withoutWorkloads: true,
		...(input.before ? { before: input.before } : {}),
		limit,
	})
	const grants = groupBy(await c.services.repositories.grants.listGrantsFor(principals.map((p) => p.id)), (row) => row.principal_id)
	const cache = new RoleKnownCache(c.services)
	const items: ApiKeyDto[] = []
	for (const principal of principals) {
		items.push({
			principalId: principal.id,
			label: principal.label,
			status: principalStatus(principal),
			grants: await toGrantDtos(grants.get(principal.id) ?? [], c.services, cache),
			createdAt: principal.created_at,
		})
	}
	return { items, nextCursor: cursorOf(items, limit, (item) => item.principalId) }
}

export async function provisionApiKeyUseCase(c: AdminContext, input: ProvisionApiKeyRequest): Promise<ProvisionApiKeyResponse> {
	const { label, type } = input
	if (label.trim() === '' || type !== 'service') return fail(400, 'label and type=service required')
	const appResult = await appField(c, input)
	if (!appResult.ok) {
		return fail(400, 'unknown app')
	}
	const app = appResult.app
	const roleOrInline = await parseRoleOrInline(c, input, app)
	if (!roleOrInline.ok) {
		return fail(400, roleOrInline.message)
	}
	const scope = parseScope(input)
	if (!scope.ok) {
		return fail(400, 'scopeType and scopeValue must be both set or both omitted')
	}
	const contractProblem = await contractGrantProblem(c.services.repositories.appSchema, app, { ...roleOrInline, scopeType: scope.scopeType })
	if (contractProblem !== null) {
		return fail(400, contractProblem)
	}
	const expiresAt = Number.isFinite(input.expiresAt) ? input.expiresAt ?? null : null
	const nowSeconds = Math.floor(Date.now() / 1000)
	if (expiresAt !== null && expiresAt <= nowSeconds) {
		return fail(400, 'expiresAt must be in the future')
	}

	// Create the native service principal (external_id NULL — resolved by its `px_` key, not by a
	// CF client_id), its grant, the bound credential and their records, in one transaction. Shown once.
	const principalId = uuidv7()
	const grantId = uuidv7()
	const apiKey = `${API_KEY_PREFIX}${generateToken()}`
	const { principals, grants, credentials, audit } = c.services.repositories
	await audit.commit([
		principals.createServiceStatement(principalId, label),
		grants.grantStatement(grantId, {
			principalId,
			app,
			roleKey: roleOrInline.roleKey,
			permissions: roleOrInline.permissions,
			scopeType: scope.scopeType,
			scopeValue: scope.scopeValue,
			grantedBy: c.admin.id,
			expiresAt,
		}),
		...credentials.credentialStatements(uuidv7(), {
			tokenHash: await hashToken(apiKey),
			label,
			principalId,
			// The credential is bound to the SAME app as the grant it was provisioned for. `null` here is
			// the operator's explicit "every app" choice, which is legal for a principal-bound credential
			// because its permissions still resolve per app through that cross-app grant (SEC-2).
			app,
			issuedBy: c.admin.id,
			expiresAt,
			grants: [],
		}),
		audit.eventStatement(adminEvent(c, {
			action: 'iam.apikey.create',
			resourceType: 'principal',
			resourceId: principalId,
			metadata: { label, roleKey: roleOrInline.roleKey, permissions: roleOrInline.permissions, app },
		})),
		audit.eventStatement(adminEvent(c, {
			action: 'iam.grant.create',
			resourceType: 'grant',
			resourceId: grantId,
			metadata: {
				principalId,
				roleKey: roleOrInline.roleKey,
				permissions: roleOrInline.permissions,
				scopeType: scope.scopeType,
				scopeValue: scope.scopeValue,
				app,
			},
		})),
	])

	const response: ProvisionApiKeyResponse = { principalId, apiKey }
	return response
}

export async function revokeApiKeyUseCase(c: AdminContext, input: { principalId: string }): Promise<OkResponse> {
	const { principalId } = input
	const principal = await c.services.repositories.principals.getPrincipalById(principalId)
	if (principal?.type !== 'service' || (await c.services.repositories.grants.isWorkloadPrincipal(principalId))) {
		return fail(404, 'service principal not found')
	}

	const { principals, grants, credentials, audit } = c.services.repositories
	// One transaction, recorded only when it deleted a grant, disabled the principal or revoked a key.
	await audit.writer.run(
		[
			grants.deleteGrantsForPrincipalChange(principalId),
			principals.disablePrincipalChange(principalId),
			credentials.revokeCredentialsForPrincipalChange(principalId),
		],
		adminEvent(c, { action: 'iam.apikey.revoke', resourceType: 'principal', resourceId: principalId, metadata: { label: principal.label } }),
	)
	return { ok: true }
}

/**
 * Rotate: same principal, same grants, new secret. Effective immediately.
 *
 * Two things the old implementation got wrong. It DROPPED the credential's expiry — a key provisioned
 * to die in 30 days came back immortal, and an operator rotating a key on schedule was quietly
 * removing its bound (CORR-5); the replacement carries the old expiry forward unless the caller states
 * a new one, and a stated one must be in the future exactly as provisioning requires. And it rotated a
 * DISABLED principal's key, handing out a working secret for an account somebody had just revoked —
 * the same guard `passwordUser` already applies.
 */
export async function rotateApiKeyUseCase(c: AdminContext, input: RotateApiKeyInput): Promise<RotateApiKeyResponse> {
	const { principalId } = input
	const principal = await c.services.repositories.principals.getPrincipalById(principalId)
	if (principal?.type !== 'service' || (await c.services.repositories.grants.isWorkloadPrincipal(principalId))) {
		return fail(404, 'service principal not found')
	}
	if (principal.disabled_at !== null) {
		return fail(409, 'principal is disabled')
	}
	const nowSeconds = Math.floor(Date.now() / 1000)
	if (input.expiresAt !== undefined && input.expiresAt !== null && input.expiresAt <= nowSeconds) {
		return fail(400, 'expiresAt must be in the future')
	}
	// The credential being replaced decides what the replacement inherits: its expiry and its app
	// binding. `listCredentialsForPrincipal` is newest-first, so this is the live one.
	const existing = (await c.services.repositories.credentials.listCredentialsForPrincipal(principalId)).find((row) => row.revoked_at === null)
	const expiresAt = input.expiresAt !== undefined ? input.expiresAt : existing?.expires_at ?? null
	const apiKey = `${API_KEY_PREFIX}${generateToken()}`
	const { credentials, audit } = c.services.repositories
	// The old keys go, the new one comes and the record is written in one transaction: a failure leaves the old key.
	await audit.commit([
		credentials.revokeCredentialsForPrincipalStatement(principalId),
		...credentials.credentialStatements(uuidv7(), {
			tokenHash: await hashToken(apiKey),
			label: principal.label,
			principalId,
			app: existing?.app ?? null,
			issuedBy: c.admin.id,
			expiresAt,
			grants: [],
		}),
		audit.eventStatement(
			adminEvent(c, {
				action: 'iam.apikey.rotate',
				resourceType: 'principal',
				resourceId: principalId,
				metadata: { label: principal.label, expiresAt },
			}),
		),
	])
	const response: RotateApiKeyResponse = { principalId, apiKey }
	return response
}

// Bootstrap REST omits malformed optional values; admin RPC rejects them instead.
const provisionApiKeyRequestSchema = z.object({
	label: z.string(),
	type: z.literal('service'),
	roleKey: z.string().optional().catch(undefined),
	permissions: z.array(z.string()).optional().catch(undefined),
	scopeType: z.string().nullable().optional().catch(undefined),
	scopeValue: z.string().nullable().optional().catch(undefined),
	app: z.string().nullable().optional().catch(undefined),
	expiresAt: z.number().finite().optional().catch(undefined),
}).transform(({ label, type, roleKey, permissions, scopeType, scopeValue, app, expiresAt }) => {
	return {
		label,
		type,
		...(roleKey !== undefined ? { roleKey } : {}),
		...(permissions !== undefined ? { permissions } : {}),
		...(scopeType !== undefined ? { scopeType } : {}),
		...(scopeValue !== undefined ? { scopeValue } : {}),
		...(app !== undefined ? { app } : {}),
		...(expiresAt !== undefined ? { expiresAt } : {}),
	}
})

export function parseProvisionApiKeyRequest(body: unknown): ProvisionApiKeyRequest {
	const parsed = provisionApiKeyRequestSchema.safeParse(body)
	if (!parsed.success) return fail(400, 'label and type=service required')
	return parsed.data
}
