// A person's second factor (TOTP), as an installation administrator reads and resets it. The reset is the operator's
// path for a lost phone: it removes the authenticator and every recovery code, so the next sign-in asks for no code
// and the person enrols again at IAM's `/auth/second-factor/enrol`.

import type { PrincipalIdInput, SecondFactorDto } from '@fabrika/iam-contract'
import { type AdminContext, adminEvent, fail } from './context'

export async function getSecondFactorUseCase(c: AdminContext, input: PrincipalIdInput): Promise<SecondFactorDto> {
	requireInstallationAdmin(c)
	await requirePrincipal(c, input.principalId)
	return secondFactorDto(c, input.principalId)
}

/** Remove the authenticator and recovery codes, recorded as `iam.second_factor.reset`; a principal without one records nothing. */
export async function resetSecondFactorUseCase(c: AdminContext, input: PrincipalIdInput): Promise<SecondFactorDto> {
	requireInstallationAdmin(c)
	await requirePrincipal(c, input.principalId)
	await c.services.repositories.secondFactors.reset(
		input.principalId,
		adminEvent(c, { action: 'iam.second_factor.reset', resourceType: 'principal', resourceId: input.principalId }),
	)
	return secondFactorDto(c, input.principalId)
}

async function secondFactorDto(c: AdminContext, principalId: string): Promise<SecondFactorDto> {
	const status = await c.services.repositories.secondFactors.status(principalId)
	return { enrolledAt: status.confirmedAt, recoveryCodesLeft: status.recoveryCodesLeft, available: c.services.dataKey !== null }
}

async function requirePrincipal(c: AdminContext, principalId: string): Promise<void> {
	if (await c.services.repositories.principals.getPrincipalById(principalId) === null) fail(404, 'principal not found')
}

/** `.require(iam.admin)` gates these procedures already; a direct caller of a use case meets the same rule. */
function requireInstallationAdmin(c: AdminContext): void {
	if (c.administration.kind !== 'installation') {
		return fail(403, 'a second factor is read and reset only by an installation administrator')
	}
}
