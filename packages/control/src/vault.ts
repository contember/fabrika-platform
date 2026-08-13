// The encrypted secret VAULT (M4) — at-rest envelope encryption for per-app, per-env, and
// control-owned platform secret values, backed by the `vault` table.
//
// THREAT MODEL: D1 at rest (or a leaked DB dump) must not reveal any secret value. The control-plane
// Worker decrypts in memory only at deploy time, passes the plaintext to the selected provider, and
// never logs it. The vault does NOT defend against a fully compromised Worker runtime (which holds the
// master key) — that is out of scope, the same trust boundary as Workers Secrets themselves.
//
// CRYPTO (WebCrypto, AES-256-GCM, envelope):
//   * MASTER KEY (KEK): 32 raw bytes, loaded from the Worker secret `FABRIKA_CONTROL_VAULT_KEY` (base64). It
//     NEVER leaves the Worker and is NEVER written to D1. Provisioned out-of-band (see FABRIKA_CONTROL_VAULT_KEY
//     note below). One KEK protects the whole vault.
//   * DATA KEY (DEK): a fresh random 256-bit key per stored value. The DEK encrypts the value
//     (AES-256-GCM, random 96-bit IV). The DEK is then WRAPPED by the KEK (AES-256-GCM, its own random
//     96-bit IV). D1 stores {ciphertext, value_iv, wrapped_dek, dek_iv} — never a plaintext DEK or
//     value.
//   * AUTHENTICATION: GCM is authenticated, so any tamper with the ciphertext, IV, or wrapped DEK — or
//     decrypting with the wrong key — fails with an OperationError on decrypt (never silent garbage).
//   * ROTATION: `rotate(ref, value)` re-encrypts a single value (new DEK + IVs). `reencryptAll(newKek)`
//     rotates the MASTER key by unwrapping each DEK with the old KEK and re-wrapping with the new one —
//     the value ciphertext is untouched, so no plaintext value is ever exposed during a master rotation.
//
// FABRIKA_CONTROL_VAULT_KEY provisioning (real CF): generate 32 random bytes, base64 them, and set the Worker
// secret once per environment:
//   `head -c 32 /dev/urandom | base64 | wrangler secret put FABRIKA_CONTROL_VAULT_KEY`
// Locally it goes in `.dev.vars`. Rotating it means: set the NEW key, call reencryptAll with
// it, then swap the binding (or run reencryptAll as a one-shot maintenance task) — see the management
// API. Losing it makes every vault value unrecoverable (by design).

import type { SqlStatement } from '@fabrika/platform'
import { uuidv7 } from './uuid'

export type SecretScope = 'app' | 'app-env' | 'platform'

export interface VaultSecretPurpose {
	scope: SecretScope
	label: string
}

const ALG = 'AES-GCM'
/** GCM standard nonce length: 96 bits. A fresh random IV per encryption (value + DEK wrap). */
const IV_BYTES = 12
/** AES-256: a 32-byte key (master KEK and per-value DEK alike). */
const KEY_BYTES = 32

/** A vault row as stored in D1 (snake_case, matching migrations/0002_vault.sql). */
export interface VaultRow {
	id: string
	scope: SecretScope
	label: string | null
	ciphertext: string
	value_iv: string
	wrapped_dek: string
	dek_iv: string
	created_at: number
	rotated_at: number | null
}

/** The database surface the vault needs — a `SqlDatabase` (so a real `D1Database`) satisfies it. */
export interface VaultD1 {
	prepare(query: string): SqlStatement
}

// ── byte/base64 helpers (no Buffer; Worker + Bun both have atob/btoa) ──────────
//
// WebCrypto's `BufferSource` wants an ArrayBuffer-backed view; `TextEncoder().encode` and friends are
// typed `Uint8Array<ArrayBufferLike>` under the workers-types lib. Every helper here returns
// `Uint8Array<ArrayBuffer>` (copied into a fresh ArrayBuffer) so crypto calls type-check without a cast
// — same convention as src/repo-source.ts.

