import type { EmailMessage } from '@fabrika/email'
import type { PrincipalRow } from './db'
import { randomToken } from './oidc'
import type { PasswordActionPurpose } from './password-db'
import { passwordActionEmail } from './password-email'
import { hashToken } from './secret'
import type { Services } from './services'

const ACTION_TTL_SECONDS = 60 * 60

export interface IssuedPasswordAction {
	readonly id: string
	readonly url: string
	readonly expiresAt: number
	readonly message: EmailMessage | null
}

/** Issue an opaque one-time action. The plaintext token exists only in the returned URL. */
export async function issuePasswordAction(
	services: Services,
	input: { readonly principal: PrincipalRow; readonly purpose: PasswordActionPurpose; readonly issuedBy?: string | null },
): Promise<IssuedPasswordAction> {
	const token = randomToken(32)
	const expiresAt = Math.floor(Date.now() / 1000) + ACTION_TTL_SECONDS
	const id = await services.repositories.passwords.issueActionToken({
		principalId: input.principal.id,
		purpose: input.purpose,
		tokenHash: await hashToken(token),
		issuedBy: input.issuedBy,
		expiresAt,
	})
	const path = input.purpose === 'enrollment' ? '/auth/password/enroll' : '/auth/password/reset'
	const url = new URL(path, services.config.issuer)
	// Fragments never reach HTTP access logs; the action page copies it into the POST form in-browser.
	url.hash = new URLSearchParams({ token }).toString()
	const message = input.principal.email === null
		? null
		: passwordActionEmail({
			to: input.principal.email,
			purpose: input.purpose,
			actionUrl: url.toString(),
			idempotencyKey: `iam-password-${id}`,
		})
	return { id, url: url.toString(), expiresAt, message }
}

export async function deliverPasswordAction(services: Services, action: IssuedPasswordAction): Promise<void> {
	if (services.email === null || action.message === null) return
	await services.email.send(action.message)
}
