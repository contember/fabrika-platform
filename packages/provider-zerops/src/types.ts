import type { AppGates } from '@fabrika/auth-core'
import type { AppConfigBase } from '@fabrika/provider-contract'
import type { ZeropsImportProject, ZeropsImportService } from './schema.generated'

export interface ZeropsResourceContext {
	env: string
	domain?: string
}

export type ZeropsCompilerOwnedServiceField =
	| 'envIsolation'
	| 'override'
	| 'envSecrets'
	| 'dotEnvSecrets'
	| 'mode'
	| 'os'

export type ZeropsCompilerOwnedProjectField = 'envVariables' | 'envIsolation'

export type ZeropsServiceSpec = Omit<ZeropsImportService, ZeropsCompilerOwnedServiceField>

export type ZeropsProjectSpec = Omit<ZeropsImportProject, ZeropsCompilerOwnedProjectField>

export interface ZeropsProxySpec {
	upstream: string
	gates: AppGates
}

/** A typed reference to the namespace-owned PostgreSQL service; it never contains its credential. */
export interface ZeropsSharedPostgresBinding {
	readonly resourceKey: 'service:postgres'
	readonly hostname: 'postgres'
	readonly connectionString: '${postgres_connectionString}'
}

export type ZeropsNamespaceResourceRequirement = ZeropsSharedPostgresBinding

export interface ZeropsSourceTarget {
	platform: 'zerops'
	deployService?: string
	zeropsSetup?: string
	proxy?: ZeropsProxySpec
	namespaceResources?: ZeropsNamespaceResourceRequirement[]
	services: (ctx: ZeropsResourceContext) => ZeropsServiceSpec[]
	project?: ZeropsProjectSpec
}

export interface ZeropsAppConfig extends AppConfigBase {
	target: ZeropsSourceTarget
}

/** Ephemeral runtime coordinates. This value is encoded only after credentials are composed. */
export interface ZeropsRuntimeTarget {
	projectId: string
	serviceId: string
	accessToken: string
	buildFromGit?: string
	apiBaseUrl?: string
	propustkaUrl?: string
	adminKey?: string
}
