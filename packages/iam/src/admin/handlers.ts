import type { AppSchema, IssueKeyInput, KeyGrant, PermissionEntry, PrincipalType, RoleDef } from '@fabrika/auth-core'
import { API_KEY_PREFIX, isActionAllowed } from '@fabrika/auth-core'
import type {
	ApiKeyDto,
	AppDto,
	AppInput,
	AppSchemaDto,
	AuditEventDto,
	AuthLogDto,
	CreateGrantRequest,
	CreatePolicyInput,
	CursorList,
	GrantDto,
	InviteRequest,
	IssuedShareLinkResponse,
	IssueShareLinkRequest,
	ListApiKeysInput,
	ListAuditInput,
	ListAuthLogInput,
	ListPrincipalsInput,
	ListRolesInput,
	ListShareLinksInput,
	MeDto,
	OkResponse,
	PasswordActionDelivery,
	PolicyDto,
	PrincipalDetail,
	PrincipalListItem,
	ProvisionApiKeyRequest,
	ProvisionApiKeyResponse,
	ReturnOriginsDto,
	RoleDto,
	RotateApiKeyInput,
	RotateApiKeyResponse,
	SetReturnOriginsRequest,
	ShareLinkListItem,
	UpdatePolicyInput,
	UpdatePrincipalInput,
} from '@fabrika/iam-contract'
import {
	type AuditEventRow,
	type AuthLogRow,
	type CredentialGrantRow,
	type CredentialRow,
	type GrantRow,
	type PrincipalRow,
	principalStatus,
	type RoleRow,
} from '../db'
import { normalizeEmailIdentity } from '../email-identity'
import type { RequestContext } from '../env'
import { normalizeOrigin } from '../handoff'
import { issueKey } from '../issue'
import { arrayField, booleanField, nullableStringField, numberField, parseJsonOrNull, prop, stringField } from '../json'
import { deliverPasswordAction, issuePasswordAction } from '../password-service'
import { computePermissions } from '../resolve'
import { BUILTIN_ROLES, isKnownRole, makeRoleSource } from '../roles'
import { generateToken, hashToken } from '../secret'
import type { Services } from '../services'
import { error, json, readJson } from './http'

/**
 * Context every admin handler receives: the resolved admin caller (already gated
 * on `iam.admin` by the router), the request, parsed URL, and the verified app id
 * for audit labeling.
 */
export interface AdminContext {
	services: Services
	request: Request
	url: URL
	/** The resolved admin caller (already gated on `iam.admin`). `label` is null for a label-less key. */
	admin: { id: string; type: PrincipalType; label: string | null; permissions: PermissionEntry[] }
	/** propustka's own app id — the audience the admin was resolved against; used for audit labeling. */
	app: string
	/** Correlation id supplied by the proxy/edge or generated at IAM. */
	requestId: string
	ctx: RequestContext
}

/** Structural domain failure shared by REST adapters and the RPC dispatcher. */
export class AdminUseCaseError extends Error {
	readonly httpStatus: number
	readonly type: string

	constructor(httpStatus: number, message: string) {
		super(message)
		this.name = 'AdminUseCaseError'
		this.httpStatus = httpStatus
		this.type = httpStatus === 400
			? 'bad_request'
			: httpStatus === 404
			? 'not_found'
			: httpStatus === 409
			? 'conflict'
			: httpStatus === 403
			? 'forbidden'
			: 'error'
	}
}

function fail(status: number, message: string): never {
	throw new AdminUseCaseError(status, message)
}

// ── DTO mappers ───────────────────────────────────────────────────────────────

function toPrincipalListItem(row: PrincipalRow): PrincipalListItem {
	return {
		id: row.id,
		type: row.type,
		label: row.label,
		email: row.email,
		externalId: row.external_id,
		status: principalStatus(row),
		createdAt: row.created_at,
	}
}

/** Parse a `roles` row's JSON permissions into a string array (fail-closed on junk, incl. unparseable text). */
function rolePermissions(json: string): string[] {
	const parsed = parseJsonOrNull(json)
	if (!Array.isArray(parsed)) {
		return []
	}
	return parsed.filter((p): p is string => typeof p === 'string')
}

/**
 * Loads (and memoizes) an app's role_key set on demand so DTO mappers can flag
 * dangling role grants without re-querying per row. A grant/mapping with `app = null`
 * (cross-app) is checked against the built-ins only — there is no per-app row set.
 */
class RoleKnownCache {
	private readonly perApp = new Map<string, Set<string>>()

	constructor(private readonly services: Services) {}

	private async appRoleKeys(app: string): Promise<Set<string>> {
		const cached = this.perApp.get(app)
		if (cached) {
			return cached
		}
		const rows = await this.services.repositories.appSchema.listRoles(app)
		const keys = new Set(rows.map((r) => r.role_key))
		this.perApp.set(app, keys)
		return keys
	}

	/** True iff `roleKey` resolves for `app` — a built-in, or a row in the app's roles. */
	async isKnown(roleKey: string, app: string | null): Promise<boolean> {
		if (Object.hasOwn(BUILTIN_ROLES, roleKey)) {
			return true
		}
		if (app === null) {
			return false
		}
		return (await this.appRoleKeys(app)).has(roleKey)
	}
}

async function toGrantDto(row: GrantRow, roleCache: RoleKnownCache): Promise<GrantDto> {
	const dangling = row.role_key !== null && !(await roleCache.isKnown(row.role_key, row.app))
	return {
		id: row.id,
		principalId: row.principal_id,
		roleKey: row.role_key,
		permissions: row.permissions === null ? null : rolePermissions(row.permissions),
		scopeType: row.scope_type,
		scopeValue: row.scope_value,
		app: row.app,
		grantedBy: row.granted_by,
		expiresAt: row.expires_at,
		createdAt: row.created_at,
		dangling,
	}
}

/** Map a list of grant rows to DTOs sharing one role-known cache (one query per app). */
async function toGrantDtos(rows: GrantRow[], services: Services, cache: RoleKnownCache = new RoleKnownCache(services)): Promise<GrantDto[]> {
	const out: GrantDto[] = []
	for (const row of rows) {
		out.push(await toGrantDto(row, cache))
	}
	return out
}

/** Group rows by a key, preserving order — how a single page-wide query becomes per-row lists. */
function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
	const out = new Map<string, T[]>()
	for (const row of rows) {
		const bucket = out.get(key(row))
		if (bucket === undefined) {
			out.set(key(row), [row])
		} else {
			bucket.push(row)
		}
	}
	return out
}

/** The set of app ids propustka knows about — the live registry derived from the schema tables. */
function knownApps(c: AdminContext): Promise<string[]> {
	return c.services.repositories.appSchema.listKnownApps()
}

/** Validate an admin-supplied `app`: null (all apps) or a known (registered) app. */
async function appField(c: AdminContext, body: unknown): Promise<{ ok: true; app: string | null } | { ok: false }> {
	const app = nullableStringField(body, 'app') ?? null
	if (app !== null && !(await knownApps(c)).includes(app)) {
		return { ok: false }
	}
	return { ok: true, app }
}

function toAuditEventDto(row: AuditEventRow): AuditEventDto {
	return {
		id: row.id,
		requestId: row.request_id,
		principalId: row.principal_id,
		principalLabel: row.principal_label,
		credentialId: row.credential_id,
		app: row.app,
		action: row.action,
		resourceType: row.resource_type,
		resourceId: row.resource_id,
		// Unparseable JSON reads as null rather than throwing — the DB no longer guarantees
		// validity (the `json_valid` CHECK was SQLite-only; see `parseJsonOrNull`).
		diff: row.diff === null ? null : parseJsonOrNull(row.diff),
		metadata: row.metadata === null ? null : parseJsonOrNull(row.metadata),
		createdAt: row.created_at,
	}
}

