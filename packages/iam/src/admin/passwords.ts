import { type OkResponse, type PasswordActionDelivery, type PrincipalIdInput } from '@fabrika/iam-contract'

import { INSTALLATION_PRESENTATION } from '../app-presentation'
import { type PrincipalRow } from '../db'
import { deliverPasswordAction, issuePasswordAction } from '../password-service'
import { type AdminContext, adminEvent, fail } from './context'
import { mayReceiveEnrollmentUrl, requireActableTarget } from './user-admin'

async function passwordUser(c: AdminContext, id: string, requireActive: boolean = true): Promise<PrincipalRow> {
	if (!c.services.config.authentication.password.enabled) {
		return fail(409, 'password authentication is not available')
	}
	const principal = await c.services.repositories.principals.getPrincipalById(id)
	if (!principal) return fail(404, 'principal not found')
	if (principal.type !== 'user') return fail(400, 'password authentication is available only for users')
	if (principal.email === null) return fail(409, 'user has no email address')
	if (requireActive && principal.disabled_at !== null) return fail(409, 'principal is disabled')
	await requireActableTarget(c, principal)
	return principal
}

async function passwordDelivery(
	c: AdminContext,
	principal: PrincipalRow,
	purpose: 'enrollment' | 'reset',
): Promise<PasswordActionDelivery> {
	const delivery = c.services.email === null ? 'manual' : 'email'
	// A manual URL signs its holder in as the person: a user administrator gets one only to onboard (ADR-0058).
	if (delivery === 'manual' && c.administration.kind === 'users') {
		if (purpose === 'reset') return fail(403, 'without an email sender, only an installation administrator receives a password reset link')
		if (!(await mayReceiveEnrollmentUrl(c, principal.id))) {
			return fail(403, 'without an email sender, a user administrator receives an enrollment link only for a person who never signed in')
		}
	}
	// The token, the enrollment opt-in and the record commit together; the email is an effect after that.
	// An administrator's action belongs to the installation: its page and mail speak IAM's default language.
	const action = await issuePasswordAction(c.services, { principal, purpose, issuedBy: c.admin.id, presentation: INSTALLATION_PRESENTATION }, {
		audit: adminEvent(c, { action: `iam.password.${purpose}.issue`, resourceType: 'principal', resourceId: principal.id, metadata: { delivery } }),
		enableEnrollment: purpose === 'enrollment',
	})
	if (c.services.email === null) {
		if (!(await mayReceiveEnrollmentUrl(c, principal.id))) return fail(409, 'the person changed while the link was issued; the link is withheld')
		return { delivery: 'manual', url: action.url, expiresAt: action.expiresAt }
	}
	if (action.message === null || principal.email === null) {
		return fail(409, 'user has no email address')
	}
	try {
		await deliverPasswordAction(c.services, action)
	} catch {
		console.error('Password action email delivery failed')
		// The outcome of an effect, not a change of IAM's: the token was recorded when it was issued.
		await c.services.repositories.audit.writeAuditEvent(
			adminEvent(c, { action: `iam.password.${purpose}.delivery_failed`, resourceType: 'principal', resourceId: principal.id }),
		)
		return fail(502, 'password action email delivery failed')
	}
	return { delivery: 'email', email: principal.email, expiresAt: action.expiresAt }
}

export async function issuePasswordEnrollmentUseCase(c: AdminContext, input: PrincipalIdInput): Promise<PasswordActionDelivery> {
	const principal = await passwordUser(c, input.principalId)
	const account = await c.services.repositories.passwords.getAccount(principal.id)
	if (account?.state === 'enabled') return fail(409, 'password authentication is already enabled')
	return passwordDelivery(c, principal, 'enrollment')
}

export async function issuePasswordResetUseCase(c: AdminContext, input: PrincipalIdInput): Promise<PasswordActionDelivery> {
	const principal = await passwordUser(c, input.principalId)
	const account = await c.services.repositories.passwords.getAccount(principal.id)
	if (account?.state !== 'enabled') return fail(409, 'password authentication is not enabled')
	return passwordDelivery(c, principal, 'reset')
}

export async function disablePasswordUseCase(c: AdminContext, input: PrincipalIdInput): Promise<OkResponse> {
	const principal = await passwordUser(c, input.principalId, false)
	await c.services.repositories.passwords.disableCredential(
		principal.id,
		adminEvent(c, { action: 'iam.password.disable', resourceType: 'principal', resourceId: principal.id }),
	)
	return { ok: true }
}
