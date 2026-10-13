/**
 * Issuing credentials: `issueKey` writes an opaque, stored, revocable `px_` credential (API key /
 * share link). The token's EFFECTIVE permissions are resolved at use time (`mintFromKey`); this just
 * persists the row.
 *
 * Issuance is DELEGATED: the issuer (resolved server-side from the forwarded credentials, never
 * self-asserted) may only grant what it itself holds — the same `permits` rule `can()` uses. The
 * Worker entrypoint resolves the issuer and writes the audit row; this module is the pure-ish core.
 */

import {
	API_KEY_PREFIX,
	type IssueKeyInput,
	type IssueKeyResult,
	type KeyGrant,
	MAX_KEY_LIFETIME_SECONDS,
	type PermissionEntry,
	permits,
	type RevokeKeyInput,
	type RevokeKeyResult,
} from '@fabrika/auth-core'
import { uuidv7 } from '@fabrika/platform'
import type { AuditEventInput, CredentialGrantRow } from './db'
import { unixNow } from './repositories/sql'
import { generateToken, hashToken } from './secret'
import type { Services } from './services'

/** The resolved caller (issuer), as `index.ts` resolves it from the forwarded JWT. */
interface Issuer {
	id: string
	permissions: PermissionEntry[]
}

/**
 * What `issueKey` decided. A refusal with a `problem` was a malformed request (expiry, catalog), not a
 * lack of authority: the admin path answers it with a 400 that names the problem, and the RPC still
 * answers `not_allowed`, its only refusal reason.
 */
export interface IssueOutcome {
	result: IssueKeyResult
	auditLabel?: string
	problem?: string
}

/** The record of an issued key, given the ids the issuance generated; written in the key's own transaction. */
export type IssueRecord = (issued: { credentialId: string; principalId: string | undefined }) => AuditEventInput

const NOT_ALLOWED: IssueOutcome = { result: { ok: false, reason: 'not_allowed' } }

function refused(problem: string): IssueOutcome {
	return { ...NOT_ALLOWED, problem }
}

/**
 * Delegation check (pure): every requested grant must be covered by the issuer's permissions on its
 * scope, using the same `permits` matching as `can()`. Returns the first uncovered grant, or null.
 */
export function findUncoveredGrant(issuerPermissions: PermissionEntry[], grants: KeyGrant[]): KeyGrant | null {
	for (const grant of grants) {
		if (!permits(issuerPermissions, grant.action, grant.scope ?? undefined)) {
			return grant
		}
	}
	return null
}

/** Why `expiresAt` is not an acceptable key expiry at `now` (both unix seconds), or null when it is. */
export function keyExpiryProblem(expiresAt: number, now: number): string | null {
	if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
		return 'expiresAt must be a future unix time in seconds'
	}
	if (expiresAt - now > MAX_KEY_LIFETIME_SECONDS) {
		return `expiresAt must be at most ${MAX_KEY_LIFETIME_SECONDS} seconds (30 days) ahead`
	}
	return null
}

/**
 * Why a requested action may not go on a key, or null when every one may. A key lists EXACT catalog
 * actions: a wildcard would also cover actions the app declares later, or never declares at all.
 */
async function actionProblem(services: Services, app: string, actions: string[]): Promise<string | null> {
	const wildcard = actions.find((action) => action.includes('*'))
	if (wildcard !== undefined) {
		return `a key lists exact actions, not the wildcard: ${wildcard}`
	}
	const catalog = new Set(await services.repositories.appSchema.listActionCatalog(app))
	const unknown = actions.find((action) => !catalog.has(action))
	return unknown === undefined ? null : `unknown action: ${unknown}`
}

// ── issueKey ──────────────────────────────────────────────────────────────────

/**
 * Issue an opaque `px_` credential.
 *
 * `app` is the issuer's VERIFIED app, and every credential this function writes is bound to it. That
 * binding is what makes delegation mean anything: the grants below are checked against the issuer's
 * permissions *for this app*, so a credential that could be spent at another one would convert
 * app-scoped authority into installation-wide authority (SEC-2). For the same reason every granted
 * action must be an exact action of that app's catalog, and every key must expire within
 * `MAX_KEY_LIFETIME_SECONDS`.
 */
