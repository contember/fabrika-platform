import { describe, expect, test } from 'bun:test'
import { importMasterKey, parseVaultRef, Vault, vaultKeyCensus, vaultRef, VaultUnreadableRowsError } from '../vault'
import { createHarness, queryRows } from './helpers/harness'

// The encrypted D1 vault (M4): AES-256-GCM envelope encryption over a real in-memory D1 (the harness
// applies migrations/0001_init.sql). These cover the crypto contract end-to-end — round-trip,
// authenticated tamper-detection, wrong-key failure, value rotation, and MASTER-KEY rotation
// (reencryptAll) — plus that plaintext never appears in the stored row.

/** A deterministic 32-byte base64 master key for tests (NOT a real key — generate those from urandom). */
function testKey(seed = 1): string {
	const raw = new Uint8Array(32)
	for (let i = 0; i < 32; i++) {
		raw[i] = (i * 7 + seed) % 256
	}
	let binary = ''
	for (const b of raw) {
		binary += String.fromCharCode(b)
	}
	return btoa(binary)
}

/** A single string column off a vault row, read without a cast (JSON round-trip via queryRows). */
function col(sqlite: ReturnType<typeof createHarness>['sqlite'], id: string | null, column: string): string {
	const rows = queryRows(sqlite, 'SELECT * FROM vault WHERE id = ?', id)
	const value = rows[0]?.[column]
	return typeof value === 'string' ? value : ''
}

describe('Vault crypto (AES-256-GCM envelope)', () => {
	test('round-trips a value: putSecret → getSecret returns the plaintext', async () => {
		const { d1 } = createHarness()
		const vault = await Vault.create(d1, testKey())
		const ref = await vault.putSecret('app', 'app:foo/*/API_KEY', 'super-secret-value')
		expect(parseVaultRef(ref)).not.toBeNull()
		expect(await vault.getSecret(ref)).toBe('super-secret-value')
	})

	test('handles empty + unicode + long values', async () => {
		const { d1 } = createHarness()
		const vault = await Vault.create(d1, testKey())
		for (const value of ['', 'h e l l o 🌍', 'x'.repeat(10_000)]) {
			const ref = await vault.putSecret('app-env', 'l', value)
			expect(await vault.getSecret(ref)).toBe(value)
		}
	})

	test('platform secrets require an exact purpose match', async () => {
		const { d1 } = createHarness()
		const vault = await Vault.create(d1, testKey())
		const ref = await vault.putSecret('platform', 'platform:github-source:a:webhook', 'hook-secret')
		expect(await vault.getSecretForPurpose(ref, { scope: 'platform', label: 'platform:github-source:a:webhook' })).toBe('hook-secret')
		await expect(vault.getSecretForPurpose(ref, { scope: 'platform', label: 'platform:github-source:b:webhook' })).rejects.toThrow(
			'purpose mismatch',
		)
		await expect(vault.getSecretForPurpose(ref, { scope: 'app', label: 'platform:github-source:a:webhook' })).rejects.toThrow(
			'purpose mismatch',
		)
	})

	test('the stored row contains NO plaintext (only ciphertext + IVs)', async () => {
		const { d1, sqlite } = createHarness()
		const vault = await Vault.create(d1, testKey())
		const plaintext = 'PLAINTEXT-MARKER-9f3a'
		const ref = await vault.putSecret('app', 'app:app/*/API_KEY', plaintext)
		const id = parseVaultRef(ref)
		const rows = queryRows(sqlite, 'SELECT * FROM vault WHERE id = ?', id)
		expect(JSON.stringify(rows[0])).not.toContain(plaintext)
		expect(col(sqlite, id, 'ciphertext').length).toBeGreaterThan(0)
		expect(col(sqlite, id, 'value_iv').length).toBeGreaterThan(0)
		expect(col(sqlite, id, 'wrapped_dek').length).toBeGreaterThan(0)
		expect(col(sqlite, id, 'dek_iv').length).toBeGreaterThan(0)
	})

	test('a random IV per value: two encryptions of the same value differ', async () => {
		const { d1, sqlite } = createHarness()
		const vault = await Vault.create(d1, testKey())
		const refA = await vault.putSecret('app', 'a', 'same')
		const refB = await vault.putSecret('app', 'b', 'same')
		expect(col(sqlite, parseVaultRef(refA), 'value_iv')).not.toBe(col(sqlite, parseVaultRef(refB), 'value_iv'))
		expect(col(sqlite, parseVaultRef(refA), 'ciphertext')).not.toBe(col(sqlite, parseVaultRef(refB), 'ciphertext'))
		expect(await vault.getSecret(refA)).toBe('same')
		expect(await vault.getSecret(refB)).toBe('same')
	})

	test('tampering with the ciphertext fails the GCM auth check on decrypt', async () => {
		const { d1, sqlite } = createHarness()
		const vault = await Vault.create(d1, testKey())
		const ref = await vault.putSecret('app', 'l', 'tamper-me')
		const id = parseVaultRef(ref)
		const ct = col(sqlite, id, 'ciphertext')
		const flipped = `${ct.slice(0, -2)}${ct.slice(-2) === 'AA' ? 'AB' : 'AA'}`
		sqlite.query('UPDATE vault SET ciphertext = ? WHERE id = ?').run(flipped, id)
		await expect(vault.getSecret(ref)).rejects.toThrow()
	})

	test('a wrong master key cannot decrypt (DEK unwrap fails)', async () => {
		const { d1 } = createHarness()
		const vault = await Vault.create(d1, testKey(1))
		const ref = await vault.putSecret('app', 'l', 'only-key-1')
		const other = await Vault.create(d1, testKey(2))
		await expect(other.getSecret(ref)).rejects.toThrow()
		expect(await vault.getSecret(ref)).toBe('only-key-1') // original key still works
	})

	test('importMasterKey rejects a wrong-length key', async () => {
		await expect(importMasterKey(btoa('too-short'))).rejects.toThrow(/32 bytes/)
	})
})

