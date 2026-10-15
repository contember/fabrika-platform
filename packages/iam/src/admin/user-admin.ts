// User administration (ADR-0058): who may manage the people of applications without administering IAM, and where that
// authority stops. Every rule here applies only to a caller without `iam.admin`.

import { IAM_APP_ID, type IamAdministrationScope, iamAdministrationScope } from '@fabrika/iam-contract'
import { type PrincipalRow, principalStatus } from '../db'
import { normalizeEmailIdentity } from '../email-identity'
import type { Services } from '../services'
import { type AdminContext, fail } from './context'
import type { ResolvedAdmin } from './router'

/** What the caller administers: the installation, or the people of some applications (`null` = every application). */
export type Administration = IamAdministrationScope

/**
 * The caller's administration, or null when it holds none. A user administrator is a person signed in to the console,
 * as for `appPeople`: a `px_` key administers only with `iam.admin`.
 */
export function administrationOf(admin: Pick<ResolvedAdmin, 'permissions' | 'type' | 'audience' | 'session'>): Administration | null {
	const administration = iamAdministrationScope(admin.permissions)
	if (administration?.kind !== 'users') return administration
	return admin.type === 'user' && admin.audience !== IAM_APP_ID && admin.session ? administration : null
}

/** True when `administration` may write a grant at `app`: never cross-app, never an installation app, only in scope. */
export function managesApp(services: Pick<Services, 'config'>, administration: Administration, app: string | null): boolean {
	if (administration.kind === 'installation') return true
	if (app === null || services.config.platformAudiences.has(app)) return false
	return administration.apps === null || administration.apps.includes(app)
}

/** Refuse a grant write at `app` that the caller's administration does not reach. */
export function requireManagedApp(c: AdminContext, app: string | null): void {
	if (managesApp(c.services, c.administration, app)) return
	if (app === null) return fail(403, 'a user administrator grants at one application, never across applications')
	if (c.services.config.platformAudiences.has(app)) {
		return fail(403, `'${app}' is one of the installation's own apps; only an installation administrator grants there`)
	}
	return fail(403, `'${app}' is outside the applications you administer`)
}

/**
 * Refuse to act on `principal` unless the caller could have made every grant it holds. That keeps an installation
 * administrator, a deployer, a console admin, a bootstrap mailbox and every other user administrator out of reach.
 */
export async function requireActableTarget(c: AdminContext, principal: PrincipalRow): Promise<void> {
	if (c.administration.kind === 'installation') return
	if (!(await isActable(c.services, c.administration, principal))) {
		return fail(403, 'this person holds access outside the applications you administer; only an installation administrator acts on them')
	}
}

async function isActable(services: Services, administration: Administration, principal: PrincipalRow): Promise<boolean> {
	if (principal.type !== 'user') return false
	if (principal.email !== null && services.config.bootstrapAdmins.has(normalizeEmailIdentity(principal.email))) return false
	const grants = await services.repositories.grants.getActiveGrants(principal.id)
	return grants.every((grant) => managesApp(services, administration, grant.app))
}

/**
 * A manual enrollment URL reaches a user administrator only for a person who never signed in, and only while that person
 * is still one it may act on — read again after the link was issued, so a grant written meanwhile withholds the URL.
 */
export async function mayReceiveEnrollmentUrl(c: AdminContext, principalId: string): Promise<boolean> {
	if (c.administration.kind === 'installation') return true
	const principal = await c.services.repositories.principals.getPrincipalById(principalId)
	return principal !== null && principalStatus(principal) === 'invited' && await isActable(c.services, c.administration, principal)
}
