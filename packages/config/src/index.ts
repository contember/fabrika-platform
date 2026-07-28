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
} from './types'

// The ZEROPS authoring surface: what an app may declare (`./zerops/types`) plus the full generated
// platform contract it is carved out of (`./zerops/schema.generated`), which the deploy driver's
// import-YAML compiler needs in full.
export type * from './zerops/schema.generated'
export type {
	ZeropsAppTarget,
	ZeropsCompilerOwnedProjectField,
	ZeropsCompilerOwnedServiceField,
	ZeropsProjectSpec,
	ZeropsServiceSpec,
} from './zerops/types'

// Re-export oblaka's resource primitives so apps author their resource graph from this package.
export * from 'oblaka-iac'

// Re-export the propustka declaration types apps need to author `schema` (authz vocabulary).
// Per-path gates (CF Access's native successor) are pure runtime SDK config in each app, NOT a fabrika
// deploy concern, so they are not re-exported here.
export type { AppActionDef, AppSchema, AppScopeDef, RoleDef } from '@fabrika/auth-core'
