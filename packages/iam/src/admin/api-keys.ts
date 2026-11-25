import { API_KEY_PREFIX, canonicalJson, sha256Hex } from '@fabrika/auth-core'

import {
	type ApiKeyDetail,
	type ApiKeyDto,
	type ApiKeyIdInput,
	type CursorList,
	type GetApiKeyResponse,
	type ListApiKeysInput,
	type OkResponse,
	type ProvisionApiKeyRequest,
	type ProvisionApiKeyResponse,
	type ProvisionRequestedApiKeyRequest,
	recipientKeyThumbprint,
	type RequestedApiKey,
	type RequestedApiKeyInput,
	type RequestedApiKeyResponse,
	type RotateApiKeyInput,
	type RotateApiKeyResponse,
} from '@fabrika/iam-contract'
import { type SqlStatement, uuidv7 } from '@fabrika/platform'
import { z } from 'zod'
import { PROVISIONING_ADMIN_ID } from '../auth'
import { contractGrantProblem } from '../contract-rules'
import type { KeyReach } from '../credentials-gate'
import { type CredentialRow, type GrantRow, type PrincipalRow, principalStatus, type RequestedApiKeyRow } from '../db'
import { keyExpiryProblem } from '../issue'
import { encryptToRecipient } from '../key-delivery'
import { generateToken, hashToken } from '../secret'
import { type AdminContext, adminEvent, fail, requireCredentialsMode } from './context'
import { appField, grantAuthorLabels, parseRoleOrInline, parseScope, RoleKnownCache, toGrantDtos } from './grant-support'
import { cursorOf, groupBy, normalizeLimit } from './pagination'

/**
 * One page of service principals with their grants and live credentials. THREE queries per page, whatever the page
 * holds: the roster read, then one grants read and one credentials read for the page's ids. It used to be 1+N over an unbounded
 * roster, with no pagination at all (SEC-22).
 */
export async function listApiKeysUseCase(c: AdminContext, input: ListApiKeysInput): Promise<CursorList<ApiKeyDetail>> {
	const limit = normalizeLimit(input.limit)
	const principals = await c.services.repositories.principals.listPrincipals({
		type: 'service',
		withoutWorkloads: true,
		withoutTerminals: true,
		...(input.before ? { before: input.before } : {}),
		limit,
	})
	const ids = principals.map((p) => p.id)
	const [grantRows, credentialRows] = await Promise.all([
		c.services.repositories.grants.listGrantsFor(ids),
		c.services.repositories.credentials.listLiveCredentialsFor(ids),
	])
	const grants = groupBy(grantRows, (row) => row.principal_id)
	const live = new Map<string, CredentialRow>()
	for (const row of credentialRows) {
		if (row.principal_id !== null && !live.has(row.principal_id)) live.set(row.principal_id, row)
	}
	const cache = new RoleKnownCache(c.services)
	const items: ApiKeyDetail[] = []
	for (const principal of principals) {
		const dto = await toApiKeyDto(c, principal, grants.get(principal.id) ?? [], cache)
		items.push({ ...dto, credential: credentialDto(live.get(principal.id)) })
	}
	return { items, nextCursor: cursorOf(items, limit, (item) => item.principalId) }
}

/**
 * The service principal behind an API key, or null. A workload's key and a terminal are service principals too, and
 * neither is an API key: a terminal holds no key at all, and rotating one would hand it a `px_` credential.
 */
async function apiKeyPrincipal(c: AdminContext, principalId: string): Promise<PrincipalRow | null> {
	const { principals, grants, terminals } = c.services.repositories
	const principal = await principals.getPrincipalById(principalId)
	if (principal?.type !== 'service' || (await grants.isWorkloadPrincipal(principalId)) || (await terminals.getById(principalId)) !== null) {
		return null
	}
	return principal
}

/** One key with its grants, each naming who granted it, and its live credential, for the console's key page. */
export async function getApiKeyUseCase(c: AdminContext, input: ApiKeyIdInput): Promise<GetApiKeyResponse> {
	const { principalId } = input
	const { grants, credentials } = c.services.repositories
	const principal = await apiKeyPrincipal(c, principalId)
	if (principal === null) {
		return fail(404, 'service principal not found')
	}
	// `listCredentialsForPrincipal` is newest-first and rotation revokes every older key, so this is the live one.
	const live = (await credentials.listCredentialsForPrincipal(principalId)).find((row) => row.revoked_at === null)
	const rows = await grants.listGrants(principalId)
	const dto = await toApiKeyDto(c, principal, rows, new RoleKnownCache(c.services))
	const authors = await grantAuthorLabels(rows, c.services)
	return {
		...dto,
		grants: dto.grants.map((grant) => ({
			...grant,
			grantedByLabel: grant.grantedBy === null ? null : authors.get(grant.grantedBy) ?? grant.grantedBy,
		})),
		credential: credentialDto(live),
	}
}

function credentialDto(live: CredentialRow | undefined): ApiKeyDetail['credential'] {
	return live === undefined ? null : { app: live.app, expiresAt: live.expires_at }
}

