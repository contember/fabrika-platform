// The workload credentials of one application environment (ADR-0022 "Principal kinds"). A deploy reconciles them from
// the APPROVED snapshot: one IAM-issued key per job, per webhook and per public procedure of the contract, handed to the
// provider under `workloadKeyVariable`, and one connector key per owner application the contract imports from, handed as
// each import's `FABRIKA_CONNECT_<IMPORT>_KEY`. Each is sealed in the vault. What a key may do is not decided here: IAM resolves
// it to the actions the approved schema declares for the workload — the owner's, for a connector key. A key is never
// logged and never returned over the API.

import {
	appEnvironmentId,
	connectVariables,
	type ContractArtifact,
	contractWorkloads,
	MAX_KEY_LIFETIME_SECONDS,
	type OwnWorkloadKind,
	workloadKeyVariable,
} from '@fabrika/auth-core'
import type { WorkloadCredentialRepository, WorkloadCredentialRow } from './db'
import { iamProvisioningClient, type IamProvisioningOptions } from './iam-provisioning'
import type { Vault, VaultSecretPurpose } from './vault'

export type WorkloadKind = OwnWorkloadKind

/**
 * A recorded key: a job's, a webhook's, a public procedure's (named by its endpoint id), or the connector key at an
 * owner application (`app`, named by the owner).
 */
export type CredentialKind = WorkloadKind | 'app'

/** A key with less than this left is replaced, so a running version never holds one that IAM stops honouring. */
export const WORKLOAD_KEY_ROTATE_BELOW_SECONDS = MAX_KEY_LIFETIME_SECONDS / 2

/**
 * IAM's `workloads.issueKey`, as Control reaches it with the installation's provisioning key. IAM revokes every key of
 * the workload except `keep` and the new one, so a key issued by an attempt whose record failed never outlives the next.
 */
export interface WorkloadKeyIssuer {
	issue(input: {
		readonly app: string
		readonly kind: CredentialKind
		readonly name: string
		readonly expiresAt: number
		/** The credential id of the key Control has recorded as active, or null when it has none. */
		readonly keep: string | null
	}): Promise<{
		readonly key: string
		readonly credentialId: string
		readonly expiresAt: number
	}>
	/** Revoke every key of the workload, the one a rotation kept included (`workloads.revokeKeys`). */
	revoke(input: { readonly app: string; readonly kind: CredentialKind; readonly name: string }): Promise<void>
}

export interface WorkloadCredentialsPort {
	/**
	 * The keys `artifact` needs, by framework variable: each recorded key that is still fresh, or a newly issued one;
	 * the record of a workload or an owner the contract no longer names is dropped. A contract with no job, webhook,
	 * public procedure or import needs none.
	 */
	reconcile(appId: string, env: string, artifact: ContractArtifact | null): Promise<Readonly<Record<string, string>>>
}

/** The `{ scope, label }` a workload key is sealed under — the only record of which workload owns its vault row. */
export function workloadKeyPurpose(appId: string, env: string, kind: CredentialKind, name: string): VaultSecretPurpose {
	return { scope: 'platform', label: `platform:workload-key:${appEnvironmentId(appId, env)}:${kind}:${name}` }
}

/**
 * Every job, webhook and public procedure of the contract, by the variable its key travels under. Two that share one
 * are refused.
 */
export function declaredWorkloads(artifact: ContractArtifact | null): ReadonlyMap<string, { readonly kind: WorkloadKind; readonly name: string }> {
	const workloads = new Map<string, { readonly kind: WorkloadKind; readonly name: string }>()
	if (artifact === null) {
		return workloads
	}
	for (const workload of contractWorkloads(artifact)) {
		const variable = workloadKeyVariable(workload.kind, workload.name)
		const taken = workloads.get(variable)
		if (taken !== undefined) {
			throw new Error(`the ${workload.kind} '${workload.name}' and the ${taken.kind} '${taken.name}' would share the variable ${variable}; rename one`)
		}
		workloads.set(variable, { kind: workload.kind, name: workload.name })
	}
	return workloads
}

/**
 * Every owner application the contract imports from, with the variables of its imports: one connector key per owner,
 * because IAM keeps one active key per workload and the consumer is one workload at the owner.
 */
export function declaredConnectors(artifact: ContractArtifact | null): ReadonlyMap<string, readonly string[]> {
	const owners = new Map<string, string[]>()
	for (const [name, imported] of Object.entries(artifact?.imports ?? {})) {
		owners.set(imported.app, [...(owners.get(imported.app) ?? []), connectVariables(name).key])
	}
	return owners
}

/** One key to keep: where IAM issues it, the record it is kept under, and the variables it is handed as. */
interface CredentialSlot {
	readonly kind: CredentialKind
	/** The recorded name: the workload's, or the owner application's for a connector key. */
	readonly name: string
	readonly iamApp: string
	/** The workload's name at IAM: for a connector key, the consuming application. */
	readonly iamName: string
	readonly variables: readonly string[]
}

