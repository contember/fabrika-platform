import type { ProviderNamespaceHost } from '@fabrika/provider-contract'
import type { ZeropsApi, ZeropsProjectMode } from '../api'
import type { Sleeper } from '../collaborators'
import type { ZeropsArtifactSourceDescriptor } from '../manifest'
import type { ZeropsSourceClient, ZeropsSourceRepository } from '../source'
import type { ZeropsSourceTarget } from '../types'

export type ZeropsNamespacePublicAccess = 'custom-domain' | 'zerops-subdomain'

export interface ZeropsNamespaceProxySource {
	readonly repository: ZeropsSourceRepository
	readonly commitSha: string
	readonly descriptor: ZeropsArtifactSourceDescriptor
}

/** The proxy attempt in flight (ADR-0044): a version not `triggered` is deleted, a triggered one is polled. */
export interface ZeropsNamespaceProxyBuild {
	readonly appVersionId: string
	readonly triggered: boolean
	readonly manifestSha256?: string
}

export interface ZeropsNamespaceProxyDeployment {
	readonly manifestSha256?: string
	readonly appVersionId: string
	readonly repository: ZeropsSourceRepository
	readonly commitSha: string
	readonly descriptorSha256: string
}

export type ZeropsNamespacePostgres =
	| {
		readonly type: 'postgresql:ha@18'
		readonly profile?: 'oltp-staging' | 'oltp-production' | 'oltp-enterprise' | 'olap-production' | 'writeheavy-production'
	}
	| {
		readonly type: 'postgresql:single@18'
		readonly profile?: 'oltp-hobby' | 'oltp-staging' | 'oltp-production' | 'olap-production' | 'writeheavy-production'
	}

/**
 * Provider-owned namespace state. Optional fields are durable progress checkpoints; values that are
 * absent are resolved by `normalize()` before a mutation starts.
 */
export interface ZeropsNamespaceTarget {
	readonly proxySource?: ZeropsNamespaceProxySource
	readonly proxyBuild?: ZeropsNamespaceProxyBuild
	readonly proxyDeployment?: ZeropsNamespaceProxyDeployment
	readonly projectName?: string
	readonly corePackage?: ZeropsProjectMode
	readonly publicAccess?: ZeropsNamespacePublicAccess
	readonly proxyBuildFromGit?: string
	readonly postgres?: ZeropsNamespacePostgres
	readonly managed?: boolean
	readonly projectId?: string
	readonly proxyServiceId?: string
	readonly postgresServiceId?: string
	readonly proxyConfigured?: boolean
	readonly proxyBaselineSequence?: number
	readonly proxyAppVersionId?: string
	/** The hosts the published proxy answers on, recorded once so a namespace read needs no platform call. */
	readonly proxyHosts?: readonly ProviderNamespaceHost[]
	readonly ready?: boolean
}

export interface NormalizedZeropsNamespaceTarget extends ZeropsNamespaceTarget {
	readonly projectName: string
	readonly corePackage: ZeropsProjectMode
	readonly publicAccess: ZeropsNamespacePublicAccess
	readonly proxyBuildFromGit: string
	readonly managed: boolean
	readonly ready: boolean
}

export interface ZeropsNamespaceOptions {
	readonly proxySource?: ZeropsNamespaceProxySource
	readonly source?: ZeropsSourceClient
	readonly clientId: string
	readonly proxyBuildFromGit?: string
	/** Public IAM origin reachable from an app project. */
	readonly iamUrl: string
	/** Same credential IAM receives as `FABRIKA_IAM_PROXY_KEY`. */
	readonly iamKey: string
	readonly api: ZeropsApi
	readonly sleep?: Sleeper
}

export interface ZeropsNamespaceTopology {
	readonly source: ZeropsSourceTarget
	readonly createYaml: string
	readonly servicesProvisionYaml: string
	readonly servicesSteadyYaml: string
}

export interface ZeropsNamespacePresetInput {
	readonly proxySource?: ZeropsNamespaceProxySource
	readonly preset: 'cheap' | 'mid' | 'full'
	readonly env: string
	readonly projectName: string
	readonly corePackage?: ZeropsProjectMode
	readonly publicAccess?: ZeropsNamespacePublicAccess
	readonly proxyBuildFromGit?: string
	readonly postgres?: ZeropsNamespacePostgres
}

export interface ZeropsNamespaceOperatorOptions {
	readonly proxySource?: ZeropsNamespaceProxySource
	readonly proxyBuildFromGit?: string
}

export interface ZeropsNamespacePlanOptions {
	readonly projectName?: string
	readonly corePackage?: ZeropsProjectMode
	readonly publicAccess?: ZeropsNamespacePublicAccess
	readonly postgres?: ZeropsNamespacePostgres
}