function toAuthLogDto(row: AuthLogRow): AuthLogDto {
	return {
		// The one backend-dependent column: a `number` on D1, a `string` on Postgres (a BIGINT identity,
		// which Bun decodes by column OID). Normalised HERE, once, so the DTO stays a plain number for
		// the SPA and for the `before=` cursor. Precision holds to 2^53 rows, far past any real auth log.
		id: typeof row.id === 'string' ? Number(row.id) : row.id,
		requestId: row.request_id,
		app: row.app,
		kind: row.kind,
		principalId: row.principal_id,
		credentialId: row.credential_id,
		decision: row.decision,
		reason: row.reason,
		createdAt: row.created_at,
	}
}

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

// Audit-event writes from admin actions happen on the request critical path so the
// admin sees a consistent state, but the write itself is small; we await it.
function adminAudit(
	c: AdminContext,
	event: { action: string; resourceType: string; resourceId?: string | null; diff?: unknown; metadata?: unknown },
): Promise<void> {
	return c.services.repositories.audit.writeAuditEvent({
		requestId: c.requestId,
		principalId: c.admin.id,
		principalLabel: c.admin.label ?? c.admin.id,
		app: c.app,
		action: event.action,
		resourceType: event.resourceType,
		resourceId: event.resourceId ?? null,
		diff: event.diff,
		metadata: event.metadata,
	})
}

// ── Me ────────────────────────────────────────────────────────────────────────

export function handleMe(c: AdminContext): Response {
	return json(adminUseCases.me(c))
}

function me(c: AdminContext): MeDto {
	const me: MeDto = {
		id: c.admin.id,
		type: c.admin.type,
		label: c.admin.label ?? c.admin.id,
		permissions: c.admin.permissions,
	}
	return me
}

// ── Principals ────────────────────────────────────────────────────────────────

export async function listPrincipals(c: AdminContext): Promise<Response> {
	const typeParam = c.url.searchParams.get('type')
	const statusParam = c.url.searchParams.get('status')
	if (statusParam !== null && statusParam !== 'invited' && statusParam !== 'active' && statusParam !== 'disabled') {
		return json({ items: [], nextCursor: null })
	}
	const q = c.url.searchParams.get('q') ?? undefined
	const before = c.url.searchParams.get('before') ?? undefined
	const type = typeParam === 'user' || typeParam === 'service' ? typeParam : undefined
	const status = statusParam === 'invited' || statusParam === 'active' || statusParam === 'disabled' ? statusParam : undefined
	return json(
		await adminUseCases.listPrincipals(c, {
			type,
			status,
			...(q ? { q } : {}),
			...(before ? { before } : {}),
			limit: parseLimit(c.url),
		}),
	)
}