export async function issueKey(services: Services, input: IssueKeyInput, issuer: Issuer, app: string, record?: IssueRecord): Promise<IssueOutcome> {
	// Every mode: a self-bound key is a standing copy of a 300-second token, a service key a new
	// principal, a share link frozen authority — none of them may outlive the bound (SEC-7).
	const expiryProblem = keyExpiryProblem(input.expiresAt, unixNow())
	if (expiryProblem !== null) {
		return refused(expiryProblem)
	}
	// An external principal's authority is its live external roles (ADR-0051): it issues only a key bound to itself,
	// which resolves those live. A service or standalone key would freeze a copy that outlives them.
	const selfBound = input.service === undefined && input.principalId === issuer.id
	if (!selfBound && (await services.repositories.principals.getPrincipalById(issuer.id))?.affiliation !== 'internal') {
		return NOT_ALLOWED
	}

	// Service mode: create a NEW machine principal + grant and bind the key to it (the folded
	// issueServiceToken). The grant is scoped to the issuer's verified `app`; the issuer must hold
	// every requested action on `scope` (the same delegation rule as a grant).
	if (input.service !== undefined) {
		const svc = input.service
		const grants = svc.permissions.map((action) => ({ action, scope: svc.scope ?? null }))
		if (grants.length === 0) {
			return NOT_ALLOWED
		}
		const problem = await actionProblem(services, app, svc.permissions)
		if (problem !== null) {
			return refused(problem)
		}
		if (findUncoveredGrant(issuer.permissions, grants) !== null) {
			return NOT_ALLOWED
		}
		const token = `${API_KEY_PREFIX}${generateToken()}`
		const principalId = uuidv7()
		const id = uuidv7()
		const { principals, grants: grantRepository, credentials, audit } = services.repositories
		// The principal, its grant, its key and the record are one transaction: no half-issued service survives.
		await audit.commit([
			principals.createServiceStatement(principalId, svc.label),
			grantRepository.grantStatement(uuidv7(), {
				principalId,
				app,
				permissions: svc.permissions,
				scopeType: svc.scope?.type ?? null,
				scopeValue: svc.scope?.value ?? null,
				grantedBy: issuer.id,
				expiresAt: input.expiresAt,
			}),
			...credentials.credentialStatements(id, {
				tokenHash: await hashToken(token),
				label: svc.label,
				principalId,
				app,
				issuedBy: issuer.id,
				expiresAt: input.expiresAt,
				grants: [],
			}),
			...(record === undefined ? [] : [audit.eventStatement(record({ credentialId: id, principalId }))]),
		])
		return { result: { ok: true, token, id, principalId }, auditLabel: svc.label }
	}

	// v1: binding is only to the issuer's OWN principal (a personal token). A standalone credential
	// needs grants.
	if (input.principalId !== undefined && input.principalId !== issuer.id) {
		return NOT_ALLOWED
	}
	const grants = input.permissions ?? []
	if (input.principalId === undefined && grants.length === 0) {
		return NOT_ALLOWED
	}
	const problem = await actionProblem(services, app, grants.map((grant) => grant.action))
	if (problem !== null) {
		return refused(problem)
	}
	// Delegation: the issuer must hold every inline grant (trivially true for a self-bound downscope).
	if (findUncoveredGrant(issuer.permissions, grants) !== null) {
		return NOT_ALLOWED
	}

	const token = `${API_KEY_PREFIX}${generateToken()}`
	const id = await services.repositories.credentials.createCredential({
		tokenHash: await hashToken(token),
		label: input.label ?? null,
		principalId: input.principalId ?? null,
		app,
		issuedBy: issuer.id,
		expiresAt: input.expiresAt,
		grants: grants.map((g) => ({ action: g.action, scopeType: g.scope?.type ?? null, scopeValue: g.scope?.value ?? null })),
	}, record === undefined ? undefined : (credentialId) => record({ credentialId, principalId: input.principalId }))
	return { result: { ok: true, token, id, principalId: input.principalId }, auditLabel: input.label }
}

// ── revokeKey ───────────────────────────────────────────────────────────────────

/** A `credential_grants` row → a delegation-check `KeyGrant` (both scope cols null = global). */
function credentialGrantToKeyGrant(row: CredentialGrantRow): KeyGrant {
	const scope = row.scope_type === null || row.scope_value === null ? null : { type: row.scope_type, value: row.scope_value }
	return { action: row.action, scope }
}

/**
 * Revoke an opaque `px_` credential by id, for the caller's VERIFIED `app`. A credential bound to any
 * other app — or to none, a cross-app key — is `not_found`, the same answer as an unknown id, so one
 * app cannot probe or end another app's keys. Within the app, authorization mirrors the old capability
 * revoke: the original issuer may always revoke; otherwise, for an ANONYMOUS credential (a share
 * link), the caller must be able to re-issue its grants — hold every granted action, checked with the
 * same `findUncoveredGrant` as issue. A principal-bound credential is managed through the principal
 * path (the api-keys page), so a non-issuer caller cannot revoke it by id here. Idempotent — a second
 * revoke returns `{ ok: true, revoked: false }`.
 */
export async function revokeKey(
	services: Services,
	input: RevokeKeyInput,
	revoker: Issuer,
	app: string,
	record?: AuditEventInput,
): Promise<RevokeKeyResult> {
	const cred = await services.repositories.credentials.getCredentialById(input.id)
	if (!cred || cred.app !== app) {
		return { ok: false, reason: 'not_found' }
	}
	if (cred.issued_by !== revoker.id) {
		if (cred.principal_id !== null) {
			return { ok: false, reason: 'not_allowed' }
		}
		const grants = (await services.repositories.credentials.getCredentialGrants(cred.id)).map(credentialGrantToKeyGrant)
		if (findUncoveredGrant(revoker.permissions, grants) !== null) {
			return { ok: false, reason: 'not_allowed' }
		}
	}
	const revoked = await services.repositories.credentials.revokeCredential(cred.id, record)
	return { ok: true, revoked }
}
