/**
 * S8 of the authorization model, shared by issue and mint: a credential one principal delegates to another (a share
 * link, an anonymous key, a service or device key) carries no more than its issuer still holds, and no longer.
 */

import { type PermissionEntry, permits, type Scope } from '@fabrika/auth-core'
import { IAM_ACTIONS, IAM_APP_ID } from '@fabrika/iam-contract'
import { PROVISIONING_ADMIN_ID } from './auth'
import { principalStatus } from './db'
import { authorityDeadline, resolveAuthorityAt } from './resolve'
import type { Services } from './services'

/** An action the issuer must still hold on at least one of `on` (`null` is application-wide). */
export interface DelegatedAction {
	action: string
	on: readonly (Scope | null)[]
}

/**
 * S8 at every mint of an anonymous credential: its issuer exists, is enabled and still holds each delegated action, and
 * the token ends when the first of them loses its support. A job issuer holds its current declaration, app-wide, and
 * only for the mount it is declared to issue; the provisioning administrator is the installation's named exception. A credential without an issuer, or whose issuer lost any of it, mints
 * nothing (`issuer_unauthorized`, reported as `invalid_key`).
 */
export async function issuerAuthority(
	services: Services,
	issuerId: string | null,
	app: string,
	mount: string | null,
	required: readonly DelegatedAction[],
): Promise<{ ok: true; expiresAt: number | null } | { ok: false; reason: 'issuer_unauthorized' }> {
	const refused: { ok: false; reason: 'issuer_unauthorized' } = { ok: false, reason: 'issuer_unauthorized' }
	const issuer = issuerId === null ? null : await services.repositories.principals.getPrincipalById(issuerId)
	if (issuer === null || principalStatus(issuer) === 'disabled') {
		return refused
	}
	if (issuer.id === PROVISIONING_ADMIN_ID) {
		// The named exception: the seeded installation administrator holds every action, and its issuance was audited.
		return { ok: true, expiresAt: null }
	}
	const workload = await services.repositories.workloads.getByPrincipal(issuer.id)
	if (workload !== null) {
		const declaration = workload.kind === 'job' && workload.app === app
			? await services.repositories.workloads.declaration(app, 'job', workload.name)
			: null
		if (declaration === null || mount === null || declaration.issues !== mount) {
			return refused
		}
		return required.every(({ action }) => declaration.actions.includes(action)) ? { ok: true, expiresAt: null } : refused
	}
	const authority = await resolveAuthorityAt(services, issuer, app)
	const now = Math.floor(Date.now() / 1000)
	let expiresAt: number | null = null
	for (const { action, on } of required) {
		// Per action the latest support among the chain links it is held on, then the earliest across actions.
		let latest: number | null | undefined
		for (const scope of on) {
			if (!permits(authority.permissions, action, scope ?? undefined)) continue
			const until = authorityDeadline(authority, [{ action, scope, source: 'grant' }], now)
			latest = latest === undefined ? until : latest === null || until === null ? null : Math.max(latest, until)
		}
		if (latest === undefined) {
			return refused
		}
		if (latest !== null && (expiresAt === null || latest < expiresAt)) {
			expiresAt = latest
		}
	}
	return { ok: true, expiresAt }
}

/**
 * A principal-bound key whose issuer is another principal (a service or device key): what the issuer still covers of
 * `permissions` at `app`, and until when. The named exceptions keep the whole set: the provisioning administrator, and
 * an issuer that still holds `iam.admin` (the installation administrator, until its own grant of it ends). A missing
 * or disabled issuer refuses the key.
 */
export async function issuerCoverage(
	services: Services,
	issuerId: string,
	app: string,
	permissions: PermissionEntry[],
): Promise<{ ok: true; permissions: PermissionEntry[]; expiresAt: number | null } | { ok: false; reason: 'issuer_unauthorized' }> {
	const refused: { ok: false; reason: 'issuer_unauthorized' } = { ok: false, reason: 'issuer_unauthorized' }
	if (issuerId === PROVISIONING_ADMIN_ID) {
		return { ok: true, permissions, expiresAt: null }
	}
	const issuer = await services.repositories.principals.getPrincipalById(issuerId)
	if (issuer === null || principalStatus(issuer) === 'disabled') {
		return refused
	}
	const now = Math.floor(Date.now() / 1000)
	const installation = await resolveAuthorityAt(services, issuer, IAM_APP_ID)
	if (permits(installation.permissions, IAM_ACTIONS.ADMIN)) {
		return { ok: true, permissions, expiresAt: authorityDeadline(installation, [{ action: IAM_ACTIONS.ADMIN, scope: null, source: 'grant' }], now) }
	}
	const authority = await resolveAuthorityAt(services, issuer, app)
	const covered = permissions.filter((entry) => permits(authority.permissions, entry.action, entry.scope ?? undefined))
	return { ok: true, permissions: covered, expiresAt: authorityDeadline(authority, covered, now) }
}
