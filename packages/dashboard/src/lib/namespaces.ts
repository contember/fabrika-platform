import type { AppEnvDto, DeploymentNamespaceDto, DeploymentNamespaceState, PutAppEnvRequest } from './api'

/** Poll interval while a placement is still settling. The work is minutes long; two seconds is plenty. */
const NAMESPACE_POLL_INTERVAL_MS = 2_000

export type NamespacePollScheduler = (callback: () => void, delayMs: number) => () => void

/** The provider mutation runs behind the queue, so a non-terminal state means work is still in flight. */
export function isNamespaceSettling(state: DeploymentNamespaceState): boolean {
	return state === 'pending' || state === 'provisioning'
}

/**
 * Keep a settling placement's view fresh without a caller staying connected to the mutation — the whole
 * point of provisioning behind the queue. Returns the cancel function the effect cleans up with.
 */
export function scheduleNamespacePoll(
	state: DeploymentNamespaceState,
	invalidate: () => void,
	schedule: NamespacePollScheduler,
): () => void {
	if (!isNamespaceSettling(state)) return () => undefined
	return schedule(invalidate, NAMESPACE_POLL_INTERVAL_MS)
}

/** Placements that can own this exact app environment without changing provider coordinates. */
export function compatibleNamespaces(
	appId: string,
	environment: AppEnvDto,
	namespaces: readonly DeploymentNamespaceDto[],
): DeploymentNamespaceDto[] {
	return namespaces.filter((namespace) =>
		namespace.state === 'ready'
		&& namespace.env === environment.env
		&& namespace.provider === environment.provider
		&& (namespace.exclusiveAppId === null || namespace.exclusiveAppId === appId)
	)
}

/** Change placement coordinates without interpreting or rebuilding provider envelopes. */
export function namespaceAssignmentRequest(environment: AppEnvDto, namespaceId: string | null): PutAppEnvRequest {
	return {
		domain: environment.domain,
		publicOrigin: environment.publicOrigin,
		triggerRef: environment.triggerRef,
		namespaceId,
		target: environment.target,
		artifact: environment.artifact,
	}
}
