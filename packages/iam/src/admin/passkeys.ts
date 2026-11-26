// Passkeys over `/admin/rpc`: the step-up seam and an installation administrator's reset. A person registers and
// removes their own passkeys on IAM's account page, where every ceremony runs (RP ID = IAM's host). The step-up seam is
// a person's own, in a signed-in session (the console's token), never a `px_` key: Control asks for a challenge bound to
// what it guards, the person answers it on IAM's step-up page, and Control verifies the answer against the same
// binding. A person who can no longer answer with any passkey asks an installation administrator, who resets them.

import { ForbiddenError, UnauthorizedError } from '@fabrika/app'
import {
	type IssuePasskeyChallengeRequest,
	type ListResponse,
	NO_PASSKEY_ERROR,
	type PasskeyDto,
	type PasskeyResetResponse,
	type PasskeyStepUpChallenge,
	type PrincipalIdInput,
	type VerifiedPasskeyAssertion,
	type VerifyPasskeyAssertionRequest,
} from '@fabrika/iam-contract'
import type { IamAppContext } from '../app'
import { stepUpUrl } from '../auth/passkey-pages'
import { consumeStepUp, issueAssertionChallenge, passkeyDto, type PasskeyRefusal, relyingParty } from '../passkeys'
import { type AdminContext, adminEvent, fail } from './context'

/** The person behind a signed-in session's console token. */
async function person(ctx: IamAppContext): Promise<string> {
	const admin = ctx.admin
	if (admin === null) throw new UnauthorizedError()
	if (!admin.session || admin.type !== 'user') {
		throw new ForbiddenError('a passkey step-up is answered by a person signed in to the console, never with an API key')
	}
	const principal = await ctx.services.repositories.principals.getPrincipalById(admin.id)
	if (principal === null) throw new UnauthorizedError()
	return principal.id
}

/** The refusal a caller sees. A failed verification says no more than that, whichever check failed. */
function refuse(reason: PasskeyRefusal): never {
	switch (reason) {
		case 'challenge_unknown':
		case 'challenge_expired':
			return fail(409, 'the passkey check was not completed, or it expired or was used already; confirm it again')
		case 'binding_mismatch':
			return fail(403, 'the passkey challenge was issued for something else')
		case 'credential_unknown':
		case 'verification_failed':
		case 'counter_regressed':
		case 'step_up_required':
		case 'duplicate':
		case 'limit':
			return fail(403, 'the passkey was not accepted')
	}
}

/**
 * Issue an assertion challenge bound to the caller's `binding`, answered on IAM's step-up page at its `url`. A person
 * without a passkey has nothing to answer it with.
 */
export async function issuePasskeyChallenge(ctx: IamAppContext, input: IssuePasskeyChallengeRequest): Promise<PasskeyStepUpChallenge> {
	const principalId = await person(ctx)
	const issued = await issueAssertionChallenge(ctx.services, relyingParty(ctx.services.config), principalId, input.binding)
	if (issued === 'no_passkey') return fail(409, 'no passkey is registered; add one on your IAM account page', NO_PASSKEY_ERROR)
	if (issued === 'too_many') return fail(429, 'too many open passkey challenges; try again in a few minutes')
	return { challengeId: issued.challengeId, expiresAt: issued.expiresAt, url: stepUpUrl(ctx.services.config, issued.challengeId) }
}

/** Verify that the caller answered a challenge issued with `binding`. The step-up seam: it records nothing but the use. */
export async function verifyPasskeyChallenge(ctx: IamAppContext, input: VerifyPasskeyAssertionRequest): Promise<VerifiedPasskeyAssertion> {
	const verified = await consumeStepUp(ctx.services, await person(ctx), input.binding, input.challengeId)
	return verified.ok ? verified.value : refuse(verified.reason)
}

export async function listPasskeysOf(c: AdminContext, input: PrincipalIdInput): Promise<ListResponse<PasskeyDto>> {
	await requireInstallationPrincipal(c, input.principalId)
	return { items: (await c.services.repositories.passkeys.list(input.principalId)).map(passkeyDto) }
}

/** Remove every passkey of the person, recorded as `iam.passkey.reset`; a person without one records nothing. */
export async function resetPasskeys(c: AdminContext, input: PrincipalIdInput): Promise<PasskeyResetResponse> {
	await requireInstallationPrincipal(c, input.principalId)
	const removed = await c.services.repositories.passkeys.reset(
		input.principalId,
		adminEvent(c, { action: 'iam.passkey.reset', resourceType: 'principal', resourceId: input.principalId }),
	)
	return { removed }
}

/** `.require(iam.admin)` gates these procedures already; a direct caller of a use case meets the same rule. */
async function requireInstallationPrincipal(c: AdminContext, principalId: string): Promise<void> {
	if (c.administration.kind !== 'installation') return fail(403, 'passkeys are read and reset only by an installation administrator')
	if (await c.services.repositories.principals.getPrincipalById(principalId) === null) fail(404, 'principal not found')
}
