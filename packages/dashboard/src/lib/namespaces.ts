import type { AppEnvDto, DeploymentNamespaceDto, PutAppEnvRequest } from './api'

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