/** Copy any byte view into a fresh ArrayBuffer-backed `Uint8Array` (satisfies WebCrypto's BufferSource). */
function bytes(view: Uint8Array | ArrayBuffer): Uint8Array<ArrayBuffer> {
	const src = view instanceof ArrayBuffer ? new Uint8Array(view) : view
	const buffer = new ArrayBuffer(src.byteLength)
	const out = new Uint8Array(buffer)
	out.set(src)
	return out
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
	return bytes(new TextEncoder().encode(text))
}

function toBase64(view: Uint8Array | ArrayBuffer): string {
	const arr = view instanceof ArrayBuffer ? new Uint8Array(view) : view
	let binary = ''
	for (const b of arr) {
		binary += String.fromCharCode(b)
	}
	return btoa(binary)
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
	const binary = atob(b64)
	const out = new Uint8Array(new ArrayBuffer(binary.length))
	for (let i = 0; i < binary.length; i++) {
		out[i] = binary.charCodeAt(i)
	}
	return out
}

/**
 * Import the base64 master key (`FABRIKA_CONTROL_VAULT_KEY`) as a non-extractable AES-GCM CryptoKey used ONLY to
 * wrap/unwrap data keys. Validates the length so a misconfigured key fails loudly (not as a silent
 * weak key). The raw bytes are never logged.
 */
export async function importMasterKey(base64Key: string): Promise<CryptoKey> {
	const raw = fromBase64(base64Key)
	if (raw.length !== KEY_BYTES) {
		throw new Error(`FABRIKA_CONTROL_VAULT_KEY must be ${KEY_BYTES} bytes (got ${raw.length}) — generate with: head -c 32 /dev/urandom | base64`)
	}
	return crypto.subtle.importKey('raw', raw, { name: ALG }, false, ['encrypt', 'decrypt'])
}

/** A freshly generated, extractable per-value data key (so it can be wrapped by the KEK). */
async function generateDataKey(): Promise<CryptoKey> {
	return crypto.subtle.generateKey({ name: ALG, length: 256 }, true, ['encrypt', 'decrypt'])
}

function randomIv(): Uint8Array<ArrayBuffer> {
	return crypto.getRandomValues(new Uint8Array(new ArrayBuffer(IV_BYTES)))
}

/** The envelope ciphertext pieces produced for one value. All base64, all safe to store in D1. */
interface Envelope {
	ciphertext: string
	valueIv: string
	wrappedDek: string
	dekIv: string
}

/** Ciphertext prepared for an atomic transaction with another control-plane state change. */
export interface PreparedVaultSecret {
	id: string
	ref: string
	scope: SecretScope
	label: string
	ciphertext: string
	valueIv: string
	wrappedDek: string
	dekIv: string
}

/**
 * Envelope-encrypt a plaintext value under the master key: generate a DEK, AES-GCM the value with it,
 * then AES-GCM-wrap the DEK's raw bytes with the KEK. Returns only ciphertext + IVs (no plaintext).
 */
async function seal(masterKey: CryptoKey, plaintext: string): Promise<Envelope> {
	const dek = await generateDataKey()
	const valueIv = randomIv()
	const ciphertext = await crypto.subtle.encrypt({ name: ALG, iv: valueIv }, dek, utf8(plaintext))

	// Wrap the DEK's raw bytes with the master key. (We use encrypt over exported raw rather than
	// `wrapKey` so the wire format is plain GCM ciphertext, symmetric with the value path.)
	const dekRaw = await crypto.subtle.exportKey('raw', dek)
	const dekIv = randomIv()
	const wrappedDek = await crypto.subtle.encrypt({ name: ALG, iv: dekIv }, masterKey, bytes(dekRaw))

	return {
		ciphertext: toBase64(ciphertext),
		valueIv: toBase64(valueIv),
		wrappedDek: toBase64(wrappedDek),
		dekIv: toBase64(dekIv),
	}
}

