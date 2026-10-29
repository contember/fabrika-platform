// The platform transport key of one application environment: the bearer it calls a platform receiver of Control (the
// mail relay) with. Control issues it itself, keeps only its SHA-256 hash in `platform_transport_keys`, and seals the
// value in the vault to hand it to the next deploy. Never logged, never returned over the API.

import { appEnvironmentId, MAX_KEY_LIFETIME_SECONDS, type PlatformReceiver } from '@fabrika/auth-core'
import { hashPlatformKey } from '@fabrika/email/platform'
import { uuidv7 } from '@fabrika/platform'
import type { PlatformTransportKeyRepository, PlatformTransportKeyRow } from './db'
import type { Vault, VaultSecretPurpose } from './vault'

export const PLATFORM_KEY_LIFETIME_SECONDS = MAX_KEY_LIFETIME_SECONDS

/** A key with less than this left is replaced, so a running version never holds one that is about to expire. */
export const PLATFORM_KEY_ROTATE_BELOW_SECONDS = PLATFORM_KEY_LIFETIME_SECONDS / 2

/** A key bound to one MCP workspace of a `dev` environment: its sandbox's launcher authenticates with it. */
export interface PlatformKeyScope {
	readonly workspaceId?: string
}

export interface PlatformTransportPort {
	/**
	 * The environment's key for `receiver`, or the workspace's when `scope` names one: the newest one while it is fresh,
	 * or a newly issued one.
	 */
	issue(appId: string, env: string, receiver: PlatformReceiver, scope?: PlatformKeyScope): Promise<string>
	/**
	 * Delete every key of the receiver and its vault row. Called only once a version that holds none of them runs:
	 * until then the previous version calls the receiver with its key.
	 */
	revoke(appId: string, env: string, receiver: PlatformReceiver): Promise<void>
	/** Delete every `source` key of the workspace and its vault rows, once its sandbox is gone. */
	revokeWorkspaceSourceKeys(appId: string, env: string, workspaceId: string): Promise<void>
}

/** The `{ scope, label }` the key is sealed under — the only record of which environment owns its vault row. */
export function platformKeyPurpose(appId: string, env: string, receiver: PlatformReceiver, scope: PlatformKeyScope = {}): VaultSecretPurpose {
	const workspace = scope.workspaceId === undefined ? '' : `:${scope.workspaceId}`
	return { scope: 'platform', label: `platform:platform-key:${appEnvironmentId(appId, env)}:${receiver}${workspace}` }
}

/** `px_` and 160 random bits as 27 base64url characters, the format of the keys IAM issues. */
export function generatePlatformKey(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(20))
	return `px_${btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}`
}

export class VaultPlatformTransport implements PlatformTransportPort {
	constructor(
		private readonly records: Pick<
			PlatformTransportKeyRepository,
			'insert' | 'listForAppEnv' | 'deleteForAppEnv' | 'deleteForWorkspace' | 'deleteExpired'
		>,
		private readonly vault: () => Promise<Vault>,
		private readonly now: () => number = () => Math.floor(Date.now() / 1000),
	) {}

	async issue(appId: string, env: string, receiver: PlatformReceiver, scope: PlatformKeyScope = {}): Promise<string> {
		const workspaceId = scope.workspaceId ?? null
		const rows = (await this.receiverKeys(appId, env, receiver)).filter((row) => row.workspace_id === workspaceId)
		const vault = await this.vault()
		const purpose = platformKeyPurpose(appId, env, receiver, scope)
		const now = this.now()
		const newest = rows[0]
		if (newest !== undefined && newest.expires_at - now > PLATFORM_KEY_ROTATE_BELOW_SECONDS) {
			return vault.getSecretForPurpose(newest.value_ref, purpose)
		}
		const key = generatePlatformKey()
		const ref = await vault.putSecret(purpose.scope, purpose.label, key)
		let recorded: boolean
		try {
			recorded = await this.records.insert({
				app_id: appId,
				env,
				receiver,
				key_id: uuidv7(),
				key_hash: await hashPlatformKey(key),
				value_ref: ref,
				expires_at: now + PLATFORM_KEY_LIFETIME_SECONDS,
				created_at: now,
				workspace_id: workspaceId,
			})
		} catch (error) {
			await vault.delete(ref)
			throw error
		}
		if (!recorded) {
			await vault.delete(ref)
			throw new Error(`workspace ${workspaceId ?? ''} has no dev sandbox in ${appId}/${env}, or it is being removed`)
		}
		// A replaced key stays valid by its hash row until its own expiry, but Control never hands its value out again.
		for (const row of rows) await vault.delete(row.value_ref)
		await this.records.deleteExpired(now)
		return key
	}

	async revoke(appId: string, env: string, receiver: PlatformReceiver): Promise<void> {
		const rows = await this.receiverKeys(appId, env, receiver)
		if (rows.length === 0) return
		await this.records.deleteForAppEnv(appId, env, receiver)
		const vault = await this.vault()
		for (const row of rows) await vault.delete(row.value_ref)
	}

	async revokeWorkspaceSourceKeys(appId: string, env: string, workspaceId: string): Promise<void> {
		const rows = (await this.receiverKeys(appId, env, 'source')).filter((row) => row.workspace_id === workspaceId)
		if (rows.length === 0) return
		await this.records.deleteForWorkspace(appId, env, 'source', workspaceId)
		const vault = await this.vault()
		for (const row of rows) await vault.delete(row.value_ref)
	}

	private async receiverKeys(appId: string, env: string, receiver: PlatformReceiver): Promise<PlatformTransportKeyRow[]> {
		return (await this.records.listForAppEnv(appId, env)).filter((row) => row.receiver === receiver)
	}
}
