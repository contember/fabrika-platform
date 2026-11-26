// Passkeys (WebAuthn): the relying party, the ceremonies' options and the verification of their answers. The
// verification itself is `@simplewebauthn/server`'s (CBOR, COSE keys, attestation formats, signatures); this module
// decides what it is checked against and keeps the challenges single-use. Never log a challenge, a credential or a key,
// nor a verifier's error message, which quotes the challenge.

import {
	MAX_PASSKEY_BINDING_LENGTH,
	MAX_PASSKEY_LABEL_LENGTH,
	MAX_PASSKEYS_PER_PERSON,
	PASSKEY_CHALLENGE_TTL_SECONDS,
	PASSKEY_REGISTRATION_BINDING,
	type PasskeyAssertion,
	type PasskeyChallenge,
	type PasskeyCreationOptions,
	type PasskeyDto,
	type PasskeyRegistrationCredential,
	type PasskeyRequestOptions,
	type VerifiedPasskeyAssertion,
} from '@fabrika/iam-contract'
import { uuidv7 } from '@fabrika/platform'
import { verifyAuthenticationResponse, verifyRegistrationResponse, type WebAuthnCredential } from '@simplewebauthn/server'
import { isoBase64URL } from '@simplewebauthn/server/helpers'
import { z } from 'zod'
import { IAM_APP } from './admin/router'
import type { PrincipalRow } from './db'
import type { AuditEventInput } from './repositories/audit'
import type { ConsumedPasskeyChallenge, PasskeyRow } from './repositories/passkeys'
import { unixNow } from './repositories/sql'
import type { Config } from './services'
import type { Services } from './services'

/** ES256, EdDSA and RS256, in the order the authenticator should prefer them. */
const ALGORITHMS = [-7, -8, -257]

/** How many unanswered challenges one person may hold at a time. */
const MAX_OPEN_CHALLENGES = 10

/**
 * Where a passkey is used: IAM's own pages. The origin is IAM's issuer and the RP ID its host, so every ceremony runs on
 * IAM's host, where the person signs in, and a passkey answers there and nowhere else.
 */
export interface RelyingParty {
	readonly id: string
	readonly origin: string
}

export function relyingParty(config: Pick<Config, 'issuer'>): RelyingParty {
	const issuer = new URL(config.issuer)
	return { id: issuer.hostname, origin: issuer.origin }
}

/** Why a ceremony refused. Each is a fixed reason, never a verifier's message. */
export type PasskeyRefusal =
	| 'challenge_unknown'
	| 'challenge_expired'
	| 'binding_mismatch'
	| 'credential_unknown'
	| 'verification_failed'
	| 'counter_regressed'
	| 'step_up_required'
	| 'duplicate'
	| 'limit'

export type PasskeyOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: PasskeyRefusal }

const base64url = z.string().min(1).max(16_384).regex(/^[A-Za-z0-9_-]+$/)
const transports = z.array(z.string().min(1).max(32)).max(8)

export const passkeyBindingSchema = z.string().min(1).max(MAX_PASSKEY_BINDING_LENGTH)
export const passkeyLabelSchema = z.string().trim().min(1).max(MAX_PASSKEY_LABEL_LENGTH)

/** A credential's JSON encoding as the browser sends it; `id` and `rawId` must name the same credential. */
export const registrationCredentialSchema = z.object({
	id: base64url,
	rawId: base64url,
	type: z.literal('public-key'),
	response: z.object({ clientDataJSON: base64url, attestationObject: base64url, transports: transports.optional() }),
}).refine((credential) => credential.id === credential.rawId, 'id and rawId differ')

export const assertionSchema = z.object({
	challengeId: z.string().min(1).max(64),
	credential: z.object({
		id: base64url,
		rawId: base64url,
		type: z.literal('public-key'),
		response: z.object({ clientDataJSON: base64url, authenticatorData: base64url, signature: base64url, userHandle: base64url.optional() }),
	}).refine((credential) => credential.id === credential.rawId, 'id and rawId differ'),
})

