// The vault master key (KEK) rotation of a Postgres installation, run once by an operator with Control stopped
// (docs/reference/key-rotation.md). Every input is an environment variable, so no key reaches argv or a shell history:
//
//   FABRIKA_CONTROL_DATABASE_URL    Control's database
//   FABRIKA_CONTROL_VAULT_KEY       the key Control runs with now
//   FABRIKA_CONTROL_VAULT_KEY_NEW   the key it will run with
//
// `--check` only counts which key opens each row. Without it the run re-wraps every row the current key opens, in one
// transaction, and succeeds only when afterwards every row opens with the new key and none with the current one.

import { PostgresDatabase } from '@fabrika/platform-node'
import { importMasterKey, Vault, type VaultD1, type VaultKeyCensus, vaultKeyCensus, VaultUnreadableRowsError } from '../vault'

export interface VaultKeyRotationInput {
	readonly db: VaultD1
	readonly currentKey: string
	readonly newKey: string
	/** Count only; write nothing. */
	readonly check: boolean
	readonly log: (line: string) => void
}

export interface VaultKeyRotationResult {
	/** Every row opens with the new key and none with the current one. */
	readonly complete: boolean
	readonly rewrapped: number
	readonly before: VaultKeyCensus
	readonly after: VaultKeyCensus
}

/** A refusal whose message names no key, no value and no database URL, so the process may print it. */
export class VaultKeyRotationRefused extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'VaultKeyRotationRefused'
	}
}

const describeCensus = (census: VaultKeyCensus): string =>
	`${census.rows} vault rows: ${census.openWithCurrent} open with the current key, ${census.openWithNew} with the new key, ${census.unreadable.length} with neither`

const isComplete = (census: VaultKeyCensus): boolean =>
	census.openWithCurrent === 0 && census.unreadable.length === 0 && census.openWithNew === census.rows

async function assertKey(name: string, base64Key: string): Promise<void> {
	try {
		await importMasterKey(base64Key)
	} catch {
		throw new VaultKeyRotationRefused(`${name} is not 32 bytes at base64 (generate one with: head -c 32 /dev/urandom | base64)`)
	}
}

export async function rotateVaultKey(input: VaultKeyRotationInput): Promise<VaultKeyRotationResult> {
	// Both keys are imported first, so a malformed one is refused before the database is read.
	await assertKey('FABRIKA_CONTROL_VAULT_KEY', input.currentKey)
	await assertKey('FABRIKA_CONTROL_VAULT_KEY_NEW', input.newKey)
	if (input.currentKey.trim() === input.newKey.trim()) {
		throw new VaultKeyRotationRefused('FABRIKA_CONTROL_VAULT_KEY_NEW is the current key')
	}
	const before = await vaultKeyCensus(input.db, input.currentKey, input.newKey)
	input.log(`before: ${describeCensus(before)}`)
	if (before.unreadable.length > 0) {
		throw new VaultKeyRotationRefused(`rows neither key opens, nothing written: ${before.unreadable.join(', ')}`)
	}
	if (input.check) {
		return { complete: isComplete(before), rewrapped: 0, before, after: before }
	}
	const vault = await Vault.create(input.db, input.currentKey)
	let rewrapped: number
	try {
		rewrapped = await vault.reencryptAll(input.newKey)
	} catch (error) {
		if (error instanceof VaultUnreadableRowsError) {
			throw new VaultKeyRotationRefused(`rows neither key opens, nothing written: ${error.ids.join(', ')}`)
		}
		throw error
	}
	input.log(`re-wrapped ${rewrapped} rows in one transaction`)
	const after = await vaultKeyCensus(input.db, input.currentKey, input.newKey)
	input.log(`after: ${describeCensus(after)}`)
	return { complete: isComplete(after), rewrapped, before, after }
}

function requiredEnv(name: string): string {
	const value = process.env[name]
	if (value === undefined || value.trim() === '') throw new VaultKeyRotationRefused(`${name} is required`)
	return value.trim()
}

async function main(): Promise<number> {
	const args = process.argv.slice(2)
	const unknown = args.filter((arg) => arg !== '--check')
	if (unknown.length > 0) throw new VaultKeyRotationRefused(`unknown argument: ${unknown.join(' ')} (the only flag is --check)`)
	const check = args.includes('--check')
	const currentKey = requiredEnv('FABRIKA_CONTROL_VAULT_KEY')
	const newKey = requiredEnv('FABRIKA_CONTROL_VAULT_KEY_NEW')
	const db = PostgresDatabase.connect(requiredEnv('FABRIKA_CONTROL_DATABASE_URL'), { max: 1 })
	try {
		const result = await rotateVaultKey({ db, currentKey, newKey, check, log: (line) => console.info(line) })
		if (result.complete) {
			console.info('complete: every vault row opens with the new key and none with the current one')
			return 0
		}
		console.error(
			check
				? 'not complete: rows still open with the current key'
				: 'not complete: rows still open with the current key (written while this ran?); run the same command again',
		)
		return 1
	} finally {
		await db.close()
	}
}

if (import.meta.main) {
	main().then(
		(code) => process.exit(code),
		(error: unknown) => {
			// Only our own refusals are printed: a driver error may carry the database URL.
			console.error(error instanceof VaultKeyRotationRefused ? `vault key rotation refused: ${error.message}` : 'vault key rotation failed')
			process.exit(1)
		},
	)
}