async function toApiKeyDto(c: AdminContext, principal: PrincipalRow, grants: GrantRow[], cache: RoleKnownCache): Promise<ApiKeyDto> {
	return {
		principalId: principal.id,
		label: principal.label,
		status: principalStatus(principal),
		grants: await toGrantDtos(grants, c.services, cache),
		createdAt: principal.created_at,
	}
}

/**
 * Provision a key with its service principal and grant. It expires at most 30 days ahead, and a machine caller meets
 * the `credentials` mode of where it acts (ADR-0083 §8). The provisioning key, which bootstraps the first machine caller
 * over `POST /admin/api-keys` before any console exists, keeps its rule: no mode and no ceiling.
 */
export async function provisionApiKeyUseCase(c: AdminContext, input: ProvisionApiKeyRequest): Promise<ProvisionApiKeyResponse> {
	if (c.admin.id !== PROVISIONING_ADMIN_ID) {
		const problem = input.expiresAt === undefined || input.expiresAt === null
			? 'a key expires: expiresAt is required, at most 30 days ahead'
			: keyExpiryProblem(input.expiresAt, Math.floor(Date.now() / 1000))
		if (problem !== null) {
			return fail(400, problem)
		}
	}
	const plan = await planProvision(c, input)
	await requireCredentialsMode(c, plan.reach)
	await c.services.repositories.audit.commit(plan.statements)
	const response: ProvisionApiKeyResponse = { principalId: plan.principalId, apiKey: plan.apiKey }
	return response
}

/** A key with its service principal and grant, checked and written as statements of one transaction, with their records. */
interface ProvisionPlan {
	readonly principalId: string
	readonly apiKey: string
	readonly statements: SqlStatement[]
	/** Where the key's grant acts, which the `credentials` mode judges. */
	readonly reach: KeyReach[]
}

/**
 * Check what a key is provisioned with, as the console's key issuance does, and plan the writes: the service principal,
 * its grant, the bound credential and their records. `record` is added to both records' metadata.
 */
async function planProvision(c: AdminContext, input: ProvisionApiKeyRequest, record: Record<string, unknown> = {}): Promise<ProvisionPlan> {
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
		return fail(400, scope.message)
	}
	const contractProblem = await contractGrantProblem(c.services.repositories.appSchema, app, { ...roleOrInline, scopeType: scope.scopeType }, false)
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
	const statements = [
		principals.createServiceStatement(principalId, label),
		...grants.grantSetStatements(grantId, {
			principalId,
			app,
			roleKey: roleOrInline.roleKey,
			permissions: roleOrInline.permissions,
			scopeType: scope.scopeType,
			scopeValues: scope.scopeValues,
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
			metadata: { label, roleKey: roleOrInline.roleKey, permissions: roleOrInline.permissions, app, ...record },
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
				scopeValue: scope.scopeValues?.[0] ?? null,
				...(scope.scopeValues !== null && scope.scopeValues.length > 1 ? { scopeValues: scope.scopeValues } : {}),
				app,
				...record,
			},
		})),
	]
	return { principalId, apiKey, statements, reach: grantReach(app, scope.scopeType, scope.scopeValues) }
}

/** Where a grant at `app` acts: globally, or in each of its scope values. */
function grantReach(app: string | null, scopeType: string | null, scopeValues: readonly string[] | null): KeyReach[] {
	if (scopeType === null || scopeValues === null) return [{ app, scope: null }]
	return scopeValues.map((value) => ({ app, scope: { type: scopeType, value } }))
}

/** Where the grants a principal holds act: what a new secret for it, or its re-enabling, gives a key (ADR-0083 §8). */
export async function heldReach(c: AdminContext, principalId: string): Promise<KeyReach[]> {
	const held = await c.services.repositories.grants.listGrants(principalId)
	return held.flatMap((grant) => grantReach(grant.app, grant.scope_type, grant.scope_value === null ? null : [grant.scope_value]))
}

/**
 * Issue the key a person approved in Control for the agent that asked (ADR-0083 §8), as that person: a signed-in session
 * only, never a key, so no machine caller issues a requested key around the approval. The key is checked as the
 * console's key issuance checks it, holds exact actions only and expires at most 30 days ahead. The approval request's id
 * is the idempotency key: a repeat answers the key the first issued, and one that asks for something else is a 409. The
 * plaintext leaves this function only encrypted to the agent's public key; the records name the request and its requester.
 */