function credentialSlots(appId: string, env: string, artifact: ContractArtifact | null): CredentialSlot[] {
	const own = appEnvironmentId(appId, env)
	const workloads = [...declaredWorkloads(artifact)].map(([variable, workload]): CredentialSlot => ({
		kind: workload.kind,
		name: workload.name,
		iamApp: own,
		iamName: workload.name,
		variables: [variable],
	}))
	const connectors = [...declaredConnectors(artifact)].map(([owner, variables]): CredentialSlot => ({
		kind: 'app',
		name: owner,
		iamApp: appEnvironmentId(owner, env),
		iamName: appId,
		variables,
	}))
	return [...workloads, ...connectors]
}

export class VaultWorkloadCredentials implements WorkloadCredentialsPort {
	constructor(
		private readonly records: Pick<WorkloadCredentialRepository, 'list' | 'put' | 'delete'>,
		private readonly vault: () => Promise<Vault>,
		private readonly issuer: WorkloadKeyIssuer,
		private readonly now: () => number = () => Math.floor(Date.now() / 1000),
	) {}

	async reconcile(appId: string, env: string, artifact: ContractArtifact | null): Promise<Readonly<Record<string, string>>> {
		const slots = credentialSlots(appId, env, artifact)
		const recorded = await this.records.list(appId, env)
		const keys: Record<string, string> = {}
		if (slots.length === 0 && recorded.length === 0) {
			return keys
		}
		const vault = await this.vault()
		const now = this.now()
		for (const slot of slots) {
			const key = await this.#keyOf(vault, appId, env, slot, recorded, now)
			for (const variable of slot.variables) {
				keys[variable] = key
			}
		}
		// IAM revokes the keys of a job, webhook or public procedure the reconciled schema no longer declares. An import removed here is
		// still declared by its owner, so Control revokes the pair's keys itself, before it forgets the record: a failed
		// revocation fails the deploy and keeps the record, and the retry revokes again.
		for (const row of recorded) {
			if (!slots.some((slot) => slot.kind === row.kind && slot.name === row.name)) {
				if (row.kind === 'app') {
					await this.issuer.revoke({ app: appEnvironmentId(row.name, env), kind: 'app', name: appId })
				}
				await this.records.delete(appId, env, row.kind, row.name)
				await vault.delete(row.value_ref)
			}
		}
		return keys
	}

	async #keyOf(
		vault: Vault,
		appId: string,
		env: string,
		slot: CredentialSlot,
		recorded: readonly WorkloadCredentialRow[],
		now: number,
	): Promise<string> {
		const purpose = workloadKeyPurpose(appId, env, slot.kind, slot.name)
		const row = recorded.find((candidate) => candidate.kind === slot.kind && candidate.name === slot.name)
		if (row !== undefined && row.expires_at - now > WORKLOAD_KEY_ROTATE_BELOW_SECONDS) {
			return await vault.getSecretForPurpose(row.value_ref, purpose)
		}
		// The recorded key stays IAM's active one until the record below names the new key; a failure in between
		// leaves the new key an orphan, which the next issuance revokes.
		const issued = await this.issuer.issue({
			app: slot.iamApp,
			kind: slot.kind,
			name: slot.iamName,
			expiresAt: now + MAX_KEY_LIFETIME_SECONDS,
			keep: row?.credential_id ?? null,
		})
		const ref = await vault.putSecret(purpose.scope, purpose.label, issued.key)
		try {
			await this.records.put({
				app_id: appId,
				env,
				kind: slot.kind,
				name: slot.name,
				value_ref: ref,
				credential_id: issued.credentialId,
				expires_at: issued.expiresAt,
			})
		} catch (error) {
			await vault.delete(ref)
			throw error
		}
		if (row !== undefined) {
			await vault.delete(row.value_ref)
		}
		return issued.key
	}
}

export type IamWorkloadKeyIssuerOptions = IamProvisioningOptions

/** `workloads.issueKey` on IAM's admin RPC, with the provisioning key as the bearer and nothing else. */
export function iamWorkloadKeyIssuer(options: IamWorkloadKeyIssuerOptions): WorkloadKeyIssuer {
	const client = iamProvisioningClient(options)
	return {
		async issue(input) {
			const issued = await client.workloads.issueKey({
				app: input.app,
				kind: input.kind,
				name: input.name,
				expiresAt: input.expiresAt,
				keep: input.keep,
			})
			return { key: issued.key, credentialId: issued.credentialId, expiresAt: issued.expiresAt }
		},
		async revoke(input) {
			await client.workloads.revokeKeys({ app: input.app, kind: input.kind, name: input.name })
		},
	}
}
