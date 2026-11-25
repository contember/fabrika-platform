// The browser half of IAM's passkey ceremonies: turn IAM's JSON options into what `navigator.credentials` takes, and
// its answer back into JSON. Plain WebAuthn with base64url helpers; IAM verifies everything.

import type {
	PasskeyAssertion,
	PasskeyAssertionCredential,
	PasskeyChallenge,
	PasskeyCreationOptions,
	PasskeyCredentialDescriptor,
	PasskeyRegistrationCredential,
	PasskeyRequestOptions,
} from '@fabrika/iam-contract'

/** What the console needs of `navigator.credentials`; a test passes its own. */
export interface PasskeyCredentials {
	create(options: CredentialCreationOptions): Promise<unknown>
	get(options: CredentialRequestOptions): Promise<unknown>
}

/** The browser's own credentials container, or null where it has no WebAuthn. */
export function browserCredentials(): PasskeyCredentials | null {
	if (typeof window === 'undefined' || typeof window.PublicKeyCredential === 'undefined' || navigator.credentials === undefined) return null
	return navigator.credentials
}

export function toBase64Url(bytes: ArrayBuffer | ArrayBufferView): string {
	const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	let binary = ''
	for (const byte of view) binary += String.fromCharCode(byte)
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function fromBase64Url(text: string): ArrayBuffer {
	const base64 = text.replaceAll('-', '+').replaceAll('_', '/')
	const binary = atob(base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '='))
	const bytes = new Uint8Array(new ArrayBuffer(binary.length))
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
	return bytes.buffer
}

const TRANSPORTS: readonly AuthenticatorTransport[] = ['ble', 'hybrid', 'internal', 'nfc', 'usb']

function isTransport(value: string): value is AuthenticatorTransport {
	return TRANSPORTS.some((transport) => transport === value)
}

function descriptor(credential: PasskeyCredentialDescriptor): PublicKeyCredentialDescriptor {
	const transports = (credential.transports ?? []).filter(isTransport)
	return transports.length === 0
		? { type: 'public-key', id: fromBase64Url(credential.id) }
		: { type: 'public-key', id: fromBase64Url(credential.id), transports }
}

export function creationOptions(options: PasskeyCreationOptions): CredentialCreationOptions {
	return {
		publicKey: {
			rp: options.rp,
			user: { id: fromBase64Url(options.user.id), name: options.user.name, displayName: options.user.displayName },
			challenge: fromBase64Url(options.challenge),
			pubKeyCredParams: options.pubKeyCredParams,
			timeout: options.timeout,
			excludeCredentials: options.excludeCredentials.map(descriptor),
			authenticatorSelection: options.authenticatorSelection,
			attestation: options.attestation,
		},
	}
}

export function requestOptions(options: PasskeyRequestOptions): CredentialRequestOptions {
	return {
		publicKey: {
			challenge: fromBase64Url(options.challenge),
			rpId: options.rpId,
			timeout: options.timeout,
			allowCredentials: options.allowCredentials.map(descriptor),
			userVerification: options.userVerification,
		},
	}
}

/** A field of a browser object, its prototype's getters included: a DOM credential keeps its fields there. */
function field(value: unknown, key: string): unknown {
	if (typeof value !== 'object' || value === null || !(key in value)) return undefined
	const read: unknown = Reflect.get(value, key)
	return read
}

function bytes(value: unknown): string | null {
	return value instanceof ArrayBuffer || ArrayBuffer.isView(value) ? toBase64Url(value) : null
}

/** A browser's answer read as a public-key credential: its id and its response; null for anything else. */
function publicKeyCredential(value: unknown): { id: string; response: unknown } | null {
	if (field(value, 'type') !== 'public-key') return null
	const id = bytes(field(value, 'rawId'))
	return id === null ? null : { id, response: field(value, 'response') }
}

/** The transports the authenticator reported, where the browser says (only a real browser does). */
function reportedTransports(response: unknown): string[] | undefined {
	if (typeof AuthenticatorAttestationResponse === 'undefined' || !(response instanceof AuthenticatorAttestationResponse)) return undefined
	const transports = response.getTransports()
	return transports.length === 0 ? undefined : transports
}

export class PasskeyCeremonyError extends Error {}

/** The words for a failure of the browser's prompt: cancelled, timed out, already registered, or unavailable. */
export function ceremonyFailure(cause: unknown): string {
	const name = field(cause, 'name')
	if (name === 'NotAllowedError') return 'The passkey prompt was cancelled or timed out. Try again.'
	if (name === 'InvalidStateError') return 'This authenticator already holds one of your passkeys.'
	if (name === 'SecurityError') return 'This browser refused the passkey for this address.'
	if (cause instanceof PasskeyCeremonyError) return cause.message
	return 'The passkey prompt failed. Try again.'
}

/** Run `navigator.credentials.create` for IAM's options and answer IAM's JSON encoding. */
export async function createPasskey(credentials: PasskeyCredentials, options: PasskeyCreationOptions): Promise<PasskeyRegistrationCredential> {
	const credential = publicKeyCredential(await credentials.create(creationOptions(options)))
	const clientDataJSON = bytes(field(credential?.response, 'clientDataJSON'))
	const attestationObject = bytes(field(credential?.response, 'attestationObject'))
	if (credential === null || clientDataJSON === null || attestationObject === null) throw new PasskeyCeremonyError('The browser answered no passkey.')
	const transports = reportedTransports(credential.response)
	return {
		id: credential.id,
		rawId: credential.id,
		type: 'public-key',
		response: transports === undefined ? { clientDataJSON, attestationObject } : { clientDataJSON, attestationObject, transports },
	}
}

/** Run `navigator.credentials.get` for IAM's options and answer IAM's JSON encoding. */
export async function assertPasskey(credentials: PasskeyCredentials, options: PasskeyRequestOptions): Promise<PasskeyAssertionCredential> {
	const credential = publicKeyCredential(await credentials.get(requestOptions(options)))
	const response = credential?.response
	const clientDataJSON = bytes(field(response, 'clientDataJSON'))
	const authenticatorData = bytes(field(response, 'authenticatorData'))
	const signature = bytes(field(response, 'signature'))
	if (credential === null || clientDataJSON === null || authenticatorData === null || signature === null) {
		throw new PasskeyCeremonyError('The browser answered no passkey.')
	}
	const userHandle = bytes(field(response, 'userHandle'))
	return {
		id: credential.id,
		rawId: credential.id,
		type: 'public-key',
		response: userHandle === null ? { clientDataJSON, authenticatorData, signature } : { clientDataJSON, authenticatorData, signature, userHandle },
	}
}

/**
 * The step-up: ask for a challenge (the caller decides what it is bound to), let the person answer it with a passkey,
 * and answer the assertion for the caller to send with the change it guards. IAM verifies it, once.
 */
export async function stepUpWithPasskey(
	credentials: PasskeyCredentials,
	fetchChallenge: () => Promise<PasskeyChallenge<PasskeyRequestOptions>>,
): Promise<PasskeyAssertion> {
	const issued = await fetchChallenge()
	return { challengeId: issued.challengeId, credential: await assertPasskey(credentials, issued.options) }
}
