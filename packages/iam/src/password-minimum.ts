import { PASSWORD_DEFAULT_MIN_LENGTH, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH_FLOOR } from '@fabrika/iam-contract'
import { logWarn } from './log'
import { PBKDF2_SHA256_ITERATIONS, type Pbkdf2Cost } from './password-crypto'
import type { PasswordPolicyRow } from './repositories/password-policy'
import type { Services } from './services'

/**
 * The lowest minimum this runtime accepts. A short password survives a leaked database only as long as its verifier is
 * expensive, so the floor is low only where `hash` derives with OWASP's PBKDF2 cost (the Bun process). A Worker derives
 * a sixth of it (backlog 201) and keeps the default as its floor until it hashes with a stronger algorithm.
 */
export function passwordMinLengthFloor(cost: Pbkdf2Cost): number {
	return cost.iterations >= PBKDF2_SHA256_ITERATIONS ? PASSWORD_MIN_LENGTH_FLOOR : PASSWORD_DEFAULT_MIN_LENGTH
}

/** Why a minimum cannot be stored, in the words the administration API answers with; null when it can. */
export function minLengthProblem(minLength: number, floor: number): string | null {
	if (!Number.isInteger(minLength)) return 'the minimum password length must be a whole number'
	if (minLength < floor) return `the minimum password length cannot be below ${floor} on this installation`
	if (minLength > PASSWORD_MAX_LENGTH) return `the minimum password length cannot be above ${PASSWORD_MAX_LENGTH}`
	return null
}

/**
 * The minimum a stored row sets, checked again as the administration API checks it: no row is the default, and a row this
 * runtime would not accept (one an installation on another runtime wrote, or a hand edit) is the default too, never a
 * value below the floor.
 */
export function storedMinLength(row: PasswordPolicyRow | null, floor: number): number {
	if (row === null) return PASSWORD_DEFAULT_MIN_LENGTH
	if (minLengthProblem(row.min_length, floor) !== null) {
		console.warn('password policy: the stored minimum is outside what this runtime accepts, so the default applies')
		return PASSWORD_DEFAULT_MIN_LENGTH
	}
	return row.min_length
}

/**
 * The minimum every new password meets, read once per request. A read that fails applies the default and logs the
 * failure's message: the person may be asked for a longer password than the installation requires, never a shorter one.
 */
export async function passwordMinLength(services: Services): Promise<number> {
	try {
		return storedMinLength(await services.repositories.passwordPolicy.get(), services.config.authentication.password.minLengthFloor)
	} catch (err) {
		logWarn('password policy could not be read, the default minimum applies', err)
		return PASSWORD_DEFAULT_MIN_LENGTH
	}
}