describe('Vault rotation', () => {
	test('rotate(ref, newValue) re-encrypts in place; getSecret returns the new value', async () => {
		const { d1, sqlite } = createHarness()
		const vault = await Vault.create(d1, testKey())
		const ref = await vault.putSecret('app', 'l', 'v1')
		const id = parseVaultRef(ref)
		const ctBefore = col(sqlite, id, 'ciphertext')
		await vault.rotate(ref, 'v2')
		expect(await vault.getSecret(ref)).toBe('v2')
		expect(col(sqlite, id, 'ciphertext')).not.toBe(ctBefore) // fresh DEK + IV
		expect(queryRows(sqlite, 'SELECT rotated_at FROM vault WHERE id = ?', id)[0]?.rotated_at).not.toBeNull()
	})

	test('rotate of a missing ref throws', async () => {
		const { d1 } = createHarness()
		const vault = await Vault.create(d1, testKey())
		await expect(vault.rotate(vaultRef('019e0000-0000-7000-8000-000000000000'), 'x')).rejects.toThrow()
	})

	test('delete removes the row; subsequent getSecret throws', async () => {
		const { d1 } = createHarness()
		const vault = await Vault.create(d1, testKey())
		const ref = await vault.putSecret('app', 'l', 'gone-soon')
		expect(await vault.delete(ref)).toBe(true)
		expect(await vault.delete(ref)).toBe(false)
		await expect(vault.getSecret(ref)).rejects.toThrow()
	})

	test('reencryptAll rotates the MASTER key: old key stops working, new key reads every value', async () => {
		const { d1, sqlite } = createHarness()
		const vault = await Vault.create(d1, testKey(1))
		const refA = await vault.putSecret('app', 'a', 'alpha')
		const refB = await vault.putSecret('app-env', 'b', 'beta')
		const ctBefore = col(sqlite, parseVaultRef(refA), 'ciphertext')

		const count = await vault.reencryptAll(testKey(2))
		expect(count).toBe(2)

		// The NEW-key vault reads both values.
		const rotated = await Vault.create(d1, testKey(2))
		expect(await rotated.getSecret(refA)).toBe('alpha')
		expect(await rotated.getSecret(refB)).toBe('beta')

		// The OLD-key vault can no longer unwrap the (re-wrapped) DEKs.
		const old = await Vault.create(d1, testKey(1))
		await expect(old.getSecret(refA)).rejects.toThrow()

		// Value ciphertext is unchanged — a master rotation never re-encrypts (or exposes) the value.
		expect(col(sqlite, parseVaultRef(refA), 'ciphertext')).toBe(ctBefore)
		expect(await vaultKeyCensus(d1, testKey(1), testKey(2))).toEqual({ rows: 2, openWithCurrent: 0, openWithNew: 2, unreadable: [] })
	})

	test('reencryptAll writes in one transaction: a failed commit leaves every row under the old key', async () => {
		const { d1 } = createHarness()
		const vault = await Vault.create(d1, testKey(1))
		await vault.putSecret('app', 'a', 'alpha')
		await vault.putSecret('app', 'b', 'beta')
		// The commit fails, as an interrupted run's would; nothing may have been written row by row before it.
		const interrupted = await Vault.create({
			prepare: (query) => d1.prepare(query),
			batch: () => Promise.reject(new Error('connection lost')),
		}, testKey(1))

		await expect(interrupted.reencryptAll(testKey(2))).rejects.toThrow('connection lost')

		expect(await vaultKeyCensus(d1, testKey(1), testKey(2))).toEqual({ rows: 2, openWithCurrent: 2, openWithNew: 0, unreadable: [] })
	})

	test('reencryptAll resumes: a re-run re-wraps only the rows written under the old key since', async () => {
		const { d1 } = createHarness()
		const vault = await Vault.create(d1, testKey(1))
		await vault.putSecret('app', 'a', 'alpha')
		expect(await vault.reencryptAll(testKey(2))).toBe(1)
		// A Control still running on the old key wrote one more row after the rotation committed.
		const late = await vault.putSecret('app', 'late', 'written-late')
		expect(await vaultKeyCensus(d1, testKey(1), testKey(2))).toEqual({ rows: 2, openWithCurrent: 1, openWithNew: 1, unreadable: [] })

		expect(await vault.reencryptAll(testKey(2))).toBe(1)

		expect(await vaultKeyCensus(d1, testKey(1), testKey(2))).toEqual({ rows: 2, openWithCurrent: 0, openWithNew: 2, unreadable: [] })
		expect(await (await Vault.create(d1, testKey(2))).getSecret(late)).toBe('written-late')
	})

	test('reencryptAll refuses a row neither key opens and writes nothing', async () => {
		const { d1 } = createHarness()
		const vault = await Vault.create(d1, testKey(1))
		await vault.putSecret('app', 'a', 'alpha')
		const foreign = await (await Vault.create(d1, testKey(3))).putSecret('app', 'b', 'sealed-under-a-third-key')

		const refusal = vault.reencryptAll(testKey(2))

		await expect(refusal).rejects.toBeInstanceOf(VaultUnreadableRowsError)
		await expect(refusal).rejects.toThrow(parseVaultRef(foreign) ?? 'no id')
		expect(await vaultKeyCensus(d1, testKey(1), testKey(2))).toEqual({
			rows: 2,
			openWithCurrent: 1,
			openWithNew: 0,
			unreadable: [parseVaultRef(foreign) ?? ''],
		})
	})
})

describe('vaultRef / parseVaultRef', () => {
	test('round-trips an id', () => {
		expect(parseVaultRef(vaultRef('abc'))).toBe('abc')
	})
	test('rejects non-vault refs', () => {
		expect(parseVaultRef('env:FOO')).toBeNull()
		expect(parseVaultRef('secretstore:bar')).toBeNull()
		expect(parseVaultRef('literal:baz')).toBeNull()
	})
})
