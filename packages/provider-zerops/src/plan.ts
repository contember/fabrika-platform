import { type FabrikaManifest, manifestServiceHostnames } from './manifest'
import type { ZeropsRuntimeTarget } from './types'

export type ZeropsStepKind = 'apply-import' | 'trigger-deploy' | 'await-deploy' | 'reconcile-schema'

export interface ZeropsStep {
	readonly id: string
	readonly kind: ZeropsStepKind
	readonly description: string
}

/** Resolve the one declared service that receives this repository's code. */
export const resolveDeployHostname = (manifest: FabrikaManifest): string => {
	const { deployService } = manifest.target
	const serviceHostnames = manifestServiceHostnames(manifest)
	if (!serviceHostnames.includes(deployService)) {
		throw new Error(`zerops: \`deployService: ${deployService}\` names no declared service (have: ${serviceHostnames.join(', ') || 'none'})`)
	}
	return deployService
}

/** Build the provider-owned deploy order without touching the platform. */
export const buildZeropsPlan = (manifest: FabrikaManifest, target: ZeropsRuntimeTarget): readonly ZeropsStep[] => {
	const serviceHostnames = manifestServiceHostnames(manifest)
	const steps: ZeropsStep[] = []

	steps.push({
		id: 'apply-import',
		kind: 'apply-import',
		description: `Apply the Zerops import for ${serviceHostnames.length} service(s): ${serviceHostnames.join(', ')}`,
	})
	steps.push({ id: 'trigger-deploy', kind: 'trigger-deploy', description: 'Trigger the Zerops build+deploy pipeline' })
	steps.push({ id: 'await-deploy', kind: 'await-deploy', description: 'Await the Zerops pipeline and relay its build log' })
	if (manifest.app.schema !== undefined && target.propustkaUrl !== undefined) {
		steps.push({ id: 'reconcile-schema', kind: 'reconcile-schema', description: 'Reconcile authz schema into IAM' })
	}

	return steps
}
