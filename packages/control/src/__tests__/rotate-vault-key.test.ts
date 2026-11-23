// The vault KEK rotation script (`src/bun/rotate-vault-key.ts`) against a REAL Postgres with Control's shipped
// migrations: the database an installation on Zerops runs it on. Skips cleanly without FABRIKA_TEST_POSTGRES_URL.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rotateVaultKey, VaultKeyRotationRefused } from '../bun/rotate-vault-key'
import { proxySecretPurpose } from '../proxy-secret'
import { appSecretPurpose } from '../secret-resolver'
import { Vault, vaultKeyCensus } from '../vault'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

if (!hasPostgres) {
	console.warn(`rotate-vault-key.test.ts ${skipReason}`)
}

function key(seed: number): string {
	return btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => (i * 13 + seed) % 256)))
}

const CURRENT = key(1)
const NEW = key(2)

let fixture: PostgresFixture | null = null

function db(): PostgresFixture['db'] {
	if (fixture === null) throw new Error('no Postgres fixture')
	return fixture.db
}

const quiet = (): void => {}

/** One row of each kind Control seals: an app secret, an environment secret, a proxy secret. */
async function seed(): Promise<Array<{ ref: string; value: string }>> {
	const vault = await Vault.create(db(), CURRENT)
	const rows = [
		{ purpose: appSecretPurpose('acme', null, 'API_KEY'), value: 'all-env-value' },
		{ purpose: appSecretPurpose('acme', 'prod', 'API_KEY'), value: 'prod-value' },
		{ purpose: proxySecretPurpose('acme', 'prod'), value: 'proxy-secret-value' },
	]
	return Promise.all(rows.map(async ({ purpose, value }) => ({ ref: await vault.putSecret(purpose.scope, purpose.label, value), value })))
}

beforeAll(async () => {
	if (hasPostgres) fixture = await createPostgres('control_kek')
})

afterAll(async () => {
	await fixture?.close()
})

beforeEach(async () => {
	if (hasPostgres) await db().prepare('DELETE FROM vault').run()
})

describe.skipIf(!hasPostgres)('rotate-vault-key on Postgres', () => {
	test('every row opens with the new key and none with the current one afterwards', async () => {
		const seeded = await seed()
		const lines: string[] = []

		const result = await rotateVaultKey({ db: db(), currentKey: CURRENT, newKey: NEW, check: false, log: (line) => lines.push(line) })

		expect(result.complete).toBe(true)
		expect(result.rewrapped).toBe(3)
		expect(result.before).toEqual({ rows: 3, openWithCurrent: 3, openWithNew: 0, unreadable: [] })
		expect(result.after).toEqual({ rows: 3, openWithCurrent: 0, openWithNew: 3, unreadable: [] })
		const rotated = await Vault.create(db(), NEW)
		const old = await Vault.create(db(), CURRENT)
		for (const { ref, value } of seeded) {
			expect(await rotated.getSecret(ref)).toBe(value)
			await expect(old.getSecret(ref)).rejects.toThrow()
		}
		// The log names counts only: no key and no value.
		expect(lines.join('\n')).not.toContain(CURRENT)
		expect(lines.join('\n')).not.toContain(NEW)
		expect(lines.join('\n')).not.toContain('prod-value')
	})

	test('--check writes nothing and reports whether the rotation is complete', async () => {
		await seed()

		const before = await rotateVaultKey({ db: db(), currentKey: CURRENT, newKey: NEW, check: true, log: quiet })
		expect(before.complete).toBe(false)
		expect(await vaultKeyCensus(db(), CURRENT, NEW)).toEqual({ rows: 3, openWithCurrent: 3, openWithNew: 0, unreadable: [] })

		await rotateVaultKey({ db: db(), currentKey: CURRENT, newKey: NEW, check: false, log: quiet })
		expect((await rotateVaultKey({ db: db(), currentKey: CURRENT, newKey: NEW, check: true, log: quiet })).complete).toBe(true)
	})

	test('a re-run after a write under the current key finishes the rotation', async () => {
		await seed()
		await rotateVaultKey({ db: db(), currentKey: CURRENT, newKey: NEW, check: false, log: quiet })
		const late = await (await Vault.create(db(), CURRENT)).putSecret('app', 'app:acme/*/LATE', 'late-value')
		expect((await rotateVaultKey({ db: db(), currentKey: CURRENT, newKey: NEW, check: true, log: quiet })).complete).toBe(false)

		const rerun = await rotateVaultKey({ db: db(), currentKey: CURRENT, newKey: NEW, check: false, log: quiet })

		expect(rerun.rewrapped).toBe(1)
		expect(rerun.complete).toBe(true)
		expect(await (await Vault.create(db(), NEW)).getSecret(late)).toBe('late-value')
	})

	test('a row neither key opens refuses the run and nothing is written', async () => {
		await seed()
		await (await Vault.create(db(), key(3))).putSecret('app', 'app:other/*/KEY', 'third-key-value')

		await expect(rotateVaultKey({ db: db(), currentKey: CURRENT, newKey: NEW, check: false, log: quiet })).rejects.toBeInstanceOf(
			VaultKeyRotationRefused,
		)

		expect(await vaultKeyCensus(db(), CURRENT, NEW)).toMatchObject({ rows: 4, openWithCurrent: 3, openWithNew: 0 })
	})

	test('refuses the current key as the new one, and a malformed key, before touching a row', async () => {
		await seed()

		await expect(rotateVaultKey({ db: db(), currentKey: CURRENT, newKey: CURRENT, check: false, log: quiet })).rejects.toThrow('is the current key')
		await expect(rotateVaultKey({ db: db(), currentKey: CURRENT, newKey: 'c2hvcnQ=', check: false, log: quiet })).rejects.toThrow(
			'FABRIKA_CONTROL_VAULT_KEY_NEW is not 32 bytes',
		)
		expect(await vaultKeyCensus(db(), CURRENT, NEW)).toEqual({ rows: 3, openWithCurrent: 3, openWithNew: 0, unreadable: [] })
	})
})
