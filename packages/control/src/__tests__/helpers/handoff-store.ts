// The handoff writes of the GitHub connection store (ADR-0029), run once on SQLite and once on Postgres: minting
// rotates the manifest state in one batch, the console's renew never shortens a link, the session-free claim needs a
// minted link and consumes the state once, and a cancel removes the state.

import type { SqlDatabase } from '@fabrika/platform'
import { expect } from 'bun:test'
import { githubManifestStateSecretLabel } from '../../github/connections/secrets'
import type { GitHubConnectionStore } from '../../github/connections/store'
import type { Vault } from '../../vault'

const ORIGIN = 'https://control.example'
const FIRST_STATE = 'a'.repeat(64)
const ROTATED_STATE = 'b'.repeat(64)
const TOKEN = 'c'.repeat(64)

async function manifestStateRows(db: SqlDatabase, attemptId: string): Promise<number> {
	const { results } = await db.prepare('SELECT id FROM vault WHERE scope = ? AND label = ?')
		.bind('platform', githubManifestStateSecretLabel(attemptId))
		.all<{ id: string }>()
	return results.length
}

async function begin(store: GitHubConnectionStore, vault: Vault, id: string, now: number) {
	const state = await vault.prepareSecret('platform', githubManifestStateSecretLabel(id), 'first-state')
	return await store.beginAttemptWithManifestState({
		id,
		stateHash: FIRST_STATE,
		initiatedBy: 'alice',
		expectedOrigin: ORIGIN,
		desiredOwner: 'acme',
		desiredOwnerType: 'Organization',
		desiredAppName: 'fabrika-source',
		desiredPublic: false,
		requestedRepositories: [],
		expiresAt: now + 600,
	}, state)
}

export async function handoffStoreScenario(store: GitHubConnectionStore, vault: Vault, db: SqlDatabase, id: string, now: number): Promise<void> {
	const started = await begin(store, vault, id, now)
	expect(await store.claimHandedOffCallback(FIRST_STATE)).toBeNull()

	const rotated = await vault.prepareSecret('platform', githubManifestStateSecretLabel(id), 'rotated-state')
	const mint = { principalId: 'alice', expectedOrigin: ORIGIN, tokenHash: TOKEN, stateHash: ROTATED_STATE, state: rotated, expiresAt: now + 3_600 }
	expect(await store.mintHandoff({ ...mint, attempt: started, principalId: 'bob' })).toBeNull()
	const minted = await store.mintHandoff({ ...mint, attempt: started })
	expect(minted).toMatchObject({ stateHash: ROTATED_STATE, handoffTokenHash: TOKEN, manifestStateSecretRef: rotated.ref, expiresAt: now + 3_600 })
	expect(await manifestStateRows(db, id)).toBe(1)
	expect(await vault.getSecretForPurpose(rotated.ref, { scope: 'platform', label: githubManifestStateSecretLabel(id) })).toBe('rotated-state')
	if (minted === null) throw new Error('mint failed')

	// A stale mint writes nothing, not even an orphan vault row.
	const stale = await vault.prepareSecret('platform', githubManifestStateSecretLabel(id), 'stale-state')
	expect(await store.mintHandoff({ ...mint, attempt: started, stateHash: 'd'.repeat(64), state: stale })).toBeNull()
	expect(await manifestStateRows(db, id)).toBe(1)

	const renewed = await store.renewManifestHandoff(id, minted.version, 'alice', ORIGIN, now + 600)
	expect(renewed?.expiresAt).toBe(now + 3_600)

	expect(await store.claimCallback(FIRST_STATE, 'alice')).toBeNull()
	expect(await store.claimHandedOffCallback(FIRST_STATE)).toBeNull()
	expect(await store.claimHandedOffCallback(ROTATED_STATE)).toMatchObject({ phase: 'exchange_claimed', stateHash: null, manifestStateSecretRef: null })
	expect(await manifestStateRows(db, id)).toBe(0)
	expect(await store.claimHandedOffCallback(ROTATED_STATE)).toBeNull()
}

export async function cancelStoreScenario(store: GitHubConnectionStore, vault: Vault, db: SqlDatabase, id: string, now: number): Promise<void> {
	const started = await begin(store, vault, id, now)
	expect(await store.cancelAwaitingAttempt(started)).toMatchObject({
		status: 'failed',
		lastErrorCode: 'cancelled',
		stateHash: null,
		manifestStateSecretRef: null,
	})
	expect(await manifestStateRows(db, id)).toBe(0)
	expect(await store.cancelAwaitingAttempt(started)).toBeNull()
	expect(await store.claimCallback(FIRST_STATE, 'alice')).toBeNull()
}
