// The membership transport key of one application environment without an IAM service binding (ADR-0022 rule 6). A
// deploy reconciles it from the APPROVED snapshot: while the contract has an endpoint that spends a delegation grant or
// reads a member directory (a dimension's or the application's own), a share-link mount, or a terminal, IAM issues one key for `<app>@<env>`, sealed in the vault and
// handed to the provider as `FABRIKA_IAM_RPC_KEY`. The key only authenticates the application to IAM's `/membership/*`
// and pins its application id; the authority of each operation stays the end user's token, plus the proxy's delegation
// grant for scope creation and membership changes. Never logged, never returned over the API.

import {
	appEnvironmentId,
	type ContractArtifact,
	endpointAppDirectory,
	endpointDelegation,
	endpointDirectory,
	MAX_KEY_LIFETIME_SECONDS,
} from '@fabrika/auth-core'
import type { MembershipKeyRepository } from './db'
import { iamProvisioningClient, type IamProvisioningOptions } from './iam-provisioning'
import type { Vault, VaultSecretPurpose } from './vault'
import type { KeyReconcileOptions } from './workload-credentials'

/** A key with less than this left is replaced, so a running version never holds one that IAM stops honouring. */
export const MEMBERSHIP_KEY_ROTATE_BELOW_SECONDS = MAX_KEY_LIFETIME_SECONDS / 2

/** IAM's `membershipKeys.issue`: every key of the environment but `keep` and the new one is deleted. */
export interface MembershipKeyIssuer {
	issue(input: {
		readonly app: string
		readonly expiresAt: number
		/** The id of the key Control has recorded as active, or null when it has none. */
		readonly keep: string | null
	}): Promise<{ readonly key: string; readonly id: string; readonly expiresAt: number }>
}

export interface MembershipTransportPort {
	/**
	 * The environment's key while `needed`: the recorded key while it is fresh, or a newly issued one. Without need the
	 * record is dropped (IAM deletes the key with the schema reconcile that leaves the application no such operation).
	 * `additive` (see `KeyReconcileOptions`): the record is never dropped.
	 */
	reconcile(appId: string, env: string, needed: boolean, options?: KeyReconcileOptions): Promise<HandedMembershipKey | null>
}

export interface HandedMembershipKey {
	readonly key: string
	readonly expiresAt: number
}

/**
 * Whether the contract calls a membership operation: an endpoint that spends a delegation grant (`creates`, or a
 * dimension's `members.manage`), an endpoint on or in a dimension below a member directory (`ctx.members.get`, and
 * `list` for its `members.list`), an `app` endpoint of the application's own `members.list`, a share-link mount, or a
 * terminal, whose identifications travel on the same transport (ADR-0067). IAM keeps the key while the schema they
 * compile to has a delegation, a link mount, a dimension that lists its members, people of its own or a terminal.
 */
export function needsMembershipTransport(artifact: ContractArtifact | null): boolean {
	if (artifact === null) {
		return false
	}
	return artifact.endpoints.some((row) =>
		endpointDelegation(artifact, row) !== null || endpointDirectory(artifact, row) !== null || endpointAppDirectory(artifact, row)
	)
		|| Object.values(artifact.mounts).some((mount) => mount.kind === 'link')
		|| artifact.terminal !== undefined
}

/** The `{ scope, label }` the key is sealed under — the only record of which environment owns its vault row. */
export function membershipKeyPurpose(appId: string, env: string): VaultSecretPurpose {
	return { scope: 'platform', label: `platform:membership-key:${appEnvironmentId(appId, env)}` }
}

export class VaultMembershipTransport implements MembershipTransportPort {
	constructor(
		private readonly records: Pick<MembershipKeyRepository, 'get' | 'put' | 'delete'>,
		private readonly vault: () => Promise<Vault>,
		private readonly issuer: MembershipKeyIssuer,
		private readonly now: () => number = () => Math.floor(Date.now() / 1000),
	) {}

	async reconcile(appId: string, env: string, needed: boolean, options: KeyReconcileOptions = {}): Promise<HandedMembershipKey | null> {
		const additive = options.additive === true
		const row = await this.records.get(appId, env)
		if (!needed) {
			if (row !== null && !additive) {
				await this.records.delete(appId, env)
				await (await this.vault()).delete(row.value_ref)
			}
			return null
		}
		const vault = await this.vault()
		const purpose = membershipKeyPurpose(appId, env)
		const now = this.now()
		if (row !== null && row.expires_at - now > MEMBERSHIP_KEY_ROTATE_BELOW_SECONDS) {
			return { key: await vault.getSecretForPurpose(row.value_ref, purpose), expiresAt: row.expires_at }
		}
		// The recorded key stays IAM's active one until the record below names the new key; a failure in between leaves
		// the new key an orphan, which the next issuance deletes.
		const issued = await this.issuer.issue({ app: appEnvironmentId(appId, env), expiresAt: now + MAX_KEY_LIFETIME_SECONDS, keep: row?.key_id ?? null })
		const ref = await vault.putSecret(purpose.scope, purpose.label, issued.key)
		try {
			await this.records.put({ app_id: appId, env, value_ref: ref, key_id: issued.id, expires_at: issued.expiresAt })
		} catch (error) {
			await vault.delete(ref)
			throw error
		}
		if (row !== null) {
			await vault.delete(row.value_ref)
		}
		return { key: issued.key, expiresAt: issued.expiresAt }
	}
}

export type IamMembershipKeyIssuerOptions = IamProvisioningOptions

/** `membershipKeys.issue` on IAM's admin RPC, with the provisioning key as the bearer and nothing else. */
export function iamMembershipKeyIssuer(options: IamMembershipKeyIssuerOptions): MembershipKeyIssuer {
	const client = iamProvisioningClient(options)
	return {
		async issue(input) {
			const issued = await client.membershipKeys.issue({ app: input.app, expiresAt: input.expiresAt, keep: input.keep })
			return { key: issued.key, id: issued.id, expiresAt: issued.expiresAt }
		},
	}
}
