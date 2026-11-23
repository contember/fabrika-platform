// IAM's one value it must read back and so cannot hash: a TOTP secret. Sealed with Control's vault construction
// (`packages/control/src/vault.ts`): AES-256-GCM under a fresh data key per value, that data key wrapped by the
// installation's `FABRIKA_IAM_DATA_KEY`. Unlike the vault, both layers carry associated data naming the value's owner,
// so a writer of IAM's database who moves a sealed value into another row moves nothing that opens there.

const ALG = 'AES-GCM'
/** GCM's standard nonce, fresh per encryption. */
const IV_BYTES = 12
/** AES-256: the installation's key and each data key. */
export const DATA_KEY_BYTES = 32

/** The sealed pieces as stored: all base64, never a plaintext value or data key. */
export interface SealedValue {
	readonly ciphertext: string
	readonly valueIv: string
	readonly wrappedDek: string
	readonly dekIv: string
}

/**
 * Parse `FABRIKA_IAM_DATA_KEY` (base64 of 32 random bytes) once at boot. Unset or empty is null: nothing can be sealed,
 * so TOTP enrolment is unavailable. Anything else that is not 32 bytes fails the boot; a short key would be a weak key
 * nobody notices.
 */
export function parseDataKey(raw: string | undefined): Uint8Array<ArrayBuffer> | null {
	if (raw === undefined || raw.trim() === '') return null
	let decoded: Uint8Array<ArrayBuffer>
	try {
		decoded = fromBase64(raw.trim())
	} catch {
		throw new Error('FABRIKA_IAM_DATA_KEY is not base64 — generate it with: head -c 32 /dev/urandom | base64')
	}
	if (decoded.length !== DATA_KEY_BYTES) {
		throw new Error(`FABRIKA_IAM_DATA_KEY must be ${DATA_KEY_BYTES} bytes — generate it with: head -c 32 /dev/urandom | base64`)
	}
	return decoded
}

/** Seal `value` for `owner` (the associated data of both layers). */
export async function sealValue(dataKey: Uint8Array<ArrayBuffer>, owner: string, value: Uint8Array<ArrayBuffer>): Promise<SealedValue> {
	const additionalData = utf8(owner)
	const kek = await importKey(dataKey, ['encrypt'])
	const dek = await crypto.subtle.generateKey({ name: ALG, length: 256 }, true, ['encrypt', 'decrypt'])
	const valueIv = randomIv()
	const ciphertext = await crypto.subtle.encrypt({ name: ALG, iv: valueIv, additionalData }, dek, value)
	const dekIv = randomIv()
	const wrappedDek = await crypto.subtle.encrypt({ name: ALG, iv: dekIv, additionalData }, kek, copy(await crypto.subtle.exportKey('raw', dek)))
	return { ciphertext: toBase64(ciphertext), valueIv: toBase64(valueIv), wrappedDek: toBase64(wrappedDek), dekIv: toBase64(dekIv) }
}

/** Open a value `sealValue` sealed for `owner`. A wrong key, another owner or any tampered piece throws. */
export async function openValue(dataKey: Uint8Array<ArrayBuffer>, owner: string, sealed: SealedValue): Promise<Uint8Array<ArrayBuffer>> {
	const additionalData = utf8(owner)
	const kek = await importKey(dataKey, ['decrypt'])
	const dekRaw = await crypto.subtle.decrypt({ name: ALG, iv: fromBase64(sealed.dekIv), additionalData }, kek, fromBase64(sealed.wrappedDek))
	const dek = await crypto.subtle.importKey('raw', copy(dekRaw), { name: ALG }, false, ['decrypt'])
	const value = await crypto.subtle.decrypt({ name: ALG, iv: fromBase64(sealed.valueIv), additionalData }, dek, fromBase64(sealed.ciphertext))
	return copy(value)
}

function importKey(raw: Uint8Array<ArrayBuffer>, usages: KeyUsage[]): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', raw, { name: ALG }, false, usages)
}

function randomIv(): Uint8Array<ArrayBuffer> {
	return crypto.getRandomValues(new Uint8Array(new ArrayBuffer(IV_BYTES)))
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
	return copy(new TextEncoder().encode(text))
}

/** A copy backed by a fresh `ArrayBuffer`, which WebCrypto's `BufferSource` requires. */
function copy(view: Uint8Array | ArrayBuffer): Uint8Array<ArrayBuffer> {
	const source = view instanceof ArrayBuffer ? new Uint8Array(view) : view
	const out = new Uint8Array(new ArrayBuffer(source.byteLength))
	out.set(source)
	return out
}

function toBase64(view: Uint8Array | ArrayBuffer): string {
	let binary = ''
	for (const byte of view instanceof ArrayBuffer ? new Uint8Array(view) : view) binary += String.fromCharCode(byte)
	return btoa(binary)
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
	const binary = atob(value)
	const out = new Uint8Array(new ArrayBuffer(binary.length))
	for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index)
	return out
}
