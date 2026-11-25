// Passkeys (WebAuthn): the relying party, the ceremonies' options and the verification of their answers. The
// verification itself is `@simplewebauthn/server`'s (CBOR, COSE keys, attestation formats, signatures); this module
// decides what it is checked against and keeps the challenges single-use. Never log a challenge, a credential or a key,
// nor a verifier's error message, which quotes the challenge.

import {
	MAX_PASSKEY_BINDING_LENGTH,
	MAX_PASSKEY_LABEL_LENGTH,
	MAX_PASSKEYS_PER_PERSON,
	PASSKEY_CHALLENGE_TTL_SECONDS,
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
import { registeredLanding } from './app-presentation'
import type { PrincipalRow } from './db'
import type { AuditEventInput } from './repositories/audit'
import type { PasskeyRow } from './repositories/passkeys'
import { unixNow } from './repositories/sql'
import type { Services } from './services'

/** ES256, EdDSA and RS256, in the order the authenticator should prefer them. */
const ALGORITHMS = [-7, -8, -257]

/** How many unanswered challenges one person may hold at a time. */
const MAX_OPEN_CHALLENGES = 10

/**
 * Where a passkey is used: the console the caller's token was minted for. Its origin is that application's first
 * registered return origin, and its RP ID that origin's host, so a passkey answers on the console and nowhere else.
 */
export interface RelyingParty {
	readonly id: string
	readonly origin: string
}

export async function relyingPartyOf(services: Services, audience: string): Promise<RelyingParty | null> {
	const origin = await registeredLanding(services, audience)
	return origin === null ? null : { id: new URL(origin).hostname, origin }
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

/** Issue a registration challenge for the principal; null when it holds too many unanswered ones. */
export async function issueRegistrationChallenge(
	services: Services,
	rp: RelyingParty,
	principal: PrincipalRow,
): Promise<PasskeyChallenge<PasskeyCreationOptions> | null> {
	const held = await services.repositories.passkeys.list(principal.id)
	const challenge = newChallenge()
	const now = unixNow()
	const expiresAt = now + PASSKEY_CHALLENGE_TTL_SECONDS
	const challengeId = await services.repositories.passkeys.issueChallenge(
		{ principalId: principal.id, kind: 'registration', challenge, binding: '', now, expiresAt },
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
	return {
		challengeId,
		expiresAt,
		options: {
			challenge,
			rpId: rp.id,
			timeout: PASSKEY_CHALLENGE_TTL_SECONDS * 1000,
			allowCredentials: descriptors(held),
			userVerification: 'required',
		},
	}
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
	const repository = services.repositories.passkeys
	const issued = await repository.consumeChallenge(principalId, 'assertion', assertion.challengeId)
	if (issued === null) return refused('challenge_unknown')
	const now = unixNow()
	if (issued.expires_at <= now) return refused('challenge_expired')
	if (issued.binding !== binding) return refused('binding_mismatch')
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
 * Verify a registration answer against the principal's registration challenge, then store the passkey with its record.
 * A person who has a passkey already registers another only `steppedUp` (the caller verified an assertion first).
 */
export async function completeRegistration(
	services: Services,
	rp: RelyingParty,
	principalId: string,
	input: { challengeId: string; label: string; credential: PasskeyRegistrationCredential; steppedUp: boolean },
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
		{ steppedUp: input.steppedUp, max: MAX_PASSKEYS_PER_PERSON },
		audit(id),
	)
	return typeof stored === 'string' ? refused(stored) : { ok: true, value: stored }
}

function refused(reason: PasskeyRefusal): { ok: false; reason: PasskeyRefusal } {
	return { ok: false, reason }
}