async function listPrincipalsUseCase(c: AdminContext, input: ListPrincipalsInput): Promise<CursorList<PrincipalListItem>> {
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

/** The `before` value for the next page, or null when this page is the last one. */
function cursorOf<T>(items: readonly T[], limit: number, id: (item: T) => string): string | null {
	const last = items.at(-1)
	return items.length === limit && last !== undefined ? id(last) : null
}

export async function getPrincipal(c: AdminContext, id: string): Promise<Response> {
	return json(await adminUseCases.getPrincipal(c, { id }))
}

async function getPrincipalUseCase(c: AdminContext, input: { id: string }): Promise<PrincipalDetail> {
	const id = input.id
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
async function effectivePermissionsForAdmin(c: AdminContext, row: PrincipalRow): Promise<PermissionEntry[]> {
	const app: string | null = c.app
	const grants = await c.services.repositories.grants.getActiveGrantsForApp(row.id, app)
	const isBootstrapAdmin = row.type === 'user' && row.email !== null
		&& c.services.config.bootstrapAdmins.has(normalizeEmailIdentity(row.email))
	const appRoles: Record<string, RoleDef> = {}
	for (const dbRole of await c.services.repositories.appSchema.listRoles(app)) {
		appRoles[dbRole.role_key] = dbRoleToDef(dbRole)
	}
	const roleSource = makeRoleSource(appRoles)
	return computePermissions({ app, grants, isBootstrapAdmin }, roleSource)
}

/** A `roles` row → core `RoleDef` for resolution. */
function dbRoleToDef(row: RoleRow): RoleDef {
	return {
		name: row.name,
		...(row.description !== null ? { description: row.description } : {}),
		permissions: rolePermissions(row.permissions),
	}
}

/** Load an app's DB roles into a role_key -> RoleDef map (empty for app=null). */
async function loadAppRoleMap(c: AdminContext, app: string | null): Promise<Record<string, RoleDef>> {
	const map: Record<string, RoleDef> = {}
	if (app !== null) {
		for (const row of await c.services.repositories.appSchema.listRoles(app)) {
			map[row.role_key] = dbRoleToDef(row)
		}
	}
	return map
}

export async function invitePrincipal(c: AdminContext): Promise<Response> {
	const body = await readJson(c.request)
	const email = stringField(body, 'email')
	if (!email) {
		return error(400, 'email required')
	}
	return json(await adminUseCases.invitePrincipal(c, { email }), { status: 201 })
}

async function invitePrincipalUseCase(c: AdminContext, input: InviteRequest): Promise<PrincipalListItem> {
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
		principal = await c.services.repositories.principals.inviteUser(normalizedEmail, email)
	} catch (cause) {
		if ((await c.services.repositories.passwords.lookupActionUser(normalizedEmail)).status !== 'missing') {
			return fail(409, 'a user with this email already exists')
		}
		throw cause
	}
	await adminAudit(c, {
		action: 'iam.principal.invite',
		resourceType: 'principal',
		resourceId: principal.id,
		metadata: { email },
	})
	return toPrincipalListItem(principal)
}

export async function deletePrincipal(c: AdminContext, id: string): Promise<Response> {
	const row = await c.services.repositories.principals.getPrincipalById(id)
	if (!row) {
		return error(404, 'principal not found')
	}
	const status = principalStatus(row)
	if (status === 'invited') {
		// Unclaimed invite → cancel it (hard-delete; nothing references it yet).
		await c.services.repositories.principals.deletePrincipal(id)
		await adminAudit(c, { action: 'iam.principal.invite_cancel', resourceType: 'principal', resourceId: id })
		return json({ ok: true })
	}
	// Claimed principal → soft-disable (preserve audit history & grant references).
	await c.services.repositories.principals.disablePrincipal(id)
	await adminAudit(c, { action: 'iam.principal.disable', resourceType: 'principal', resourceId: id })
	return json({ ok: true })
}

export async function patchPrincipal(c: AdminContext, id: string): Promise<Response> {
	const body = await readJson(c.request)
	const disabled = booleanField(body, 'disabled')
	if (disabled === undefined) {
		return error(400, 'disabled (boolean) required')
	}
	return json(await adminUseCases.updatePrincipal(c, { id, disabled }))
}

async function updatePrincipalUseCase(c: AdminContext, input: UpdatePrincipalInput): Promise<PrincipalListItem> {
	const { id, disabled } = input
	const row = await c.services.repositories.principals.getPrincipalById(id)
	if (!row) {
		return fail(404, 'principal not found')
	}
	if (disabled) {
		await c.services.repositories.principals.disablePrincipal(id)
		await adminAudit(c, { action: 'iam.principal.disable', resourceType: 'principal', resourceId: id })
	} else {
		await c.services.repositories.principals.enablePrincipal(id)
		await adminAudit(c, { action: 'iam.principal.enable', resourceType: 'principal', resourceId: id })
	}
	const updated = await c.services.repositories.principals.getPrincipalById(id)
	if (!updated) return fail(404, 'principal not found')
	return toPrincipalListItem(updated)
}

// ── Password authentication ──────────────────────────────────────────────────

async function passwordUser(c: AdminContext, id: string, requireActive: boolean = true): Promise<PrincipalRow> {
	if (!c.services.config.authentication.password.enabled) {
		return fail(409, 'password authentication is not available')
	}
	const principal = await c.services.repositories.principals.getPrincipalById(id)
	if (!principal) return fail(404, 'principal not found')
	if (principal.type !== 'user') return fail(400, 'password authentication is available only for users')
	if (principal.email === null) return fail(409, 'user has no email address')
	if (requireActive && principal.disabled_at !== null) return fail(409, 'principal is disabled')
	return principal
}

async function passwordDelivery(
	c: AdminContext,
	principal: PrincipalRow,
	purpose: 'enrollment' | 'reset',
): Promise<PasswordActionDelivery> {
	const action = await issuePasswordAction(c.services, { principal, purpose, issuedBy: c.admin.id })
	if (c.services.email === null) {
		await adminAudit(c, {
			action: `iam.password.${purpose}.issue`,
			resourceType: 'principal',
			resourceId: principal.id,
			metadata: { delivery: 'manual', outcome: 'issued' },
		})
		return { delivery: 'manual', url: action.url, expiresAt: action.expiresAt }
	}
	if (action.message === null || principal.email === null) {
		return fail(409, 'user has no email address')
	}
	try {
		await deliverPasswordAction(c.services, action)
	} catch {
		console.error('Password action email delivery failed')
		await adminAudit(c, {
			action: `iam.password.${purpose}.issue`,
			resourceType: 'principal',
			resourceId: principal.id,
			metadata: { delivery: 'email', outcome: 'failed' },
		})
		return fail(502, 'password action email delivery failed')
	}
	await adminAudit(c, {
		action: `iam.password.${purpose}.issue`,
		resourceType: 'principal',
		resourceId: principal.id,
		metadata: { delivery: 'email', outcome: 'sent' },
	})
	return { delivery: 'email', email: principal.email, expiresAt: action.expiresAt }
}

async function issuePasswordEnrollmentUseCase(c: AdminContext, input: { id: string }): Promise<PasswordActionDelivery> {
	const principal = await passwordUser(c, input.id)
	const account = await c.services.repositories.passwords.getAccount(principal.id)
	if (account?.state === 'enabled') return fail(409, 'password authentication is already enabled')
	await c.services.repositories.passwords.enableEnrollment(principal.id)
	return passwordDelivery(c, principal, 'enrollment')
}

async function issuePasswordResetUseCase(c: AdminContext, input: { id: string }): Promise<PasswordActionDelivery> {
	const principal = await passwordUser(c, input.id)
	const account = await c.services.repositories.passwords.getAccount(principal.id)
	if (account?.state !== 'enabled') return fail(409, 'password authentication is not enabled')
	return passwordDelivery(c, principal, 'reset')
}

async function disablePasswordUseCase(c: AdminContext, input: { id: string }): Promise<OkResponse> {
	const principal = await passwordUser(c, input.id, false)
	await c.services.repositories.passwords.disableCredential(principal.id)
	await adminAudit(c, {
		action: 'iam.password.disable',
		resourceType: 'principal',
		resourceId: principal.id,
	})
	return { ok: true }
}

// ── Grants ────────────────────────────────────────────────────────────────────

/**
 * Validate the scope coordinate on a grant/key request: `scopeType`/`scopeValue` are
 * both-or-neither (both null = global). A half-set pair is a 400.
 */
function parseScope(body: unknown): { ok: true; scopeType: string | null; scopeValue: string | null } | { ok: false } {
	const scopeType = nullableStringField(body, 'scopeType') ?? null
	const scopeValue = nullableStringField(body, 'scopeValue') ?? null
	if ((scopeType === null) !== (scopeValue === null)) {
		return { ok: false }
	}
	return { ok: true, scopeType, scopeValue }
}

/**
 * Validate the role-or-inline choice for a grant/key against the app: EXACTLY one of
 * `roleKey` / `permissions`. A `roleKey` must be a known role for the app (built-in
 * `admin` OR a `roles` row). Inline `permissions` must each be a pattern the relevant
 * action catalog knows. Returns a normalized result or an error message for a 400.
 */
async function parseRoleOrInline(
	c: AdminContext,
	body: unknown,
	app: string | null,
): Promise<{ ok: true; roleKey: string | null; permissions: string[] | null } | { ok: false; message: string }> {
	const roleKey = stringField(body, 'roleKey')
	const permissions = arrayField(body, 'permissions')
	if ((roleKey === undefined) === (permissions === undefined)) {
		return { ok: false, message: 'exactly one of roleKey or permissions is required' }
	}
	if (roleKey !== undefined) {
		if (!isKnownRole(roleKey, await loadAppRoleMap(c, app))) {
			return { ok: false, message: `unknown role: ${roleKey}` }
		}
		return { ok: true, roleKey, permissions: null }
	}
	// Inline permissions: validate each pattern against the app's action catalog.
	if (permissions === undefined || permissions.length === 0) {
		return { ok: false, message: 'permissions must be a non-empty array of action patterns' }
	}
	const catalog = await actionCatalog(c, app)
	for (const pattern of permissions) {
		if (!isActionAllowed(pattern, catalog)) {
			return {
				ok: false,
				message: app === null
					? `no registered app declares the action pattern '${pattern}'. This check catches typos, it is not a security boundary — `
						+ 'a cross-app grant is matched by pattern at request time, so it also covers an app registered later.'
					: `unknown action pattern: ${pattern}`,
			}
		}
	}
	return { ok: true, roleKey: null, permissions }
}

/**
 * The catalog an inline pattern is validated against: one app's actions, or — for a CROSS-APP grant —
 * the union of every registered app's catalog.
 *
 * A cross-app grant has no single catalog, and the previous code substituted an empty one, which made
 * `isActionAllowed` refuse everything except `*`. That inverted least privilege: an operator who
 * wanted `deploy.read` everywhere had to grant everything instead (CORR-10). The union is the right
 * comparison and it is honest about what it is — a TYPO CHECK, not a boundary. `permits()` matches
 * patterns at request time and never pre-expands them, so an app registered tomorrow is covered by a
 * cross-app grant written today whatever this function said.
 */
async function actionCatalog(c: AdminContext, app: string | null): Promise<string[]> {
	if (app !== null) {
		return c.services.repositories.appSchema.listActionCatalog(app)
	}
	const catalog = new Set<string>()
	for (const known of await knownApps(c)) {
		for (const action of await c.services.repositories.appSchema.listActionCatalog(known)) {
			catalog.add(action)
		}
	}
	return [...catalog]
}

export async function createGrant(c: AdminContext): Promise<Response> {
	const body = await readJson(c.request)
	const principalId = stringField(body, 'principalId')
	if (!principalId) {
		return error(400, 'principalId required')
	}
	return json(await adminUseCases.createGrant(c, parseCreateGrantRequest(body)), { status: 201 })
}

async function createGrantUseCase(c: AdminContext, input: CreateGrantRequest): Promise<GrantDto> {
	const principalId = input.principalId
	if (principalId.trim() === '') return fail(400, 'principalId required')
	const body: unknown = input
	const appResult = await appField(c, body)
	if (!appResult.ok) {
		return fail(400, 'unknown app')
	}
	const app = appResult.app
	const roleOrInline = await parseRoleOrInline(c, body, app)
	if (!roleOrInline.ok) {
		return fail(400, roleOrInline.message)
	}
	const scope = parseScope(body)
	if (!scope.ok) {
		return fail(400, 'scopeType and scopeValue must be both set or both omitted')
	}
	const expiresAt = numberField(body, 'expiresAt') ?? null
	const principal = await c.services.repositories.principals.getPrincipalById(principalId)
	if (!principal) {
		return fail(404, 'principal not found')
	}
	const grant = await c.services.repositories.grants.createGrant({
		principalId,
		app,
		roleKey: roleOrInline.roleKey,
		permissions: roleOrInline.permissions,
		scopeType: scope.scopeType,
		scopeValue: scope.scopeValue,
		grantedBy: c.admin.id,
		expiresAt,
	})
	await adminAudit(c, {
		action: 'iam.grant.create',
		resourceType: 'grant',
		resourceId: grant.id,
		metadata: {
			principalId,
			roleKey: roleOrInline.roleKey,
			permissions: roleOrInline.permissions,
			scopeType: scope.scopeType,
			scopeValue: scope.scopeValue,
			app,
		},
	})
	const cache = new RoleKnownCache(c.services)
	return toGrantDto(grant, cache)
}

export async function deleteGrant(c: AdminContext, id: string): Promise<Response> {
	return json(await adminUseCases.deleteGrant(c, { id }))
}

async function deleteGrantUseCase(c: AdminContext, input: { id: string }): Promise<OkResponse> {
	const id = input.id
	const grant = await c.services.repositories.grants.getGrantById(id)
	if (!grant) {
		return fail(404, 'grant not found')
	}
	await c.services.repositories.grants.deleteGrant(id)
	await adminAudit(c, {
		action: 'iam.grant.revoke',
		resourceType: 'grant',
		resourceId: id,
		metadata: {
			principalId: grant.principal_id,
			roleKey: grant.role_key,
			scopeType: grant.scope_type,
			scopeValue: grant.scope_value,
		},
	})
	return { ok: true }
}

// ── Apps (read-only; the live registry derived from the schema tables) ────────

/** The app ids a grant can be scoped to — the apps that have registered a vocabulary. */
export async function listApps(c: AdminContext): Promise<Response> {
	return json(await adminUseCases.listApps(c))
}

async function listAppsUseCase(c: AdminContext): Promise<{ items: AppDto[] }> {
	const items: AppDto[] = (await knownApps(c)).map((id) => ({ id }))
	return { items }
}

// ── Roles (grantable role list for an app) ────────────────────────────────────

/**
 * The roles available to grant for an app: the built-ins (cross-app, e.g. `admin`)
 * plus the app's DB roles (origin 'app' + 'custom'). The app is taken from the `?app`
 * query param (a registered app id); without it, only built-ins are listed. Built-ins
 * win on a key collision so an app cannot shadow the cross-app `admin`.
 */
export async function listRoles(c: AdminContext): Promise<Response> {
	const appParam = c.url.searchParams.get('app')
	return json(await adminUseCases.listRoles(c, { app: appParam }))
}

async function listRolesUseCase(c: AdminContext, input: ListRolesInput): Promise<{ items: RoleDto[] }> {
	const items: RoleDto[] = []
	const appParam = input.app ?? null
	const app = appParam !== null && (await knownApps(c)).includes(appParam) ? appParam : null
	const builtinKeys = new Set(Object.keys(BUILTIN_ROLES))
	if (app !== null) {
		for (const row of await c.services.repositories.appSchema.listRoles(app)) {
			if (builtinKeys.has(row.role_key)) {
				continue // a built-in shadows any same-key DB row in the grantable list
			}
			items.push({
				key: row.role_key,
				name: row.name,
				...(row.description !== null ? { description: row.description } : {}),
				permissions: rolePermissions(row.permissions),
				origin: row.origin,
			})
		}
	}
	for (const [key, role] of Object.entries(BUILTIN_ROLES)) {
		items.push({
			key,
			name: role.name,
			...(role.description ? { description: role.description } : {}),
			permissions: role.permissions,
			origin: 'builtin',
		})
	}
	return { items }
}

// ── App schema (reconciled vocabulary) ────────────────────────────────────────

/**
 * Validate that a value is a well-formed `AppSchema` (scopes/actions/roles arrays of
 * the right shape) and return it normalized, or an error message. Each role's
 * permission patterns are validated against the body's OWN action catalog via
 * `isActionAllowed` — an unknown action is a 400.
 */
function parseAppSchema(body: unknown): { ok: true; schema: AppSchema } | { ok: false; message: string } {
	const scopesRaw = prop(body, 'scopes')
	const actionsRaw = prop(body, 'actions')
	const rolesRaw = prop(body, 'roles')
	if (!Array.isArray(scopesRaw) || !Array.isArray(actionsRaw)) {
		return { ok: false, message: 'scopes and actions must be arrays' }
	}
	if (typeof rolesRaw !== 'object' || rolesRaw === null || Array.isArray(rolesRaw)) {
		return { ok: false, message: 'roles must be an object (role_key -> def)' }
	}

	const scopes: AppSchema['scopes'] = []
	for (const item of scopesRaw) {
		const type = stringField(item, 'type')
		if (type === undefined) {
			return { ok: false, message: 'each scope needs a string `type`' }
		}
		const label = stringField(item, 'label')
		scopes.push({ type, ...(label !== undefined ? { label } : {}) })
	}

	const actions: AppSchema['actions'] = []
	const catalog: string[] = []
	for (const item of actionsRaw) {
		const action = stringField(item, 'action')
		if (action === undefined) {
			return { ok: false, message: 'each action needs a string `action`' }
		}
		const description = stringField(item, 'description')
		actions.push({ action, ...(description !== undefined ? { description } : {}) })
		catalog.push(action)
	}

	const roles: AppSchema['roles'] = {}
	for (const [key, defRaw] of Object.entries(rolesRaw)) {
		const name = stringField(defRaw, 'name')
		const permissions = arrayField(defRaw, 'permissions')
		if (name === undefined || permissions === undefined) {
			return { ok: false, message: `role '${key}' needs a string name and a permissions array` }
		}
		for (const pattern of permissions) {
			if (!isActionAllowed(pattern, catalog)) {
				return { ok: false, message: `role '${key}' references unknown action: ${pattern}` }
			}
		}
		const description = stringField(defRaw, 'description')
		roles[key] = { name, permissions, ...(description !== undefined ? { description } : {}) }
	}

	return { ok: true, schema: { scopes, actions, roles } }
}

/**
 * Reconcile an app's declared vocabulary (idempotent): upsert its scopes/actions and
 * origin='app' roles, delete app-origin rows absent from the body, and NEVER touch
 * origin='custom' roles. Every role's patterns are validated against the body's own
 * action catalog. The `:app` path segment is the app id this vocabulary belongs to.
 */
export async function putAppSchema(c: AdminContext, app: string): Promise<Response> {
	// No knownApps gate: an app's FIRST schema reconcile is how it REGISTERS itself (this endpoint is
	// admin-gated). After this, `db.listKnownApps()` surfaces the app id across the schema tables.
	const body = await readJson(c.request)
	const parsed = parseAppSchema(body)
	if (!parsed.ok) {
		return error(400, parsed.message)
	}
	const { schema } = parsed
	// A role key an admin already owns as a custom policy is a CONFLICT, not something to overwrite.
	// The rule was one-directional: `createPolicyUseCase` 409s on an existing key so an admin can never
	// clobber an app role, but a deploy silently flipped a custom policy to origin='app' — after which
	// update and delete both 404 and the policy is unmanageable (SEC-3). Refused here, loudly, so the
	// deploy fails with the collision named rather than quietly rewriting somebody's policy.
	const collisions: string[] = []
	for (const row of await c.services.repositories.appSchema.listRoles(app)) {
		if (row.origin === 'custom' && Object.hasOwn(schema.roles, row.role_key)) {
			collisions.push(row.role_key)
		}
	}
	if (collisions.length > 0) {
		return error(
			409,
			`the app declares role ${collisions.map((key) => `'${key}'`).join(', ')}, which already exists as an admin-composed custom policy. `
				+ 'Rename the declared role or delete the policy; a deploy never overwrites one.',
		)
	}
	await c.services.repositories.appSchema.reconcileAppSchema({
		app,
		scopes: schema.scopes.map((s) => ({ scopeType: s.type, label: s.label ?? null })),
		actions: schema.actions.map((a) => ({ action: a.action, description: a.description ?? null })),
		roles: Object.entries(schema.roles).map(([roleKey, def]) => ({
			roleKey,
			name: def.name,
			description: def.description ?? null,
			permissions: def.permissions,
		})),
	})
	await adminAudit(c, {
		action: 'iam.app.schema.reconcile',
		resourceType: 'app',
		resourceId: app,
		metadata: {
			scopes: schema.scopes.length,
			actions: schema.actions.length,
			roles: Object.keys(schema.roles),
		},
	})
	return json(await readAppSchemaDto(c, app))
}

/** Read the app's scopes, actions, and origin='app' roles into a DTO (no auth gate). */
async function readAppSchemaDto(c: AdminContext, app: string): Promise<AppSchemaDto> {
	const scopeRows = await c.services.repositories.appSchema.listAppScopes(app)
	const actionRows = await c.services.repositories.appSchema.listAppActions(app)
	const roleRows = await c.services.repositories.appSchema.listRolesByOrigin(app, 'app')
	const roles: Record<string, RoleDef> = {}
	for (const row of roleRows) {
		roles[row.role_key] = dbRoleToDef(row)
	}
	return {
		app,
		scopes: scopeRows.map((r) => ({ type: r.scope_type, ...(r.label !== null ? { label: r.label } : {}) })),
		actions: actionRows.map((r) => ({ action: r.action, ...(r.description !== null ? { description: r.description } : {}) })),
		roles,
	}
}

/** Return the app's scopes, actions, and origin='app' roles (the reconciled vocabulary). */
export async function getAppSchema(c: AdminContext, app: string): Promise<Response> {
	return json(await adminUseCases.getAppSchema(c, { app }))
}

/**
 * Replace an app's registered return origins (ADR-0021). Every value is canonicalized before it is
 * stored, so the comparison at issue time is against one spelling and an operator cannot register
 * `https://App.Example.com/` and then wonder why `https://app.example.com` is refused.
 *
 * The app is validated FIRST, so a typo in the app id is reported as a typo in the app id rather than
 * as an origin problem. An EMPTY set is refused as a caller error: it is indistinguishable from an
 * app that never registered, and reaching that state through this endpoint is always a mistake.
 */
async function setReturnOriginsUseCase(c: AdminContext, input: SetReturnOriginsRequest): Promise<ReturnOriginsDto> {
	if (!(await knownApps(c)).includes(input.app)) {
		return fail(404, 'unknown app')
	}
	if (input.origins.length === 0) {
		return fail(400, 'at least one origin is required')
	}
	const origins: string[] = []
	for (const raw of input.origins) {
		const normalized = normalizeOrigin(raw)
		if (normalized === null) {
			return fail(400, `not an absolute http(s) origin: ${raw}`)
		}
		if (!origins.includes(normalized)) {
			origins.push(normalized)
		}
	}
	await c.services.repositories.handoff.setReturnOrigins(input.app, origins)
	await adminAudit(c, {
		action: 'iam.app.return-origins.set',
		resourceType: 'app',
		resourceId: input.app,
		metadata: { origins },
	})
	return { app: input.app, origins }
}

/**
 * Read an app's registered return origins. The registry was writable but never readable, so an
 * operator could only find out what a cross-host sign-in would accept by attempting one (COMP-4).
 */
async function getReturnOriginsUseCase(c: AdminContext, input: AppInput): Promise<ReturnOriginsDto> {
	if (!(await knownApps(c)).includes(input.app)) {
		return fail(404, 'unknown app')
	}
	return { app: input.app, origins: await c.services.repositories.handoff.listReturnOrigins(input.app) }
}

/**
 * Un-register every return origin for an app — an OPERATION, not an empty array.
 *
 * `setReturnOrigins` refuses an empty set (SEC-12) because an empty set is what an app that never
 * registered looks like, and reaching that state by accident strands every cross-host sign-in. But
 * refusing it also left an operator with no way back out through the API at all: clearing was
 * possible only by deleting rows. So clearing is its own named call, which cannot be arrived at by a
 * caller that meant to send one origin and sent none.
 */
async function clearReturnOriginsUseCase(c: AdminContext, input: AppInput): Promise<ReturnOriginsDto> {
	if (!(await knownApps(c)).includes(input.app)) {
		return fail(404, 'unknown app')
	}
	await c.services.repositories.handoff.setReturnOrigins(input.app, [])
	await adminAudit(c, {
		action: 'iam.app.return-origins.clear',
		resourceType: 'app',
		resourceId: input.app,
	})
	return { app: input.app, origins: [] }
}

async function getAppSchemaUseCase(c: AdminContext, input: AppInput): Promise<AppSchemaDto> {
	const app = input.app
	if (!(await knownApps(c)).includes(app)) {
		return fail(404, 'unknown app')
	}
	return readAppSchemaDto(c, app)
}

// ── Policies (origin='custom' roles) ──────────────────────────────────────────

function toPolicyDto(row: RoleRow): PolicyDto {
	return {
		app: row.app,
		key: row.role_key,
		name: row.name,
		...(row.description !== null ? { description: row.description } : {}),
		permissions: rolePermissions(row.permissions),
		createdAt: row.created_at,
	}
}

/** List an app's custom policies (origin='custom' role rows). */
export async function listPolicies(c: AdminContext, app: string): Promise<Response> {
	return json(await adminUseCases.listPolicies(c, { app }))
}

async function listPoliciesUseCase(c: AdminContext, input: AppInput): Promise<{ items: PolicyDto[] }> {
	const app = input.app
	if (!(await knownApps(c)).includes(app)) {
		return fail(404, 'unknown app')
	}
	const rows = await c.services.repositories.appSchema.listRolesByOrigin(app, 'custom')
	return { items: rows.map(toPolicyDto) }
}

/**
 * Validate a policy body's action patterns against the app's catalog (`app_actions`),
 * returning normalized fields or an error message. Shared by create + update.
 */
async function parsePolicyBody(
	c: AdminContext,
	app: string,
	body: unknown,
	requireKey: boolean,
): Promise<{ ok: true; key: string | undefined; name: string; description: string | null; permissions: string[] } | { ok: false; message: string }> {
	const key = stringField(body, 'key')
	const name = stringField(body, 'name')
	const permissions = arrayField(body, 'permissions')
	if (requireKey && key === undefined) {
		return { ok: false, message: 'key required' }
	}
	if (name === undefined || permissions === undefined) {
		return { ok: false, message: 'name and permissions (array) required' }
	}
	if (permissions.length === 0) {
		return { ok: false, message: 'permissions must be a non-empty array of action patterns' }
	}
	// A custom policy must not collide with a built-in role key.
	if (key !== undefined && Object.hasOwn(BUILTIN_ROLES, key)) {
		return { ok: false, message: `'${key}' is a reserved built-in role key` }
	}
	const catalog = await c.services.repositories.appSchema.listActionCatalog(app)
	for (const pattern of permissions) {
		if (!isActionAllowed(pattern, catalog)) {
			return { ok: false, message: `unknown action pattern: ${pattern}` }
		}
	}
	const description = stringField(body, 'description') ?? null
	return { ok: true, key, name, description, permissions }
}

/** Create a custom policy (origin='custom' role). Rejects a key that already exists. */
export async function createPolicy(c: AdminContext, app: string): Promise<Response> {
	if (!(await knownApps(c)).includes(app)) {
		return error(404, 'unknown app')
	}
	const body = await readJson(c.request)
	return json(await adminUseCases.createPolicy(c, { app, policy: parseCreatePolicyRequest(body) }), { status: 201 })
}

async function createPolicyUseCase(c: AdminContext, input: CreatePolicyInput): Promise<PolicyDto> {
	const { app, policy: body } = input
	if (!(await knownApps(c)).includes(app)) return fail(404, 'unknown app')
	const parsed = await parsePolicyBody(c, app, body, true)
	if (!parsed.ok) {
		return fail(400, parsed.message)
	}
	const key = parsed.key
	if (key === undefined) {
		return fail(400, 'key required')
	}
	const existing = await c.services.repositories.appSchema.getRole(app, key)
	if (existing) {
		return fail(409, `a role with key '${key}' already exists`)
	}
	const row = await c.services.repositories.appSchema.upsertRole({
		app,
		roleKey: key,
		name: parsed.name,
		description: parsed.description,
		permissions: parsed.permissions,
		origin: 'custom',
	})
	await adminAudit(c, {
		action: 'iam.policy.create',
		resourceType: 'policy',
		resourceId: `${app}/${key}`,
		metadata: { app, key, permissions: parsed.permissions },
	})
	return toPolicyDto(row)
}

/** Update a custom policy. Rejects if the key is missing or is an origin='app' role. */
export async function updatePolicy(c: AdminContext, app: string, key: string): Promise<Response> {
	if (!(await knownApps(c)).includes(app)) {
		return error(404, 'unknown app')
	}
	const existing = await c.services.repositories.appSchema.getRole(app, key)
	if (!existing || existing.origin !== 'custom') {
		return error(404, 'custom policy not found')
	}
	const body = await readJson(c.request)
	return json(await adminUseCases.updatePolicy(c, { app, key, policy: parseUpdatePolicyRequest(body) }))
}

async function updatePolicyUseCase(c: AdminContext, input: UpdatePolicyInput): Promise<PolicyDto> {
	const { app, key, policy: body } = input
	if (!(await knownApps(c)).includes(app)) {
		return fail(404, 'unknown app')
	}
	const existing = await c.services.repositories.appSchema.getRole(app, key)
	if (!existing || existing.origin !== 'custom') {
		return fail(404, 'custom policy not found')
	}
	const parsed = await parsePolicyBody(c, app, body, false)
	if (!parsed.ok) {
		return fail(400, parsed.message)
	}
	const row = await c.services.repositories.appSchema.upsertRole({
		app,
		roleKey: key,
		name: parsed.name,
		description: parsed.description,
		permissions: parsed.permissions,
		origin: 'custom',
	})
	await adminAudit(c, {
		action: 'iam.policy.update',
		resourceType: 'policy',
		resourceId: `${app}/${key}`,
		metadata: { app, key, permissions: parsed.permissions },
	})
	return toPolicyDto(row)
}

/** Delete a custom policy. Refuses to delete an origin='app' (reconciled) role. */
export async function deletePolicy(c: AdminContext, app: string, key: string): Promise<Response> {
	return json(await adminUseCases.deletePolicy(c, { app, key }))
}

async function deletePolicyUseCase(c: AdminContext, input: { app: string; key: string }): Promise<OkResponse> {
	const { app, key } = input
	if (!(await knownApps(c)).includes(app)) {
		return fail(404, 'unknown app')
	}
	const existing = await c.services.repositories.appSchema.getRole(app, key)
	if (!existing || existing.origin !== 'custom') {
		return fail(404, 'custom policy not found')
	}
	await c.services.repositories.appSchema.deleteRole(app, key)
	await adminAudit(c, {
		action: 'iam.policy.delete',
		resourceType: 'policy',
		resourceId: `${app}/${key}`,
		metadata: { app, key },
	})
	return { ok: true }
}

// ── API keys (native service credentials) ─────────────────────────────────────

export async function listApiKeys(c: AdminContext): Promise<Response> {
	const before = c.url.searchParams.get('before') ?? undefined
	return json(await adminUseCases.listApiKeys(c, { ...(before ? { before } : {}), limit: parseLimit(c.url) }))
}

/**
 * One page of service principals with their grants. TWO queries per page, whatever the page holds:
 * the roster read, and one grants read for the page's ids. It used to be 1+N over an unbounded
 * roster, with no pagination at all (SEC-22).
 */
async function listApiKeysUseCase(c: AdminContext, input: ListApiKeysInput): Promise<CursorList<ApiKeyDto>> {
	const limit = normalizeLimit(input.limit)
	const principals = await c.services.repositories.principals.listPrincipals({
		type: 'service',
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

/**
 * Provision an API key: create a native service principal + grant and mint a `px_`
 * credential bound to it — resolved by the propustka-native path (`mintFromKey`), no
 * Cloudflare Access in front. The plaintext `px_` token is returned ONCE.
 *
 * There is no distributed transaction; the writes are local D1 (principal → grant →
 * credential). A failure partway leaves an orphan principal at worst — harmless (it
 * holds no live credential) and revocable from this page.
 */
export async function provisionApiKey(c: AdminContext): Promise<Response> {
	const body = await readJson(c.request)
	const label = stringField(body, 'label')
	const type = stringField(body, 'type')
	if (!label || type !== 'service') {
		return error(400, 'label and type=service required')
	}
	return json(await adminUseCases.provisionApiKey(c, parseProvisionApiKeyRequest(body)), { status: 201 })
}

async function provisionApiKeyUseCase(c: AdminContext, input: ProvisionApiKeyRequest): Promise<ProvisionApiKeyResponse> {
	const body: unknown = input
	const { label, type } = input
	if (label.trim() === '' || type !== 'service') return fail(400, 'label and type=service required')
	const appResult = await appField(c, body)
	if (!appResult.ok) {
		return fail(400, 'unknown app')
	}
	const app = appResult.app
	const roleOrInline = await parseRoleOrInline(c, body, app)
	if (!roleOrInline.ok) {
		return fail(400, roleOrInline.message)
	}
	const scope = parseScope(body)
	if (!scope.ok) {
		return fail(400, 'scopeType and scopeValue must be both set or both omitted')
	}
	const expiresAt = numberField(body, 'expiresAt') ?? null
	const nowSeconds = Math.floor(Date.now() / 1000)
	if (expiresAt !== null && expiresAt <= nowSeconds) {
		return fail(400, 'expiresAt must be in the future')
	}

	// Create the native service principal (external_id NULL — resolved by its `px_` key, not by a
	// CF client_id) + its grant, then mint the bound credential. Shown once.
	const principal = await c.services.repositories.principals.createService(label)
	const grant = await c.services.repositories.grants.createGrant({
		principalId: principal.id,
		app,
		roleKey: roleOrInline.roleKey,
		permissions: roleOrInline.permissions,
		scopeType: scope.scopeType,
		scopeValue: scope.scopeValue,
		grantedBy: c.admin.id,
		expiresAt,
	})
	const apiKey = `${API_KEY_PREFIX}${generateToken()}`
	await c.services.repositories.credentials.createCredential({
		tokenHash: await hashToken(apiKey),
		label,
		principalId: principal.id,
		// The credential is bound to the SAME app as the grant it was provisioned for. `null` here is
		// the operator's explicit "every app" choice, which is legal for a principal-bound credential
		// because its permissions still resolve per app through that cross-app grant (SEC-2).
		app,
		issuedBy: c.admin.id,
		expiresAt,
		grants: [],
	})
	await adminAudit(c, {
		action: 'iam.apikey.create',
		resourceType: 'principal',
		resourceId: principal.id,
		metadata: { label, roleKey: roleOrInline.roleKey, permissions: roleOrInline.permissions, app },
	})
	await adminAudit(c, {
		action: 'iam.grant.create',
		resourceType: 'grant',
		resourceId: grant.id,
		metadata: {
			principalId: principal.id,
			roleKey: roleOrInline.roleKey,
			permissions: roleOrInline.permissions,
			scopeType: scope.scopeType,
			scopeValue: scope.scopeValue,
			app,
		},
	})

	const response: ProvisionApiKeyResponse = { principalId: principal.id, apiKey }
	return response
}

/**
 * Revoke an API key: hard-delete its grants, soft-disable the service principal, and
 * revoke its `px_` credentials so they stop minting immediately. Revocation is
 * effective at once — `mintFromKey` re-resolves the credential on every mint.
 */
export async function revokeApiKey(c: AdminContext, principalId: string): Promise<Response> {
	return json(await adminUseCases.revokeApiKey(c, { principalId }))
}

async function revokeApiKeyUseCase(c: AdminContext, input: { principalId: string }): Promise<OkResponse> {
	const { principalId } = input
	const principal = await c.services.repositories.principals.getPrincipalById(principalId)
	if (!principal || principal.type !== 'service') {
		return fail(404, 'service principal not found')
	}

	await c.services.repositories.grants.deleteGrantsForPrincipal(principalId)
	await c.services.repositories.principals.disablePrincipal(principalId)
	await c.services.repositories.credentials.revokeCredentialsForPrincipal(principalId)
	await adminAudit(c, {
		action: 'iam.apikey.revoke',
		resourceType: 'principal',
		resourceId: principalId,
		metadata: { label: principal.label },
	})
	return { ok: true }
}

/**
 * Rotate an API key: principal and grants unchanged. Revoke the principal's old `px_`
 * credentials and mint a fresh one, returned ONCE. Effective immediately.
 */
export async function rotateApiKey(c: AdminContext, principalId: string): Promise<Response> {
	const body = c.request.headers.get('content-type') === null ? null : await readJson(c.request)
	const expiresAt = body === null ? undefined : numberField(body, 'expiresAt')
	return json(await adminUseCases.rotateApiKey(c, { principalId, ...(expiresAt !== undefined ? { expiresAt } : {}) }))
}

/**
 * Rotate: same principal, same grants, new secret.
 *
 * Two things the old implementation got wrong. It DROPPED the credential's expiry — a key provisioned
 * to die in 30 days came back immortal, and an operator rotating a key on schedule was quietly
 * removing its bound (CORR-5); the replacement carries the old expiry forward unless the caller states
 * a new one, and a stated one must be in the future exactly as provisioning requires. And it rotated a
 * DISABLED principal's key, handing out a working secret for an account somebody had just revoked —
 * the same guard `passwordUser` already applies.
 */
async function rotateApiKeyUseCase(c: AdminContext, input: RotateApiKeyInput): Promise<RotateApiKeyResponse> {
	const { principalId } = input
	const principal = await c.services.repositories.principals.getPrincipalById(principalId)
	if (!principal || principal.type !== 'service') {
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
	await c.services.repositories.credentials.revokeCredentialsForPrincipal(principalId)
	const apiKey = `${API_KEY_PREFIX}${generateToken()}`
	await c.services.repositories.credentials.createCredential({
		tokenHash: await hashToken(apiKey),
		label: principal.label,
		principalId,
		app: existing?.app ?? null,
		issuedBy: c.admin.id,
		expiresAt,
		grants: [],
	})
	await adminAudit(c, {
		action: 'iam.apikey.rotate',
		resourceType: 'principal',
		resourceId: principalId,
		metadata: { label: principal.label, expiresAt },
	})
	const response: RotateApiKeyResponse = { principalId, apiKey }
	return response
}

// ── Share links (anonymous credentials) ─────────────────────────────────────────

export async function listShareLinks(c: AdminContext): Promise<Response> {
	const p = c.url.searchParams
	return json(
		await adminUseCases.listShareLinks(c, {
			...(p.get('app') ? { app: p.get('app') ?? undefined } : {}),
			...(p.get('includeRevoked') === 'true' ? { includeRevoked: true } : {}),
			...(p.get('before') ? { before: p.get('before') ?? undefined } : {}),
			limit: parseLimit(c.url),
		}),
	)
}

/**
 * One page of share links. Two queries per page (the credentials read plus one grants read for the
 * page's ids), revoked links hidden unless asked for, and `app` finally filterable now that an
 * anonymous credential carries one (SEC-2, SEC-22).
 */
async function listShareLinksUseCase(c: AdminContext, input: ListShareLinksInput): Promise<CursorList<ShareLinkListItem>> {
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

export async function createShareLink(c: AdminContext): Promise<Response> {
	const body = await readJson(c.request)
	const grants = parseShareLinkGrants(prop(body, 'grants'))
	if (grants === undefined || grants.length === 0) {
		return error(400, 'grants required (each: { action, scope? })')
	}
	return json(await adminUseCases.createShareLink(c, parseIssueShareLinkRequest(body)), { status: 201 })
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
async function createShareLinkUseCase(c: AdminContext, input: IssueShareLinkRequest): Promise<IssuedShareLinkResponse> {
	const grants = parseShareLinkGrants(input.grants)
	if (grants === undefined || grants.length === 0) return fail(400, 'grants required (each: { action, scope? })')
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

/**
 * Parse the `grants` array from a share-link issue request; undefined when malformed. Each grant is
 * an `action` + an optional `scope` ({ type, value }) — the credential's frozen inline grant, matched
 * by `permits` at use time. A `scope` present but not a well-formed coordinate fails the whole parse
 * (undefined → 400) rather than silently dropping it.
 */
function parseShareLinkGrants(value: unknown): KeyGrant[] | undefined {
	if (!Array.isArray(value)) {
		return undefined
	}
	const out: KeyGrant[] = []
	for (const item of value) {
		const action = stringField(item, 'action')
		if (!action) {
			return undefined
		}
		const scopeRaw = prop(item, 'scope')
		if (scopeRaw === undefined || scopeRaw === null) {
			out.push({ action, scope: null })
			continue
		}
		const type = stringField(scopeRaw, 'type')
		const scopeValue = stringField(scopeRaw, 'value')
		if (type === undefined || scopeValue === undefined) {
			return undefined
		}
		out.push({ action, scope: { type, value: scopeValue } })
	}
	return out
}

export async function revokeShareLink(c: AdminContext, id: string): Promise<Response> {
	return json(await adminUseCases.revokeShareLink(c, { id }))
}

async function revokeShareLinkUseCase(c: AdminContext, input: { id: string }): Promise<OkResponse> {
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

// ── Audit & auth log reads ────────────────────────────────────────────────────

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

function parseLimit(url: URL): number {
	const raw = url.searchParams.get('limit')
	if (!raw) {
		return DEFAULT_LIMIT
	}
	const n = Number.parseInt(raw, 10)
	if (!Number.isFinite(n) || n <= 0) {
		return DEFAULT_LIMIT
	}
	return Math.min(n, MAX_LIMIT)
}

export async function listAudit(c: AdminContext): Promise<Response> {
	const p = c.url.searchParams
	return json(
		await adminUseCases.listAudit(c, {
			...(p.get('resourceType') ? { resourceType: p.get('resourceType') ?? undefined } : {}),
			...(p.get('resourceId') ? { resourceId: p.get('resourceId') ?? undefined } : {}),
			...(p.get('principalId') ? { principalId: p.get('principalId') ?? undefined } : {}),
			...(p.get('action') ? { action: p.get('action') ?? undefined } : {}),
			...(p.get('requestId') ? { requestId: p.get('requestId') ?? undefined } : {}),
			...(p.get('before') ? { before: p.get('before') ?? undefined } : {}),
			limit: parseLimit(c.url),
		}),
	)
}

async function listAuditUseCase(c: AdminContext, input: ListAuditInput): Promise<{ items: AuditEventDto[]; nextCursor: string | null }> {
	const limit = normalizeLimit(input.limit)
	const rows = await c.services.repositories.audit.listAuditEvents({
		...(input.resourceType ? { resourceType: input.resourceType } : {}),
		...(input.resourceId ? { resourceId: input.resourceId } : {}),
		...(input.principalId ? { principalId: input.principalId } : {}),
		...(input.action ? { action: input.action } : {}),
		...(input.requestId ? { requestId: input.requestId } : {}),
		...(input.before ? { before: input.before } : {}),
		limit,
	})
	const items = rows.map(toAuditEventDto)
	const last = items.at(-1)
	const nextCursor = items.length === limit && last ? last.id : null
	return { items, nextCursor }
}

export async function listAuthLog(c: AdminContext): Promise<Response> {
	const p = c.url.searchParams
	const decisionParam = p.get('decision')
	const decision = decisionParam === 'allow' || decisionParam === 'deny' ? decisionParam : undefined
	return json(
		await adminUseCases.listAuthLog(c, {
			...(p.get('principalId') ? { principalId: p.get('principalId') ?? undefined } : {}),
			...(p.get('requestId') ? { requestId: p.get('requestId') ?? undefined } : {}),
			...(decision ? { decision } : {}),
			...(p.get('before') ? { before: p.get('before') ?? undefined } : {}),
			limit: parseLimit(c.url),
		}),
	)
}

async function listAuthLogUseCase(c: AdminContext, input: ListAuthLogInput): Promise<{ items: AuthLogDto[]; nextCursor: string | null }> {
	const limit = normalizeLimit(input.limit)
	const before = input.before ? Number.parseInt(input.before, 10) : undefined
	const rows = await c.services.repositories.audit.listAuthLog({
		...(input.principalId ? { principalId: input.principalId } : {}),
		...(input.requestId ? { requestId: input.requestId } : {}),
		...(input.decision ? { decision: input.decision } : {}),
		...(before !== undefined && Number.isFinite(before) ? { before } : {}),
		limit,
	})
	const items = rows.map(toAuthLogDto)
	const last = items.at(-1)
	const nextCursor = items.length === limit && last ? String(last.id) : null
	return { items, nextCursor }
}

function normalizeLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT
	return Math.min(Math.floor(limit), MAX_LIMIT)
}

function parseCreateGrantRequest(body: unknown): CreateGrantRequest {
	const principalId = stringField(body, 'principalId')
	if (!principalId) return fail(400, 'principalId required')
	const roleKey = stringField(body, 'roleKey')
	const permissions = arrayField(body, 'permissions')
	const scopeType = nullableStringField(body, 'scopeType')
	const scopeValue = nullableStringField(body, 'scopeValue')
	const app = nullableStringField(body, 'app')
	const expiresAt = numberField(body, 'expiresAt')
	return {
		principalId,
		...(roleKey !== undefined ? { roleKey } : {}),
		...(permissions !== undefined ? { permissions } : {}),
		...(scopeType !== undefined ? { scopeType } : {}),
		...(scopeValue !== undefined ? { scopeValue } : {}),
		...(app !== undefined ? { app } : {}),
		...(expiresAt !== undefined ? { expiresAt } : {}),
	}
}

function parseCreatePolicyRequest(body: unknown): CreatePolicyInput['policy'] {
	const key = stringField(body, 'key')
	const name = stringField(body, 'name')
	const permissions = arrayField(body, 'permissions')
	if (key === undefined || name === undefined || permissions === undefined) {
		return fail(400, 'key, name and permissions (array) required')
	}
	const description = stringField(body, 'description')
	return { key, name, permissions, ...(description !== undefined ? { description } : {}) }
}

function parseUpdatePolicyRequest(body: unknown): UpdatePolicyInput['policy'] {
	const name = stringField(body, 'name')
	const permissions = arrayField(body, 'permissions')
	if (name === undefined || permissions === undefined) return fail(400, 'name and permissions (array) required')
	const description = stringField(body, 'description')
	return { name, permissions, ...(description !== undefined ? { description } : {}) }
}

function parseProvisionApiKeyRequest(body: unknown): ProvisionApiKeyRequest {
	const label = stringField(body, 'label')
	const type = stringField(body, 'type')
	if (label === undefined || type !== 'service') return fail(400, 'label and type=service required')
	const grant = parseCreateGrantRequest({ ...recordWithoutPrincipal(body), principalId: 'unused' })
	const { principalId: _principalId, ...authorization } = grant
	return { label, type, ...authorization }
}

function recordWithoutPrincipal(body: unknown): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const key of ['roleKey', 'permissions', 'scopeType', 'scopeValue', 'app', 'expiresAt']) {
		const value = prop(body, key)
		if (value !== undefined) out[key] = value
	}
	return out
}

function parseIssueShareLinkRequest(body: unknown): IssueShareLinkRequest {
	const grants = parseShareLinkGrants(prop(body, 'grants'))
	if (grants === undefined) return fail(400, 'grants required (each: { action, scope? })')
	const app = stringField(body, 'app')
	if (app === undefined || app.trim() === '') return fail(400, 'app required')
	const label = stringField(body, 'label')
	const expiresAt = numberField(body, 'expiresAt')
	return {
		app,
		grants,
		...(label !== undefined ? { label } : {}),
		...(expiresAt !== undefined ? { expiresAt } : {}),
	}
}

/** Shared typed application operations used by both REST and `/admin/rpc`. */
export const adminUseCases = {
	me,
	listPrincipals: listPrincipalsUseCase,
	getPrincipal: getPrincipalUseCase,
	invitePrincipal: invitePrincipalUseCase,
	updatePrincipal: updatePrincipalUseCase,
	issuePasswordEnrollment: issuePasswordEnrollmentUseCase,
	issuePasswordReset: issuePasswordResetUseCase,
	disablePassword: disablePasswordUseCase,
	createGrant: createGrantUseCase,
	deleteGrant: deleteGrantUseCase,
	listApps: listAppsUseCase,
	listRoles: listRolesUseCase,
	getAppSchema: getAppSchemaUseCase,
	getReturnOrigins: getReturnOriginsUseCase,
	setReturnOrigins: setReturnOriginsUseCase,
	clearReturnOrigins: clearReturnOriginsUseCase,
	listPolicies: listPoliciesUseCase,
	createPolicy: createPolicyUseCase,
	updatePolicy: updatePolicyUseCase,
	deletePolicy: deletePolicyUseCase,
	listApiKeys: listApiKeysUseCase,
	provisionApiKey: provisionApiKeyUseCase,
	rotateApiKey: rotateApiKeyUseCase,
	revokeApiKey: revokeApiKeyUseCase,
	listShareLinks: listShareLinksUseCase,
	createShareLink: createShareLinkUseCase,
	revokeShareLink: revokeShareLinkUseCase,
	listAudit: listAuditUseCase,
	listAuthLog: listAuthLogUseCase,
}