export function passkeyDto(row: PasskeyRow): PasskeyDto {
	return { id: row.id, label: row.label, createdAt: row.created_at, lastUsedAt: row.last_used_at }
}

function newChallenge(): string {
	return isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(32)))
}

function storedTransports(row: PasskeyRow): string[] {
	const parsed = transports.safeParse(safeJson(row.transports))
	return parsed.success ? parsed.data : []
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return null
	}
}

function descriptors(rows: readonly PasskeyRow[]): { type: 'public-key'; id: string; transports?: string[] }[] {
	return rows.map((row) => {
		const held = storedTransports(row)
		return held.length === 0 ? { type: 'public-key', id: row.credential_id } : { type: 'public-key', id: row.credential_id, transports: held }
	})
}

/**
 * Issue a registration challenge for the principal; null when it holds too many unanswered ones. `steppedUp` says the
 * caller verified an assertion bound to `PASSKEY_REGISTRATION_BINDING` first, and the challenge carries it as its binding.
 */
export async function issueRegistrationChallenge(
	services: Services,
	rp: RelyingParty,
	principal: PrincipalRow,
	steppedUp: boolean,
): Promise<PasskeyChallenge<PasskeyCreationOptions> | null> {
	const held = await services.repositories.passkeys.list(principal.id)
	const challenge = newChallenge()
	const now = unixNow()
	const expiresAt = now + PASSKEY_CHALLENGE_TTL_SECONDS
	const challengeId = await services.repositories.passkeys.issueChallenge(
		{ principalId: principal.id, kind: 'registration', challenge, binding: steppedUp ? PASSKEY_REGISTRATION_BINDING : '', now, expiresAt },
		MAX_OPEN_CHALLENGES,
	)
	if (challengeId === null) return null
	return {
		challengeId,
		expiresAt,
		options: {
			rp: { id: rp.id, name: rp.id },
			user: { id: isoBase64URL.fromUTF8String(principal.id), name: principal.label, displayName: principal.label },
			challenge,
			pubKeyCredParams: ALGORITHMS.map((alg) => ({ type: 'public-key', alg })),
			timeout: PASSKEY_CHALLENGE_TTL_SECONDS * 1000,
			excludeCredentials: descriptors(held),
			authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
			attestation: 'none',
		},
	}
}

/** Issue an assertion challenge bound to `binding`; null when the principal has no passkey or too many open challenges. */
export async function issueAssertionChallenge(
	services: Services,
	rp: RelyingParty,
	principalId: string,
	binding: string,
): Promise<PasskeyChallenge<PasskeyRequestOptions> | 'no_passkey' | 'too_many'> {
	const held = await services.repositories.passkeys.list(principalId)
	if (held.length === 0) return 'no_passkey'
	const challenge = newChallenge()
	const now = unixNow()
	const expiresAt = now + PASSKEY_CHALLENGE_TTL_SECONDS
	const challengeId = await services.repositories.passkeys.issueChallenge(
		{ principalId, kind: 'assertion', challenge, binding, now, expiresAt },
		MAX_OPEN_CHALLENGES,
	)
	if (challengeId === null) return 'too_many'
	return { challengeId, expiresAt, options: requestOptions(rp, challenge, held) }
}

function requestOptions(rp: RelyingParty, challenge: string, held: readonly PasskeyRow[]): PasskeyRequestOptions {
	return { challenge, rpId: rp.id, timeout: PASSKEY_CHALLENGE_TTL_SECONDS * 1000, allowCredentials: descriptors(held), userVerification: 'required' }
}

/**
 * The options of the principal's open step-up challenge, for IAM's step-up page to answer; null when it is unknown,
 * answered, spent or expired, or the principal holds no passkey any more.
 */
export async function openStepUp(
	services: Services,
	rp: RelyingParty,
	principalId: string,
	challengeId: string,
): Promise<PasskeyChallenge<PasskeyRequestOptions> | null> {
	const issued = await services.repositories.passkeys.openAssertionChallenge(principalId, challengeId)
	if (issued === null || issued.expires_at <= unixNow()) return null
	const held = await services.repositories.passkeys.list(principalId)
	if (held.length === 0) return null
	return { challengeId, expiresAt: issued.expires_at, options: requestOptions(rp, issued.challenge, held) }
}

