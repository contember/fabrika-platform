import { API_KEY_PREFIX, parseAppEnvironmentId } from '@fabrika/auth-core'
import type { IssueMembershipKeyRequest, IssueMembershipKeyResponse } from '@fabrika/iam-contract'
import { keyExpiryProblem } from '../issue'
import { unixNow } from '../repositories/sql'
import { generateToken, hashToken } from '../secret'
import { adminAudit, type AdminContext, fail } from './context'

/**
 * Issue a fresh membership transport key for one application environment (`src/membership-http.ts`). The key the caller
 * recorded as active (`keep`) stays valid, so the version still running keeps working until the caller has recorded the
 * new one; every other key of the environment is an orphan of an attempt whose record failed, and is deleted.
 */
export async function issueMembershipKeyUseCase(c: AdminContext, input: IssueMembershipKeyRequest): Promise<IssueMembershipKeyResponse> {
	if (parseAppEnvironmentId(input.app) === null) {
		return fail(400, 'a membership transport key belongs to one application environment, <app>@<env>')
	}
	const now = unixNow()
	const expiryProblem = keyExpiryProblem(input.expiresAt, now)
	if (expiryProblem !== null) {
		return fail(400, expiryProblem)
	}
	// `px_`, like every key IAM issues, so the redaction of `px_` patterns covers it in every log.
	const key = `${API_KEY_PREFIX}${generateToken()}`
	const id = await c.services.repositories.membershipTransport.issue({
		app: input.app,
		keyHash: await hashToken(key),
		expiresAt: input.expiresAt,
		keep: input.keep,
		now,
	})
	await adminAudit(c, {
		action: 'iam.membership-key.issue',
		resourceType: 'membership_transport_key',
		resourceId: id,
		metadata: { app: input.app, expiresAt: input.expiresAt, kept: input.keep },
	})
	return { key, id, expiresAt: input.expiresAt }
}
