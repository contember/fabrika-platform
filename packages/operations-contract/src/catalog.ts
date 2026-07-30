/** Versioned private Control → Operations source-catalog protocol. */

export const OPERATIONS_CATALOG_PROTOCOL_VERSION = 1
export const DEFAULT_OPERATIONS_SERVICE_KEY = 'default'

export interface OperationsSourceCoordinateV1 {
	appId: string
	environment: string
	/** Omitted by Control while an app environment has only its default service. */
	serviceKey?: string
}

export interface CanonicalOperationsSourceCoordinateV1 {
	appId: string
	environment: string
	serviceKey: string
}

export interface OperationsCatalogSourceV1 {
	coordinate: OperationsSourceCoordinateV1
	displayName: string
	/** Canonical externally reachable origin when Control owns one; null when it does not. */
	publicOrigin?: string | null
}

export interface CanonicalOperationsCatalogSourceV1 {
	coordinate: CanonicalOperationsSourceCoordinateV1
	displayName: string
	publicOrigin: string | null
}

export interface OperationsCatalogReconcileRequestV1 {
	protocolVersion: typeof OPERATIONS_CATALOG_PROTOCOL_VERSION
	revision: number
	snapshotHash: string
	sources: OperationsCatalogSourceV1[]
}

export type OperationsCatalogReconcileOutcome = 'applied' | 'unchanged' | 'stale'

export interface OperationsCatalogReconcileResponseV1 {
	protocolVersion: typeof OPERATIONS_CATALOG_PROTOCOL_VERSION
	revision: number
	outcome: OperationsCatalogReconcileOutcome
	created: number
	updated: number
	disabled: number
	reenabled: number
	unchanged: number
}

export function canonicalOperationsServiceKey(serviceKey: string | undefined): string {
	return serviceKey ?? DEFAULT_OPERATIONS_SERVICE_KEY
}

export function canonicalOperationsCatalogSources(
	sources: readonly OperationsCatalogSourceV1[],
): CanonicalOperationsCatalogSourceV1[] {
	return sources.map((source) => ({
		coordinate: {
			appId: source.coordinate.appId,
			environment: source.coordinate.environment,
			serviceKey: canonicalOperationsServiceKey(source.coordinate.serviceKey),
		},
		displayName: source.displayName,
		publicOrigin: source.publicOrigin ?? null,
	})).sort((left, right) => {
		const app = left.coordinate.appId.localeCompare(right.coordinate.appId)
		if (app !== 0) return app
		const environment = left.coordinate.environment.localeCompare(right.coordinate.environment)
		if (environment !== 0) return environment
		return left.coordinate.serviceKey.localeCompare(right.coordinate.serviceKey)
	})
}

/** Hash the canonical source array only; revision is transport ordering, not catalog content. */
export async function operationsCatalogSnapshotHash(sources: readonly OperationsCatalogSourceV1[]): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify(canonicalOperationsCatalogSources(sources)))
	const digest = await crypto.subtle.digest('SHA-256', bytes)
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