/**
 * Verify an assertion by one of the principal's passkeys against a challenge issued to it with `binding`. The challenge
 * is consumed before anything is compared, so a wrong answer spends it too. Checked: the challenge (this principal's,
 * unexpired, issued with exactly `binding`), the credential (this principal's), and by the verifier the signature, the
 * challenge in the client data, the origin, the RP ID hash, user presence and user verification, and a signature
 * counter that moved forward (or stays 0 on an authenticator that keeps none). The counter is then stored under a
 * compare-and-set, so two answers racing on one counter accept one.
 */
export async function verifyPasskeyAssertion(
	services: Services,
	rp: RelyingParty,
	principalId: string,
	binding: string,
	assertion: PasskeyAssertion,
): Promise<PasskeyOutcome<VerifiedPasskeyAssertion>> {
	const issued = await services.repositories.passkeys.consumeChallenge(principalId, 'assertion', assertion.challengeId)
	if (issued === null) return refused('challenge_unknown')
	if (issued.binding !== binding) return refused('binding_mismatch')
	return checkAssertion(services, rp, principalId, issued, assertion)
}

/** The checks of an assertion against its issued challenge, after the caller found it: expiry, credential, signature, counter. */
async function checkAssertion(
	services: Services,
	rp: RelyingParty,
	principalId: string,
	issued: ConsumedPasskeyChallenge,
	assertion: PasskeyAssertion,
): Promise<PasskeyOutcome<VerifiedPasskeyAssertion>> {
	const repository = services.repositories.passkeys
	const now = unixNow()
	if (issued.expires_at <= now) return refused('challenge_expired')
	const passkey = await repository.findByCredentialId(principalId, assertion.credential.id)
	if (passkey === null) return refused('credential_unknown')
	const counter = Number(passkey.sign_count)
	let newCounter: number
	try {
		const verified = await verifyAuthenticationResponse({
			response: { ...assertion.credential, clientExtensionResults: {} },
			expectedChallenge: issued.challenge,
			expectedOrigin: rp.origin,
			expectedRPID: rp.id,
			credential: { id: passkey.credential_id, publicKey: isoBase64URL.toBuffer(passkey.public_key), counter, transports: storedTransports(passkey) },
			requireUserVerification: true,
		})
		if (!verified.verified) return refused('verification_failed')
		newCounter = verified.authenticationInfo.newCounter
	} catch {
		return refused('verification_failed')
	}
	if (!await repository.recordUse(passkey.id, counter, newCounter, now)) return refused('counter_regressed')
	return { ok: true, value: { principalId, credentialId: passkey.credential_id, at: now } }
}

/**
 * Answer a step-up challenge on IAM's page: verify the assertion as `verifyPasskeyAssertion` does, against the
 * principal's open assertion challenge whatever its binding, and record the answer on the challenge instead of spending
 * it. Its issuer consumes it with `consumeStepUp`, which compares the binding. A refused answer spends the challenge.
 */
export async function answerStepUp(
	services: Services,
	rp: RelyingParty,
	principalId: string,
	assertion: PasskeyAssertion,
): Promise<PasskeyOutcome<VerifiedPasskeyAssertion>> {
	const repository = services.repositories.passkeys
	const issued = await repository.openAssertionChallenge(principalId, assertion.challengeId)
	if (issued === null) return refused('challenge_unknown')
	const outcome = await checkAssertion(services, rp, principalId, issued, assertion)
	if (!outcome.ok) {
		await repository.dropChallenge(principalId, assertion.challengeId)
		return outcome
	}
	const answered = await repository.markAnswered(principalId, assertion.challengeId, outcome.value.credentialId, outcome.value.at)
	return answered ? outcome : refused('challenge_unknown')
}

/**
 * Consume a step-up challenge answered on IAM's page: the principal's, answered, unexpired, issued with exactly
 * `binding`, and answered by a passkey the principal still holds. It is spent whatever the comparison says.
 */
