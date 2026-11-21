// The workload keys of a local run (`composeLocalApplication`). A deploy gets one key per job, webhook and public
// procedure from Control, which issues it through IAM's `workloads.issueKey`; a local run has no Control, so it makes
// the same call with IAM's provisioning key. The keys are secrets: never log one.

import type { RpcFetch } from '@fabrika/app'
import { appEnvironmentId, type ContractArtifact, contractWorkloads, MAX_KEY_LIFETIME_SECONDS, workloadKeyVariable } from '@fabrika/auth-core'
import { createIamAdminClient } from '@fabrika/installation-init'

/** Every variable a key of the contract's jobs, webhooks and public procedures travels under, sorted. */
export const localWorkloadKeyVariables = (contract: ContractArtifact): readonly string[] =>
	contractWorkloads(contract).map(({ kind, name }) => workloadKeyVariable(kind, name)).sort()

export interface LocalWorkloadKeyOptions {
	readonly contract: ContractArtifact
	/** The application's id, `config.id`. */
	readonly appId: string
	/** The local run's environment, as `composeLocalApplication` gets it. */
	readonly env: string
	/** IAM's origin, which must already hold the application's schema (`PUT /admin/apps/<app>@<env>/schema`). */
	readonly iamOrigin: string
	/** The provisioning key the local IAM runs with (`FABRIKA_IAM_PROVISIONING_KEY`). */
	readonly provisioningKey: string
	readonly fetch?: RpcFetch
	readonly now?: Date
}

export interface LocalWorkloadKeys {
	/** When the keys stop being honoured (unix seconds): IAM issues a key for at most 30 days. */
	readonly expiresAt: number
	/** Each key by its variable, for `composeLocalApplication`'s `workloadKeys`. */
	readonly variables: Readonly<Record<string, string>>
}

/**
 * Issues a fresh key for every workload of the contract, as a deploy's Control does. IAM revokes the workload's
 * earlier keys, so a running local application keeps working only until it is composed again with these.
 */
export const issueLocalWorkloadKeys = async (options: LocalWorkloadKeyOptions): Promise<LocalWorkloadKeys> => {
	const iam = createIamAdminClient({
		origin: options.iamOrigin,
		provisioningKey: options.provisioningKey,
		...(options.fetch === undefined ? {} : { fetch: options.fetch }),
	})
	const app = appEnvironmentId(options.appId, options.env)
	const expiresAt = Math.floor((options.now ?? new Date()).getTime() / 1000) + MAX_KEY_LIFETIME_SECONDS
	const variables: Record<string, string> = {}
	for (const { kind, name } of contractWorkloads(options.contract)) {
		const issued = await iam.workloads.issueKey({ app, kind, name, expiresAt, keep: null })
		variables[workloadKeyVariable(kind, name)] = issued.key
	}
	return { expiresAt, variables }
}
