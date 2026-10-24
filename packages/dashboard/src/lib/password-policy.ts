import { PASSWORD_SINGLE_FACTOR_FLOOR, type PasswordPolicyDto } from '@fabrika/iam-contract'

/** What the console says about a minimum: nothing at the default or above, a note below it, a warning below 8. */
export type MinLengthRisk = 'none' | 'below-default' | 'below-single-factor'

export function minLengthRisk(minLength: number, defaultMinLength: number): MinLengthRisk {
	if (minLength < PASSWORD_SINGLE_FACTOR_FLOOR) return 'below-single-factor'
	if (minLength < defaultMinLength) return 'below-default'
	return 'none'
}

/** A typed minimum as IAM would store it, or why IAM would refuse it, in words the page shows. */
export type TypedMinLength = { readonly ok: true; readonly value: number } | { readonly ok: false; readonly message: string }

export function typedMinLength(raw: string, policy: Pick<PasswordPolicyDto, 'minLengthFloor' | 'maxLength'>): TypedMinLength {
	const trimmed = raw.trim()
	const range = `Enter a whole number from ${policy.minLengthFloor} to ${policy.maxLength}.`
	if (!/^\d+$/.test(trimmed)) return { ok: false, message: range }
	const value = Number(trimmed)
	if (value < policy.minLengthFloor || value > policy.maxLength) return { ok: false, message: range }
	return { ok: true, value }
}
