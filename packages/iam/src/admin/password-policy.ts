// The installation's minimum password length (ADR-0020): an installation administrator's to read and to change. One
// value for every principal of the installation; IAM's set-password and invitation pages read it at every render.

import { PASSWORD_DEFAULT_MIN_LENGTH, PASSWORD_MAX_LENGTH, type PasswordPolicyDto, type SetPasswordPolicyRequest } from '@fabrika/iam-contract'
import { minLengthProblem, storedMinLength } from '../password-minimum'
import type { PasswordPolicyRow } from '../repositories/password-policy'
import { type AdminContext, adminEvent, fail } from './context'

export async function getPasswordPolicyUseCase(c: AdminContext): Promise<PasswordPolicyDto> {
	requireInstallationAdmin(c)
	return policyDto(c, await c.services.repositories.passwordPolicy.get())
}

/**
 * Store the minimum, held here to this runtime's floor whatever the console checked. It applies to the next password
 * chosen; a stored verifier is never re-judged, so raising it asks nobody to change a password and lowering it weakens
 * none. Setting the minimum already stored changes and records nothing.
 */
export async function setPasswordPolicyUseCase(c: AdminContext, input: SetPasswordPolicyRequest): Promise<PasswordPolicyDto> {
	requireInstallationAdmin(c)
	const problem = minLengthProblem(input.minLength, c.services.config.authentication.password.minLengthFloor)
	if (problem !== null) return fail(400, problem)
	const repository = c.services.repositories.passwordPolicy
	const changed = await repository.setMinLength(
		input.minLength,
		adminEvent(c, { action: 'iam.password_policy.update', resourceType: 'password_policy', metadata: { minLength: input.minLength } }),
	)
	return policyDto(c, changed ?? await repository.get())
}

function policyDto(c: AdminContext, row: PasswordPolicyRow | null): PasswordPolicyDto {
	const { enabled, minLengthFloor } = c.services.config.authentication.password
	return {
		minLength: storedMinLength(row, minLengthFloor),
		defaultMinLength: PASSWORD_DEFAULT_MIN_LENGTH,
		minLengthFloor,
		maxLength: PASSWORD_MAX_LENGTH,
		passwordEnabled: enabled,
		updatedAt: row?.updated_at ?? null,
	}
}

/** `.require(iam.admin)` gates these procedures already; a direct caller of a use case meets the same rule. */
function requireInstallationAdmin(c: AdminContext): void {
	if (c.administration.kind !== 'installation') {
		return fail(403, "the installation's password policy is changed and read only by an installation administrator")
	}
}