/**
 * Reverse `seal`: unwrap the DEK with the master key, then decrypt the value with the DEK. Any tamper
 * (ciphertext, IV, wrapped DEK) or a wrong master key throws on the relevant GCM auth check.
 */
async function open(masterKey: CryptoKey, env: Envelope): Promise<string> {
	const dekRaw = await crypto.subtle.decrypt({ name: ALG, iv: fromBase64(env.dekIv) }, masterKey, fromBase64(env.wrappedDek))
	const dek = await crypto.subtle.importKey('raw', bytes(dekRaw), { name: ALG }, false, ['decrypt'])
	const plaintext = await crypto.subtle.decrypt({ name: ALG, iv: fromBase64(env.valueIv) }, dek, fromBase64(env.ciphertext))
	return new TextDecoder().decode(plaintext)
}

/** Unwrap a DEK, then re-wrap it under a NEW master key (used by reencryptAll). No value plaintext seen. */
async function rewrapDek(
	oldKey: CryptoKey,
	newKey: CryptoKey,
	env: Pick<Envelope, 'wrappedDek' | 'dekIv'>,
): Promise<{ wrappedDek: string; dekIv: string }> {
	const dekRaw = await crypto.subtle.decrypt({ name: ALG, iv: fromBase64(env.dekIv) }, oldKey, fromBase64(env.wrappedDek))
	const dekIv = randomIv()
	const wrappedDek = await crypto.subtle.encrypt({ name: ALG, iv: dekIv }, newKey, bytes(dekRaw))
	return { wrappedDek: toBase64(wrappedDek), dekIv: toBase64(dekIv) }
}

/** Build the `vault:<id>` ref from a row id (the only place the prefix is minted). */
export function vaultRef(id: string): string {
	return `vault:${id}`
}

/** Parse a `vault:<id>` ref to its id; null when the ref is not a vault ref. */
export function parseVaultRef(ref: string): string | null {
	const prefix = 'vault:'
	return ref.startsWith(prefix) ? ref.slice(prefix.length) : null
}

/**
 * The encrypted secret vault: the backend `vault:<id>` refs resolve against. Holds a master key in
 * memory for the request's lifetime and the D1 handle. Plaintext values are accepted on `putSecret`/
 * `rotate` and returned ONLY by `getSecret`; they are never logged and never persisted in the clear.
 */
export class Vault {
	/**
	 * `now` is injectable so `rotated_at` is deterministic in tests (same approach as `SqlDeployLocks`
	 * and the repository capabilities); it returns unix SECONDS, the unit the `vault` table's timestamps use.
	 */
	constructor(
		private readonly d1: VaultD1,
		private readonly masterKey: CryptoKey,
		private readonly now: () => number = () => Math.floor(Date.now() / 1000),
	) {}

	/** Construct a Vault from the base64 master key (the `FABRIKA_CONTROL_VAULT_KEY` Worker secret). */
	static async create(d1: VaultD1, base64MasterKey: string, now?: () => number): Promise<Vault> {
		return new Vault(d1, await importMasterKey(base64MasterKey), now)
	}

	/**
	 * Encrypt + store a new secret value. Returns its `vault:<id>` ref (to write onto the
	 * owning state row). `label` is an audit handle only — never the value.
	 */
	async putSecret(scope: SecretScope, label: string, value: string): Promise<string> {
		const prepared = await this.prepareSecret(scope, label, value)
		await this.d1
			.prepare(`INSERT INTO vault (id, scope, label, ciphertext, value_iv, wrapped_dek, dek_iv) VALUES (?, ?, ?, ?, ?, ?, ?)`)
			.bind(prepared.id, prepared.scope, prepared.label, prepared.ciphertext, prepared.valueIv, prepared.wrappedDek, prepared.dekIv)
			.run()
		return prepared.ref
	}