export async function consumeStepUp(
	services: Services,
	principalId: string,
	binding: string,
	challengeId: string,
): Promise<PasskeyOutcome<VerifiedPasskeyAssertion>> {
	const repository = services.repositories.passkeys
	const answered = await repository.consumeAnswered(principalId, challengeId)
	if (answered === null) return refused('challenge_unknown')
	if (answered.expires_at <= unixNow()) return refused('challenge_expired')
	if (answered.binding !== binding) return refused('binding_mismatch')
	if (await repository.findByCredentialId(principalId, answered.answered_credential_id) === null) return refused('credential_unknown')
	return { ok: true, value: { principalId, credentialId: answered.answered_credential_id, at: answered.answered_at } }
}

/**
 * Verify a registration answer against the principal's registration challenge, then store the passkey with its record.
 * A person who has a passkey already registers another only on a challenge issued after a verified step-up (its binding
 * is `PASSKEY_REGISTRATION_BINDING`).
 */
export async function completeRegistration(
	services: Services,
	rp: RelyingParty,
	principalId: string,
	input: { challengeId: string; label: string; credential: PasskeyRegistrationCredential },
	audit: (passkeyId: string) => AuditEventInput,
): Promise<PasskeyOutcome<PasskeyRow>> {
	const id = uuidv7()
	const repository = services.repositories.passkeys
	const issued = await repository.consumeChallenge(principalId, 'registration', input.challengeId)
	if (issued === null) return refused('challenge_unknown')
	const now = unixNow()
	if (issued.expires_at <= now) return refused('challenge_expired')
	let credential: WebAuthnCredential
	try {
		const verified = await verifyRegistrationResponse({
			response: { ...input.credential, clientExtensionResults: {} },
			expectedChallenge: issued.challenge,
			expectedOrigin: rp.origin,
			expectedRPID: rp.id,
			requireUserPresence: true,
			requireUserVerification: true,
			supportedAlgorithmIDs: ALGORITHMS,
		})
		if (!verified.verified) return refused('verification_failed')
		credential = verified.registrationInfo.credential
	} catch {
		return refused('verification_failed')
	}
	const passkeyTransports = transports.safeParse(input.credential.response.transports ?? credential.transports ?? [])
	const stored = await repository.insert(
		{
			id,
			principalId,
			credentialId: credential.id,
			publicKey: isoBase64URL.fromBuffer(credential.publicKey),
			signCount: credential.counter,
			transports: passkeyTransports.success ? passkeyTransports.data : [],
			label: input.label,
			createdAt: now,
		},
		{ steppedUp: issued.binding === PASSKEY_REGISTRATION_BINDING, max: MAX_PASSKEYS_PER_PERSON },
		audit(id),
	)
	return typeof stored === 'string' ? refused(stored) : { ok: true, value: stored }
}

/** How many passkeys removed by migration 0047 one maintenance pass records. */
const MOVED_PER_PASS = 500

/**
 * Record each passkey migration 0047 removed, because it answered on the console's host and can never answer on IAM's,
 * as one `iam.passkey.reset` filed under its owner with the reason `rp_moved`, and forget it. Run by the maintenance
 * pass; a later pass takes the rest. Answers how many it recorded.
 */
export async function recordMovedPasskeys(services: Services): Promise<number> {
	const repository = services.repositories.passkeys
	let recorded = 0
	for (const moved of await repository.listMoved(MOVED_PER_PASS)) {
		const event: AuditEventInput = {
			requestId: uuidv7(),
			principalId: null,
			principalLabel: 'iam-maintenance',
			app: IAM_APP,
			action: 'iam.passkey.reset',
			resourceType: 'principal',
			resourceId: moved.principal_id,
			metadata: { passkeyId: moved.id, label: moved.label, reason: 'rp_moved' },
		}
		if (await repository.recordMoved(moved.id, event)) recorded++
	}
	return recorded
}

function refused(reason: PasskeyRefusal): { ok: false; reason: PasskeyRefusal } {
	return { ok: false, reason }
}
