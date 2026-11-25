// A person's passkeys over `/admin/rpc`. The person's own procedures need a person in a signed-in session (the console's
// token), never a `px_` key: a passkey is used in the console, by the person. Changing the set of passkeys (registering
// another while one exists, removing one) takes an assertion by one of the person's current passkeys bound to that
// change, so a browser driven by somebody else cannot swap in an authenticator of its own. A person who can no longer
// answer one asks an installation administrator, who resets every passkey of the person (`iam.admin` only).

import { ForbiddenError, UnauthorizedError } from '@fabrika/app'
import {
	type IssuePasskeyChallengeRequest,
	type ListResponse,
	NO_PASSKEY_ERROR,
	type OkResponse,
	PASSKEY_REGISTRATION_BINDING,
	type PasskeyAssertion,
	type PasskeyChallenge,
	type PasskeyCreationOptions,
	type PasskeyDto,
	passkeyRemovalBinding,
	type PasskeyRequestOptions,
	type PasskeyResetResponse,
	type PrincipalIdInput,
	type RegisterPasskeyRequest,
	type RemovePasskeyRequest,
	type VerifiedPasskeyAssertion,
	type VerifyPasskeyAssertionRequest,
} from '@fabrika/iam-contract'
import type { IamAppContext } from '../app'
import { type AuditEventInput, auditLabelOf, type PrincipalRow } from '../db'
import {
	completeRegistration,
	issueAssertionChallenge,
	issueRegistrationChallenge,
	passkeyDto,
	type PasskeyRefusal,
	type RelyingParty,
	relyingPartyOf,
	verifyPasskeyAssertion,
} from '../passkeys'
import { type AdminContext, adminEvent, fail } from './context'
import { IAM_APP } from './router'

/** The person behind a signed-in session's console token. */
interface Person {
	readonly ctx: IamAppContext
	readonly principal: PrincipalRow
	readonly audience: string
}

async function person(ctx: IamAppContext): Promise<Person> {
	const admin = ctx.admin
	if (admin === null) throw new UnauthorizedError()
	if (!admin.session || admin.type !== 'user') {
		throw new ForbiddenError('passkeys are managed by a person signed in to the console, never with an API key')
	}
	const principal = await ctx.services.repositories.principals.getPrincipalById(admin.id)
	if (principal === null) throw new UnauthorizedError()
	return { ctx, principal, audience: admin.audience }
}

/** The console the caller's token was minted for, where its passkeys answer. */
async function relyingParty(p: Person): Promise<RelyingParty> {
	return await relyingPartyOf(p.ctx.services, p.audience) ?? fail(409, 'the console has no registered origin, so a passkey cannot be bound to it')
}

function personEvent(p: Person, action: string, passkeyId: string): AuditEventInput {
	return {
		requestId: p.ctx.requestId,
		principalId: p.principal.id,
		principalLabel: auditLabelOf(p.principal),
		app: IAM_APP,
		action,
		resourceType: 'principal',
		resourceId: p.principal.id,
		metadata: { passkeyId },
	}
}

/** The refusal a caller sees. A failed verification says no more than that, whichever check failed. */
function refuse(reason: PasskeyRefusal): never {
	switch (reason) {
		case 'challenge_unknown':
		case 'challenge_expired':
			return fail(409, 'the passkey challenge expired or was already answered; ask for a new one')
		case 'binding_mismatch':
			return fail(403, 'the passkey challenge was issued for something else')
		case 'step_up_required':
			return fail(403, 'adding another passkey takes a fresh check with one you already have')
		case 'duplicate':
			return fail(409, 'this passkey is registered already')
		case 'limit':
			return fail(409, 'a person keeps at most 20 passkeys; remove one first')
		case 'credential_unknown':
		case 'verification_failed':
		case 'counter_regressed':
			return fail(403, 'the passkey was not accepted')
	}
}

async function stepUp(p: Person, binding: string, assertion: PasskeyAssertion): Promise<VerifiedPasskeyAssertion> {
	const verified = await verifyPasskeyAssertion(p.ctx.services, await relyingParty(p), p.principal.id, binding, assertion)
	return verified.ok ? verified.value : refuse(verified.reason)
}

export async function listOwnPasskeys(ctx: IamAppContext): Promise<ListResponse<PasskeyDto>> {
	const p = await person(ctx)
	return { items: (await ctx.services.repositories.passkeys.list(p.principal.id)).map(passkeyDto) }
}

export async function beginPasskeyRegistration(ctx: IamAppContext): Promise<PasskeyChallenge<PasskeyCreationOptions>> {
	const p = await person(ctx)
	return await issueRegistrationChallenge(ctx.services, await relyingParty(p), p.principal)
		?? fail(429, 'too many open passkey challenges; try again in a few minutes')
}

/** Register the passkey the console created. A person who has one already sends an assertion bound to the registration. */
export async function registerPasskey(ctx: IamAppContext, input: RegisterPasskeyRequest): Promise<PasskeyDto> {
	const p = await person(ctx)
	if (input.stepUp !== undefined) await stepUp(p, PASSKEY_REGISTRATION_BINDING, input.stepUp)
	const registered = await completeRegistration(
		ctx.services,
		await relyingParty(p),
		p.principal.id,
		{ challengeId: input.challengeId, label: input.label, credential: input.credential, steppedUp: input.stepUp !== undefined },
		(passkeyId) => personEvent(p, 'iam.passkey.register', passkeyId),
	)
	return registered.ok ? passkeyDto(registered.value) : refuse(registered.reason)
}

/** Remove one of the person's passkeys, after an assertion bound to its removal (by it or by another of theirs). */
export async function removePasskey(ctx: IamAppContext, input: RemovePasskeyRequest): Promise<OkResponse> {
	const p = await person(ctx)
	const held = await ctx.services.repositories.passkeys.list(p.principal.id)
	if (!held.some((row) => row.id === input.passkeyId)) return fail(404, 'passkey not found')
	await stepUp(p, passkeyRemovalBinding(input.passkeyId), input.stepUp)
	if (!await ctx.services.repositories.passkeys.remove(p.principal.id, input.passkeyId, personEvent(p, 'iam.passkey.remove', input.passkeyId))) {
		return fail(404, 'passkey not found')
	}
	return { ok: true }
}

/** Issue an assertion challenge bound to the caller's `binding`; a person without a passkey has nothing to answer it with. */
export async function issuePasskeyChallenge(
	ctx: IamAppContext,
	input: IssuePasskeyChallengeRequest,
): Promise<PasskeyChallenge<PasskeyRequestOptions>> {
	const p = await person(ctx)
	const issued = await issueAssertionChallenge(ctx.services, await relyingParty(p), p.principal.id, input.binding)
	if (issued === 'no_passkey') return fail(409, 'no passkey is registered; register one under Account → Passkeys', NO_PASSKEY_ERROR)
	if (issued === 'too_many') return fail(429, 'too many open passkey challenges; try again in a few minutes')
	return issued
}

/** Verify the caller's answer to a challenge issued with `binding`. The step-up seam: it records nothing but the use. */
export async function verifyPasskeyChallenge(ctx: IamAppContext, input: VerifyPasskeyAssertionRequest): Promise<VerifiedPasskeyAssertion> {
	return stepUp(await person(ctx), input.binding, input.assertion)
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
