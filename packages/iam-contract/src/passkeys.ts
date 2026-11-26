// A person's passkeys (WebAuthn), kept by IAM. Every ceremony runs on IAM's own pages, under IAM's host as the RP ID: the
// person registers and removes passkeys on IAM's account page, and a step-up another service asks for is answered on
// IAM's step-up page. Every binary value travels base64url-encoded, as in WebAuthn's JSON encodings.

/** How long a ceremony's challenge can be answered, in seconds. */
export const PASSKEY_CHALLENGE_TTL_SECONDS = 300

/** The longest label a person may give a passkey, in characters. */
export const MAX_PASSKEY_LABEL_LENGTH = 64

/** The longest binding a challenge may carry. */
export const MAX_PASSKEY_BINDING_LENGTH = 512

/** How many passkeys one person may keep. */
export const MAX_PASSKEYS_PER_PERSON = 20

/** The error `type` of `passkeys.challenge`'s refusal to a person with no passkey, so a caller tells it from other 409s. */
export const NO_PASSKEY_ERROR = 'no_passkey'

/**
 * The prefix of the bindings IAM's own pages use. Another service never asks a step-up with one, and IAM's step-up page
 * never answers one, so a check IAM asks for itself is answered only on the page that asked it.
 */
export const IAM_BINDING_PREFIX = 'iam:'

/** The binding of the assertion that registering another passkey takes, when the person already has one. */
export const PASSKEY_REGISTRATION_BINDING = `${IAM_BINDING_PREFIX}passkeys.register`

/** The binding of the assertion that removing the passkey `passkeyId` takes. */
export function passkeyRemovalBinding(passkeyId: string): string {
	return `${IAM_BINDING_PREFIX}passkeys.remove:${passkeyId}`
}

/** A passkey as its owner and an installation administrator see it. No key material. */
export interface PasskeyDto {
	id: string
	label: string
	/** Epoch seconds. */
	createdAt: number
	/** Epoch seconds of the last accepted assertion; null before the first. */
	lastUsedAt: number | null
}

export interface PasskeyCredentialDescriptor {
	type: 'public-key'
	/** The credential id, base64url. */
	id: string
	transports?: string[]
}

/** `PublicKeyCredentialCreationOptions` in its JSON encoding: what `navigator.credentials.create` takes. */
export interface PasskeyCreationOptions {
	rp: { id: string; name: string }
	user: { id: string; name: string; displayName: string }
	challenge: string
	pubKeyCredParams: { type: 'public-key'; alg: number }[]
	timeout: number
	/** The person's passkeys, so an authenticator holding one of them does not register it again. */
	excludeCredentials: PasskeyCredentialDescriptor[]
	authenticatorSelection: { residentKey: 'preferred'; userVerification: 'required' }
	attestation: 'none'
}

/** `PublicKeyCredentialRequestOptions` in its JSON encoding: what `navigator.credentials.get` takes. */
export interface PasskeyRequestOptions {
	challenge: string
	rpId: string
	timeout: number
	/** The person's own passkeys; no other credential can answer. */
	allowCredentials: PasskeyCredentialDescriptor[]
	userVerification: 'required'
}

/** A challenge IAM issued, to be answered once before `expiresAt` (epoch seconds). */
export interface PasskeyChallenge<Options> {
	challengeId: string
	expiresAt: number
	options: Options
}

/** What `navigator.credentials.create` answered, in its JSON encoding. */
export interface PasskeyRegistrationCredential {
	id: string
	rawId: string
	type: 'public-key'
	response: {
		clientDataJSON: string
		attestationObject: string
		transports?: string[]
	}
}

/** What `navigator.credentials.get` answered, in its JSON encoding. */
export interface PasskeyAssertionCredential {
	id: string
	rawId: string
	type: 'public-key'
	response: {
		clientDataJSON: string
		authenticatorData: string
		signature: string
		userHandle?: string
	}
}

/** An answered assertion challenge. */
export interface PasskeyAssertion {
	challengeId: string
	credential: PasskeyAssertionCredential
}

export interface IssuePasskeyChallengeRequest {
	/** What the assertion is for, compared verbatim at verification. Opaque to IAM. */
	binding: string
}

/**
 * A step-up challenge IAM issued to the person: they answer it on IAM's page at `url` before `expiresAt` (epoch
 * seconds), and its issuer then verifies it by `challengeId`.
 */
export interface PasskeyStepUpChallenge {
	challengeId: string
	expiresAt: number
	url: string
}

export interface VerifyPasskeyAssertionRequest {
	/** The binding the challenge was issued with. */
	binding: string
	/** The challenge the person answered on IAM's step-up page. */
	challengeId: string
}

/** A verified assertion: who answered, with which credential (its WebAuthn id, base64url), and when (epoch seconds). */
export interface VerifiedPasskeyAssertion {
	principalId: string
	credentialId: string
	at: number
}

export interface PasskeyResetResponse {
	/** How many passkeys the reset removed. */
	removed: number
}
