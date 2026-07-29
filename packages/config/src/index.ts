// @fabrika/config — the single app-authoring surface. An app imports ONLY from here: it gets
// `defineApp` + its config types, every oblaka resource primitive (Worker, D1Database,
// KVNamespace, R2Bucket, Queue, DurableObject, Container, ServiceReference, define, …), and the
// propustka authz-vocabulary declaration types — so a `fabrika.config.ts` never imports `oblaka-iac` or
// `@fabrika/auth-core` directly.

export { defineApp } from './defineApp'
export { appPlatform, appTarget } from './target'
export type {
	AnyAppConfig,
	AppConfig,
	AppConfigBase,
	AppConfigs,
	AppPipeline,
	AppTarget,
	CloudflareAppConfig,
	CloudflareAppTarget,
	ResourceContext,
	ZeropsAppConfig,
	ZeropsCompiledAppConfig,
	ZeropsRuntimeConfig,
} from './types'

// The ZEROPS authoring surface: what an app may declare (`./zerops/types`) plus the full generated
// platform contract it is carved out of (`./zerops/schema.generated`), which the deploy driver's
// import-YAML compiler needs in full.
export type * from './zerops/schema.generated'
export type {
	ZeropsAppTarget,
	ZeropsCompiledTarget,
	ZeropsCompilerOwnedProjectField,
	ZeropsCompilerOwnedServiceField,
	ZeropsProjectSpec,
	ZeropsProxySpec,
	ZeropsServiceSpec,
	ZeropsSourceTarget,
} from './zerops/types'

// Re-export oblaka's resource primitives so apps author their resource graph from this package.
export * from 'oblaka-iac'

// Re-export the propustka declaration types apps need to author the schema and proxy gates.
export type { AppActionDef, AppGates, AppSchema, AppScopeDef, CredentialLocation, GateKind, GateRule, RoleDef } from '@fabrika/auth-core'
