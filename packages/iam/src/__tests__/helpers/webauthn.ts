// A software authenticator for tests: an ES256 key pair made with WebCrypto, and the bytes a browser and an
// authenticator would send, assembled one by one (client data, authenticator data, a `none` attestation object and a
// DER signature). IAM verifies them with its real verifier; nothing here stands in for it.

import type { PasskeyAssertionCredential, PasskeyCreationOptions, PasskeyRegistrationCredential, PasskeyRequestOptions } from '@fabrika/iam-contract'
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers'

const FLAG_UP = 0x01
const FLAG_UV = 0x04
const FLAG_AT = 0x40

export interface CeremonyOverrides {
	/** The origin the "browser" writes into the client data. */
	origin?: string
	/** The RP ID whose hash the authenticator writes. */
	rpId?: string
	/** The challenge the client data names, instead of the one issued. */
	challenge?: string
	/** User presence and verification; both set by default. */
	userPresent?: boolean
	userVerified?: boolean
	/** The signature counter to report; the authenticator's next one by default. */
	counter?: number
	/** Sign with another key than the registered one. */
	signWith?: CryptoKey
}

export class TestAuthenticator {
	private constructor(
		readonly keys: CryptoKeyPair,
		readonly credentialId: string,
		private counter: number,
	) {}

	/** A new authenticator; `counting: false` reports 0 on every signature, as a synced passkey does. */
	static async create(options: { counting?: boolean } = {}): Promise<TestAuthenticator> {
		const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
		const id = isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(16)))
		return new TestAuthenticator(keys, id, options.counting === false ? -1 : 0)
	}

	private nextCounter(): number {
		if (this.counter < 0) return 0
		this.counter += 1
		return this.counter
	}

	async register(options: PasskeyCreationOptions, origin: string, overrides: CeremonyOverrides = {}): Promise<PasskeyRegistrationCredential> {
		const clientData = clientDataJSON('webauthn.create', overrides.challenge ?? options.challenge, overrides.origin ?? origin)
		const counter = overrides.counter ?? this.nextCounter()
		const credentialId = isoBase64URL.toBuffer(this.credentialId)
		const attested = concat(new Uint8Array(16), u16(credentialId.length), credentialId, await this.cosePublicKey())
		const authData = concat(await rpIdHash(overrides.rpId ?? options.rp.id), Uint8Array.of(flags(overrides) | FLAG_AT), u32(counter), attested)
		const attestationObject = isoCBOR.encode(
			new Map<string, string | Map<string, string> | Uint8Array>([['fmt', 'none'], ['attStmt', new Map<string, string>()], ['authData', authData]]),
		)
		return {
			id: this.credentialId,
			rawId: this.credentialId,
			type: 'public-key',
			response: {
				clientDataJSON: isoBase64URL.fromBuffer(clientData),
				attestationObject: isoBase64URL.fromBuffer(attestationObject),
				transports: ['internal'],
			},
		}
	}

	async assert(options: PasskeyRequestOptions, origin: string, overrides: CeremonyOverrides = {}): Promise<PasskeyAssertionCredential> {
		const clientData = clientDataJSON('webauthn.get', overrides.challenge ?? options.challenge, overrides.origin ?? origin)
		const counter = overrides.counter ?? this.nextCounter()
		const authData = concat(await rpIdHash(overrides.rpId ?? options.rpId), Uint8Array.of(flags(overrides)), u32(counter))
		const signed = concat(authData, new Uint8Array(await crypto.subtle.digest('SHA-256', clientData)))
		const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, overrides.signWith ?? this.keys.privateKey, signed))
		return {
			id: this.credentialId,
			rawId: this.credentialId,
			type: 'public-key',
			response: {
				clientDataJSON: isoBase64URL.fromBuffer(clientData),
				authenticatorData: isoBase64URL.fromBuffer(authData),
				signature: isoBase64URL.fromBuffer(derSignature(raw)),
			},
		}
	}

	/** The public key as COSE_Key: EC2 (1: 2), ES256 (3: -7), P-256 (-1: 1), x (-2) and y (-3). */
	private async cosePublicKey(): Promise<Uint8Array> {
		const jwk = await crypto.subtle.exportKey('jwk', this.keys.publicKey)
		if (jwk.x === undefined || jwk.y === undefined) throw new Error('an EC key exports x and y')
		return isoCBOR.encode(
			new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, isoBase64URL.toBuffer(jwk.x)], [-3, isoBase64URL.toBuffer(jwk.y)]]),
		)
	}
}

function flags(overrides: CeremonyOverrides): number {
	return (overrides.userPresent === false ? 0 : FLAG_UP) | (overrides.userVerified === false ? 0 : FLAG_UV)
}

function clientDataJSON(type: string, challenge: string, origin: string): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }))
}

async function rpIdHash(rpId: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId)))
}

function u16(value: number): Uint8Array {
	return Uint8Array.of(value >> 8, value & 0xff)
}

function u32(value: number): Uint8Array {
	const bytes = new Uint8Array(4)
	new DataView(bytes.buffer).setUint32(0, value)
	return bytes
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
	let offset = 0
	for (const part of parts) {
		out.set(part, offset)
		offset += part.length
	}
	return out
}

/** WebCrypto signs ECDSA as r‖s; WebAuthn carries an ASN.1 DER `SEQUENCE { INTEGER r, INTEGER s }`. */
function derSignature(raw: Uint8Array): Uint8Array<ArrayBuffer> {
	const integer = (bytes: Uint8Array): Uint8Array => {
		let start = 0
		while (start < bytes.length - 1 && bytes[start] === 0) start += 1
		const trimmed = bytes.slice(start)
		const body = (trimmed[0] ?? 0) & 0x80 ? concat(Uint8Array.of(0), trimmed) : trimmed
		return concat(Uint8Array.of(0x02, body.length), body)
	}
	const body = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)))
	return concat(Uint8Array.of(0x30, body.length), body)
}
