// The workload credentials of one application environment (ADR-0022 "Principal kinds"). A deploy reconciles them from
// the APPROVED snapshot: one IAM-issued key per job and per webhook of the contract, sealed in the vault and handed to
// the provider as `FABRIKA_<KIND>_<NAME>_KEY`. What a key may do is not decided here: IAM resolves it to the actions the
// approved schema declares for the workload. A key is never logged and never returned over the API.

import { createRpcClient, type RpcFetch } from '@fabrika/app'
import { appEnvironmentId, type ContractArtifact, MAX_KEY_LIFETIME_SECONDS, workloadKeyVariable } from '@fabrika/auth-core'
import type { IamAdminRpcContract } from '@fabrika/iam-contract'
import type { WorkloadCredentialRepository } from './db'
import type { Vault, VaultSecretPurpose } from './vault'

export type WorkloadKind = 'job' | 'webhook'

/** A key with less than this left is replaced, so a running version never holds one that IAM stops honouring. */
export const WORKLOAD_KEY_ROTATE_BELOW_SECONDS = MAX_KEY_LIFETIME_SECONDS / 2

/** IAM's `workloads.issueKey`, as Control reaches it with the installation's provisioning key. */
export interface WorkloadKeyIssuer {
	issue(input: { readonly app: string; readonly kind: WorkloadKind; readonly name: string; readonly expiresAt: number }): Promise<{
		readonly key: string
		readonly expiresAt: number
	}>
}

export interface WorkloadCredentialsPort {
	/**
	 * The keys `artifact` needs, by framework variable: each recorded key that is still fresh, or a newly issued one;
	 * the record of a workload the contract no longer declares is dropped. A contract with no job or webhook needs none.
	 */
	reconcile(appId: string, env: string, artifact: ContractArtifact | null): Promise<Readonly<Record<string, string>>>
}

/** The `{ scope, label }` a workload key is sealed under — the only record of which workload owns its vault row. */
export function workloadKeyPurpose(appId: string, env: string, kind: WorkloadKind, name: string): VaultSecretPurpose {
	return { scope: 'platform', label: `platform:workload-key:${appEnvironmentId(appId, env)}:${kind}:${name}` }
}

/** Every job and webhook of the contract, by the variable its key travels under. Two that share one are refused. */
export function declaredWorkloads(artifact: ContractArtifact | null): ReadonlyMap<string, { readonly kind: WorkloadKind; readonly name: string }> {
	const workloads = new Map<string, { readonly kind: WorkloadKind; readonly name: string }>()
	if (artifact === null) {
		return workloads
	}
	const all: { kind: WorkloadKind; name: string }[] = [
		...Object.keys(artifact.jobs).map((name) => ({ kind: 'job' as const, name })),
		...Object.entries(artifact.mounts).flatMap(([name, mount]) => (mount.kind === 'webhook' ? [{ kind: 'webhook' as const, name }] : [])),
	]
	for (const workload of all) {
		const variable = workloadKeyVariable(workload.kind, workload.name)
		const taken = workloads.get(variable)
		if (taken !== undefined) {
			throw new Error(`the ${workload.kind} '${workload.name}' and the ${taken.kind} '${taken.name}' would share the variable ${variable}; rename one`)
		}
		workloads.set(variable, workload)
	}
	return workloads
}

export class VaultWorkloadCredentials implements WorkloadCredentialsPort {
	constructor(
		private readonly records: WorkloadCredentialRepository,
		private readonly vault: () => Promise<Vault>,
		private readonly issuer: WorkloadKeyIssuer,
		private readonly now: () => number = () => Math.floor(Date.now() / 1000),
	) {}

	async reconcile(appId: string, env: string, artifact: ContractArtifact | null): Promise<Readonly<Record<string, string>>> {
		const declared = declaredWorkloads(artifact)
		const recorded = await this.records.list(appId, env)
		const keys: Record<string, string> = {}
		if (declared.size === 0 && recorded.length === 0) {
			return keys
		}
		const vault = await this.vault()
		const now = this.now()
		for (const [variable, workload] of declared) {
			const purpose = workloadKeyPurpose(appId, env, workload.kind, workload.name)
			const row = recorded.find((candidate) => candidate.kind === workload.kind && candidate.name === workload.name)
			if (row !== undefined && row.expires_at - now > WORKLOAD_KEY_ROTATE_BELOW_SECONDS) {
				keys[variable] = await vault.getSecretForPurpose(row.value_ref, purpose)
				continue
			}
			const issued = await this.issuer.issue({
				app: appEnvironmentId(appId, env),
				kind: workload.kind,
				name: workload.name,
				expiresAt: now + MAX_KEY_LIFETIME_SECONDS,
			})
			const ref = await vault.putSecret(purpose.scope, purpose.label, issued.key)
			await this.records.put({ app_id: appId, env, kind: workload.kind, name: workload.name, value_ref: ref, expires_at: issued.expiresAt })
			if (row !== undefined) {
				await vault.delete(row.value_ref)
			}
			keys[variable] = issued.key
		}
		// IAM revokes the keys of a workload the reconciled schema no longer declares; Control forgets its copy.
		for (const row of recorded) {
			const stillDeclared = [...declared.values()].some((workload) => workload.kind === row.kind && workload.name === row.name)
			if (!stillDeclared) {
				await this.records.delete(appId, env, row.kind, row.name)
				await vault.delete(row.value_ref)
			}
		}
		return keys
	}
}

export interface IamWorkloadKeyIssuerOptions {
	/** IAM's public origin, the installation's `FABRIKA_IAM_ISSUER`. */
	readonly origin: string
	/** The installation's provisioning key: the credential every deploy reconciles IAM with. */
	readonly provisioningKey: string
	readonly fetch?: RpcFetch
}

/** `workloads.issueKey` on IAM's admin RPC, with the provisioning key as the bearer and nothing else. */
export function iamWorkloadKeyIssuer(options: IamWorkloadKeyIssuerOptions): WorkloadKeyIssuer {
	const call = options.fetch ?? fetch
	const client = createRpcClient<IamAdminRpcContract>({
		baseUrl: `${options.origin.replace(/\/+$/, '')}/admin/rpc`,
		bounceOnAuth: false,
		fetch: (input, init) => {
			const headers = new Headers(init?.headers)
			headers.set('authorization', `Bearer ${options.provisioningKey}`)
			return call(input, { ...init, headers })
		},
	})
	return {
		async issue(input) {
			const issued = await client.workloads.issueKey({ app: input.app, kind: input.kind, name: input.name, expiresAt: input.expiresAt })
			return { key: issued.key, expiresAt: issued.expiresAt }
		},
	}
}
