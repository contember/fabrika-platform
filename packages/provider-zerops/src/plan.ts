import type { ProviderDeployPlan, ProviderJobSpec } from '@fabrika/provider-contract'
import type { FabrikaManifestV1 } from './manifest'
import type { ZeropsRuntimeTarget } from './types'

export type ZeropsStepKind = 'apply-import' | 'trigger-deploy' | 'await-deploy' | 'reconcile-schema'

export interface ZeropsJobSpec extends ProviderJobSpec {
	readonly kind: ZeropsStepKind
}

export interface ZeropsPlan extends ProviderDeployPlan {
	readonly steps: readonly ZeropsJobSpec[]
}

/** Resolve the one declared service that receives this repository's code. */
export const resolveDeployHostname = (manifest: FabrikaManifestV1): string => {
	const { deployService, serviceHostnames } = manifest.target
	if (!serviceHostnames.includes(deployService)) {
		throw new Error(`zerops: \`deployService: ${deployService}\` names no declared service (have: ${serviceHostnames.join(', ') || 'none'})`)
	}
	return deployService
}

/** Build the provider-owned deploy order without touching the platform. */
export const buildZeropsPlan = (
	manifest: FabrikaManifestV1,
	target: ZeropsRuntimeTarget,
	env: string,
): ZeropsPlan => {
	const steps: ZeropsJobSpec[] = []
	let previous: string | undefined
	const add = (spec: Omit<ZeropsJobSpec, 'dependsOn'>): void => {
		steps.push(previous === undefined ? spec : { ...spec, dependsOn: [previous] })
		previous = spec.id
	}

	add({
		id: 'apply-import',
		kind: 'apply-import',
		description: `Apply the Zerops import for ${manifest.target.serviceHostnames.length} service(s): ${manifest.target.serviceHostnames.join(', ')}`,
	})
	add({ id: 'trigger-deploy', kind: 'trigger-deploy', description: 'Trigger the Zerops build+deploy pipeline' })
	add({ id: 'await-deploy', kind: 'await-deploy', description: 'Await the Zerops pipeline and relay its build log' })
	if (manifest.app.schema !== undefined && target.propustkaUrl !== undefined) {
		add({ id: 'reconcile-schema', kind: 'reconcile-schema', description: 'Reconcile authz schema into propustka' })
	}

	return { appId: manifest.app.id, env, steps }
}
