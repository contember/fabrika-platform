import { type FabrikaManifest, manifestServiceHostnames } from './manifest'
import type { ZeropsRuntimeTarget } from './types'

export type ZeropsStepKind =
	| 'apply-import'
	| 'verify-exposure'
	| 'write-service-env'
	| 'raise-start-memory'
	| 'size-database'
	| 'reserve-version'
	| 'upload-source'
	| 'trigger-build'
	| 'await-version'
	| 'reconcile-schema'

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
	steps.push({
		id: 'verify-exposure',
		kind: 'verify-exposure',
		description: 'Read back that no service has subdomain access and every bucket is one the platform created private',
	})
	steps.push({ id: 'write-service-env', kind: 'write-service-env', description: 'Write the managed service variables' })
	steps.push({
		id: 'raise-start-memory',
		kind: 'raise-start-memory',
		description: "Raise the deploy service's minimum RAM to what its init commands need, and pin a dev environment to one container",
	})
	steps.push({
		id: 'size-database',
		kind: 'size-database',
		description: "Size each process's database connections to the database's limit, raising its minimum RAM where it is too low",
	})
	steps.push({ id: 'reserve-version', kind: 'reserve-version', description: 'Reserve a Zerops app version' })
	steps.push({ id: 'upload-source', kind: 'upload-source', description: 'Upload the resolved repository snapshot' })
	steps.push({ id: 'trigger-build', kind: 'trigger-build', description: 'Trigger the Zerops build+deploy pipeline' })
	steps.push({ id: 'await-version', kind: 'await-version', description: 'Await the Zerops pipeline and relay its build log' })
	if (manifest.app.schema !== undefined && target.propustkaUrl !== undefined) {
		steps.push({ id: 'reconcile-schema', kind: 'reconcile-schema', description: 'Reconcile authz schema into IAM' })
	}

	return steps
}