export async function provisionRequestedApiKeyUseCase(c: AdminContext, input: ProvisionRequestedApiKeyRequest): Promise<RequestedApiKey> {
	if (!c.admin.session) {
		return fail(403, 'a requested key is issued only by the person who approves it, in a signed-in session')
	}
	const digest = requestedKeyDigest(input)
	const issued = await c.services.repositories.credentials.getRequestedKey(input.approvalRequest.id)
	if (issued !== null) return sameRequestedKey(issued, digest)
	const expiryProblem = keyExpiryProblem(input.expiresAt, Math.floor(Date.now() / 1000))
	if (expiryProblem !== null) {
		return fail(400, expiryProblem)
	}
	const wildcard = input.permissions.find((action) => action.includes('*'))
	if (wildcard !== undefined) {
		return fail(400, `a requested key lists exact actions, not the wildcard: ${wildcard}`)
	}
	const plan = await planProvision(c, {
		label: input.label,
		type: 'service',
		permissions: input.permissions,
		scopeType: input.scopeType,
		scopeValue: input.scopeValue,
		app: input.app,
		expiresAt: input.expiresAt,
	}, { approvalRequest: input.approvalRequest })
	const jwe = await encryptToRecipient(plan.apiKey, input.recipient)
	const { credentials, audit } = c.services.repositories
	try {
		await audit.commit([
			...plan.statements,
			credentials.requestedKeyStatement({
				approval_request_id: input.approvalRequest.id,
				principal_id: plan.principalId,
				input_digest: digest,
				jwe,
				expires_at: input.expiresAt,
			}),
		])
	} catch (cause) {
		// A concurrent repeat committed first; its key is this request's, and nothing of this attempt was written.
		const raced = await credentials.getRequestedKey(input.approvalRequest.id)
		if (raced === null) throw cause
		return sameRequestedKey(raced, digest)
	}
	return { principalId: plan.principalId, jwe, expiresAt: input.expiresAt }
}

/** The key an approval request issued, for Control's follow of an execution it did not see end. */
export async function requestedApiKeyUseCase(c: AdminContext, input: RequestedApiKeyInput): Promise<RequestedApiKeyResponse> {
	const issued = await c.services.repositories.credentials.getRequestedKey(input.approvalRequestId)
	return { key: issued === null ? null : { principalId: issued.principal_id, jwe: issued.jwe, expiresAt: issued.expires_at } }
}

/** What a requested key binds, so a repeat under the same request id is told apart from a different ask. */
function requestedKeyDigest(input: ProvisionRequestedApiKeyRequest): string {
	return `sha256:${
		sha256Hex(canonicalJson({
			label: input.label,
			app: input.app,
			permissions: [...input.permissions].sort(),
			scopeType: input.scopeType,
			scopeValue: input.scopeValue,
			expiresAt: input.expiresAt,
			recipient: recipientKeyThumbprint(input.recipient),
		}))
	}`
}

function sameRequestedKey(issued: RequestedApiKeyRow, digest: string): RequestedApiKey {
	if (issued.input_digest !== digest) {
		return fail(409, 'this approval request already issued a key for a different ask; nothing was issued')
	}
	return { principalId: issued.principal_id, jwe: issued.jwe, expiresAt: issued.expires_at }
}

export async function revokeApiKeyUseCase(c: AdminContext, input: { principalId: string }): Promise<OkResponse> {
	const { principalId } = input
	const principal = await apiKeyPrincipal(c, principalId)
	if (principal === null) {
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
	const principal = await apiKeyPrincipal(c, principalId)
	if (principal === null) {
		return fail(404, 'service principal not found')
	}
	if (principal.disabled_at !== null) {
		return fail(409, 'principal is disabled')
	}
	const nowSeconds = Math.floor(Date.now() / 1000)
	if (input.expiresAt !== undefined && input.expiresAt !== null && input.expiresAt <= nowSeconds) {
		return fail(400, 'expiresAt must be in the future')
	}
	// A key keeps the expiry it has, so an existing key is untouched; a stated one takes the ceiling provisioning takes.
	if (input.expiresAt !== undefined && c.admin.id !== PROVISIONING_ADMIN_ID) {
		const problem = input.expiresAt === null
			? 'a rotated key keeps its expiry, or takes one at most 30 days ahead; a key is never made to last forever'
			: keyExpiryProblem(input.expiresAt, nowSeconds)
		if (problem !== null) {
			return fail(400, problem)
		}
	}
	// The new secret holds the principal's grants, so a machine caller meets the mode of where they act.
	await requireCredentialsMode(c, await heldReach(c, principalId))
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
	scopeValues: z.array(z.string()).optional().catch(undefined),
	app: z.string().nullable().optional().catch(undefined),
	expiresAt: z.number().finite().optional().catch(undefined),
}).transform(({ label, type, roleKey, permissions, scopeType, scopeValue, scopeValues, app, expiresAt }) => {
	return {
		label,
		type,
		...(roleKey !== undefined ? { roleKey } : {}),
		...(permissions !== undefined ? { permissions } : {}),
		...(scopeType !== undefined ? { scopeType } : {}),
		...(scopeValue !== undefined ? { scopeValue } : {}),
		...(scopeValues !== undefined ? { scopeValues } : {}),
		...(app !== undefined ? { app } : {}),
		...(expiresAt !== undefined ? { expiresAt } : {}),
	}
})

export function parseProvisionApiKeyRequest(body: unknown): ProvisionApiKeyRequest {
	const parsed = provisionApiKeyRequestSchema.safeParse(body)
	if (!parsed.success) return fail(400, 'label and type=service required')
	return parsed.data
}
