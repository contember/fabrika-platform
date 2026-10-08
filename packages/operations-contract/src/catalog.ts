/** Private Control → Operations source-catalog protocol; both services ship together. */

export const DEFAULT_OPERATIONS_SERVICE_KEY = 'default'

export interface OperationsSourceCoordinate {
	appId: string
	environment: string
	/** Omitted by Control while an app environment has only its default service. */
	serviceKey?: string
}

export interface CanonicalOperationsSourceCoordinate {
	appId: string
	environment: string
	serviceKey: string
}

/** Caller-owned write credential transported only over the private catalog channel. */
export interface OperationsCatalogIngestCredential {
	id: string
	publicKey: string
}

export interface OperationsCatalogSource {
	coordinate: OperationsSourceCoordinate
	displayName: string
	/** Canonical externally reachable origin when Control owns one; null when it does not. */
	publicOrigin?: string | null
	ingestCredential: OperationsCatalogIngestCredential
}

export interface CanonicalOperationsCatalogSource {
	coordinate: CanonicalOperationsSourceCoordinate
	displayName: string
	publicOrigin: string | null
	ingestCredential: OperationsCatalogIngestCredential
}

export interface OperationsCatalogReconcileRequest {
	revision: number
	snapshotHash: string
	sources: OperationsCatalogSource[]
}

export type OperationsCatalogReconcileOutcome = 'applied' | 'unchanged' | 'stale'

export interface OperationsCatalogIngestResult {
	coordinate: CanonicalOperationsSourceCoordinate
	credentialId: string
	ingestProjectId: string
}

export interface OperationsCatalogReconcileResponse {
	revision: number
	outcome: OperationsCatalogReconcileOutcome
	ingest: OperationsCatalogIngestResult[]
}

export function canonicalOperationsServiceKey(serviceKey: string | undefined): string {
	return serviceKey ?? DEFAULT_OPERATIONS_SERVICE_KEY
}

export function canonicalOperationsCatalogSources(
	sources: readonly OperationsCatalogSource[],
): CanonicalOperationsCatalogSource[] {
	return sources.map((source) => ({
		coordinate: {
			appId: source.coordinate.appId,
			environment: source.coordinate.environment,
			serviceKey: canonicalOperationsServiceKey(source.coordinate.serviceKey),
		},
		displayName: source.displayName,
		publicOrigin: source.publicOrigin ?? null,
		ingestCredential: source.ingestCredential,
	})).sort((left, right) => {
		const app = left.coordinate.appId.localeCompare(right.coordinate.appId)
		if (app !== 0) return app
		const environment = left.coordinate.environment.localeCompare(right.coordinate.environment)
		if (environment !== 0) return environment
		return left.coordinate.serviceKey.localeCompare(right.coordinate.serviceKey)
	})
}

/** Hash the canonical source array only; revision is transport ordering, not catalog content. */
export async function operationsCatalogSnapshotHash(sources: readonly OperationsCatalogSource[]): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify(canonicalOperationsCatalogSources(sources)))
	const digest = await crypto.subtle.digest('SHA-256', bytes)
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