	/** Encrypt without persisting so a repository can commit the row with its owning checkpoint. */
	async prepareSecret(scope: SecretScope, label: string, value: string): Promise<PreparedVaultSecret> {
		const id = uuidv7()
		const env = await seal(this.masterKey, value)
		return {
			id,
			ref: vaultRef(id),
			scope,
			label,
			ciphertext: env.ciphertext,
			valueIv: env.valueIv,
			wrappedDek: env.wrappedDek,
			dekIv: env.dekIv,
		}
	}

	/** Decrypt + return the plaintext value a `vault:<id>` ref points at. Throws if missing or on tamper. */
	async getSecret(ref: string): Promise<string> {
		const row = await this.loadRow(ref)
		return open(this.masterKey, { ciphertext: row.ciphertext, valueIv: row.value_iv, wrappedDek: row.wrapped_dek, dekIv: row.dek_iv })
	}

	/** Decrypt only when the immutable scope and audit label match the caller's purpose. */
	async getSecretForPurpose(ref: string, purpose: VaultSecretPurpose): Promise<string> {
		const row = await this.loadRow(ref)
		if (row.scope !== purpose.scope || row.label !== purpose.label) {
			throw new Error('vault secret purpose mismatch')
		}
		return open(this.masterKey, { ciphertext: row.ciphertext, valueIv: row.value_iv, wrappedDek: row.wrapped_dek, dekIv: row.dek_iv })
	}

	/** Re-encrypt the value at `ref` with a fresh DEK + IVs. Stamps `rotated_at`. Throws if missing. */
	async rotate(ref: string, newValue: string): Promise<void> {
		const id = this.idOrThrow(ref)
		// Confirm the row exists first so a rotate of a missing ref is a clear error, not a silent no-op.
		await this.loadRow(ref)
		const env = await seal(this.masterKey, newValue)
		await this.d1
			.prepare(`UPDATE vault SET ciphertext = ?, value_iv = ?, wrapped_dek = ?, dek_iv = ?, rotated_at = ? WHERE id = ?`)
			.bind(env.ciphertext, env.valueIv, env.wrappedDek, env.dekIv, this.now(), id)
			.run()
	}

	/** Delete the vault row a ref points at. Returns true iff a row was removed. */
	async delete(ref: string): Promise<boolean> {
		const id = this.idOrThrow(ref)
		const result = await this.d1.prepare('DELETE FROM vault WHERE id = ?').bind(id).run()
		return (result.meta.changes ?? 0) > 0
	}

	/**
	 * MASTER-KEY rotation: re-wrap every row's DEK with `newBase64MasterKey`, leaving the value
	 * ciphertext untouched. Returns the count re-wrapped. A failure mid-way leaves already-rewrapped
	 * rows readable only by the NEW key and the rest only by the OLD key — so run it as a maintenance
	 * task and only swap the binding to the new key once it completes. Never exposes a plaintext value.
	 */
	async reencryptAll(newBase64MasterKey: string): Promise<number> {
		const newKey = await importMasterKey(newBase64MasterKey)
		const { results } = await this.d1.prepare('SELECT * FROM vault').all<VaultRow>()
		let count = 0
		for (const row of results) {
			const rewrapped = await rewrapDek(this.masterKey, newKey, { wrappedDek: row.wrapped_dek, dekIv: row.dek_iv })
			await this.d1
				.prepare('UPDATE vault SET wrapped_dek = ?, dek_iv = ?, rotated_at = ? WHERE id = ?')
				.bind(rewrapped.wrappedDek, rewrapped.dekIv, this.now(), row.id)
				.run()
			count++
		}
		return count
	}

	private idOrThrow(ref: string): string {
		const id = parseVaultRef(ref)
		if (id === null) {
			throw new Error('not a vault ref')
		}
		return id
	}

	private async loadRow(ref: string): Promise<VaultRow> {
		const id = this.idOrThrow(ref)
		const row = await this.d1.prepare('SELECT * FROM vault WHERE id = ?').bind(id).first<VaultRow>()
		if (row === null) {
			// Name only that the ref is unknown — never echo decrypted material.
			throw new Error('unresolvable vault ref: no such secret')
		}
		return row
	}
}
