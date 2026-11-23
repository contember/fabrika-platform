// TOTP (RFC 6238 over RFC 4226): HMAC-SHA1, 30-second steps, 6 digits — the parameters every authenticator app reads
// from an `otpauth://` URI without asking. Pure functions over WebCrypto, so both runtimes run the same code.

import { renderSVG } from 'uqr'
import { hashToken } from './secret'

export const TOTP_PERIOD_SECONDS = 30
export const TOTP_DIGITS = 6
/** 160 bits, RFC 4226's recommended secret length for HMAC-SHA1. */
const SECRET_BYTES = 20
/** One step either side of now: an authenticator whose clock is up to 30 s off still signs in. */
const ACCEPTED_DRIFT_STEPS = 1

/** Recovery codes issued at enrolment; each signs in once in place of a code. */
export const RECOVERY_CODE_COUNT = 10
/** 16 base32 characters, 80 bits: a stolen hash is not worth brute-forcing. */
const RECOVERY_CODE_CHARACTERS = 16

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function generateTotpSecret(): Uint8Array<ArrayBuffer> {
	return crypto.getRandomValues(new Uint8Array(new ArrayBuffer(SECRET_BYTES)))
}

/** RFC 4648 base32 without padding: what an authenticator app expects in `secret=` and what a person types. */
export function base32(bytes: Uint8Array): string {
	let bits = 0
	let value = 0
	let out = ''
	for (const byte of bytes) {
		value = (value << 8) | byte
		bits += 8
		while (bits >= 5) {
			out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
			bits -= 5
		}
	}
	if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
	return out
}

/** The time step `unixSeconds` falls in. */
export function totpStep(unixSeconds: number): number {
	return Math.floor(unixSeconds / TOTP_PERIOD_SECONDS)
}

/** The code of `step` (RFC 4226 dynamic truncation), zero-padded to six digits. */
export async function totpCode(secret: Uint8Array<ArrayBuffer>, step: number): Promise<string> {
	const counter = new Uint8Array(new ArrayBuffer(8))
	new DataView(counter.buffer).setBigUint64(0, BigInt(step))
	const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
	const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter))
	const offset = (mac[mac.length - 1] ?? 0) & 0x0f
	const binary = (((mac[offset] ?? 0) & 0x7f) << 24) | ((mac[offset + 1] ?? 0) << 16) | ((mac[offset + 2] ?? 0) << 8) | (mac[offset + 3] ?? 0)
	return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0')
}

/** Six digits, as a person types them: spaces are dropped, anything else is not a code. */
export function parseTotpCode(input: string): string | null {
	const code = input.replaceAll(/\s/g, '')
	return /^\d{6}$/.test(code) ? code : null
}

/**
 * The step `code` belongs to, within the accepted drift of `now` and after `lastStep`, or null. A step at or before
 * `lastStep` is refused, so an accepted code — and every earlier one — is never accepted again.
 */
export async function matchingStep(
	secret: Uint8Array<ArrayBuffer>,
	code: string,
	unixSeconds: number,
	lastStep: number | null,
): Promise<number | null> {
	const now = totpStep(unixSeconds)
	let matched: number | null = null
	// Every candidate is computed and compared, so the time taken says nothing about which one matched.
	for (let step = now - ACCEPTED_DRIFT_STEPS; step <= now + ACCEPTED_DRIFT_STEPS; step++) {
		const equal = constantTimeEqual(await totpCode(secret, step), code)
		if (equal && (lastStep === null || step > lastStep) && matched === null) matched = step
	}
	return matched
}

/** The URI an authenticator app enrols from, as a QR code or typed in. `issuer` names the installation, `account` the person. */
export function otpauthUri(input: { readonly issuer: string; readonly account: string; readonly secret: Uint8Array }): string {
	const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`
	const query = new URLSearchParams({
		secret: base32(input.secret),
		issuer: input.issuer,
		algorithm: 'SHA1',
		digits: String(TOTP_DIGITS),
		period: String(TOTP_PERIOD_SECONDS),
	})
	return `otpauth://totp/${label}?${query.toString()}`
}

/** The URI as a QR code: an SVG `data:` URI, which the page CSP's `img-src data:` admits and which runs no script. */
export function qrCodeDataUri(text: string): string {
	const svg = renderSVG(text, { ecc: 'M', border: 2, pixelSize: 6 })
	let binary = ''
	for (const byte of new TextEncoder().encode(svg)) binary += String.fromCharCode(byte)
	return `data:image/svg+xml;base64,${btoa(binary)}`
}

/** Fresh recovery codes, grouped by four for reading: `abcd-efgh-ijkl-mnop`. */
export function generateRecoveryCodes(): string[] {
	return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
		const bytes = crypto.getRandomValues(new Uint8Array(RECOVERY_CODE_CHARACTERS))
		const characters = Array.from(bytes, (byte) => BASE32_ALPHABET[byte & 31]).join('').toLowerCase()
		return characters.match(/.{4}/g)?.join('-') ?? characters
	})
}

/** A recovery code as typed: case, spaces and dashes do not matter; anything else is not one. */
export function parseRecoveryCode(input: string): string | null {
	const code = input.replaceAll(/[\s-]/g, '').toLowerCase()
	return new RegExp(`^[a-z2-7]{${RECOVERY_CODE_CHARACTERS}}$`).test(code) ? code : null
}

/** The stored form of a recovery code: its hash, bound to its principal, so no code is stored and none spends elsewhere. */
export function recoveryCodeHash(principalId: string, code: string): Promise<string> {
	const parsed = parseRecoveryCode(code)
	if (parsed === null) throw new Error('not a recovery code')
	return hashToken(`second-factor-recovery:${principalId}:${parsed}`)
}

function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false
	let difference = 0
	for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index)
	return difference === 0
}
