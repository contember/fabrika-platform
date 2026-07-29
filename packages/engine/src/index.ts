// @fabrika/engine — the deploy engine + types that the CLI, control-plane worker, and runner all
// share. The engine executes a plan; the target's `DeployDriver` decides what the plan IS (ADR-0002),
// and the target's `platform` discriminant decides WHICH driver that is (ADR-0009).

export { deploy, type DeployOptions } from './deploy'
export { CANCELLED, type DeployDriver, type DeploySession, type DriverRegistry, type DriverRun } from './driver'
export { defaultDrivers } from './drivers'
export { cloudflareDriver, createCloudflareDriver } from './drivers/cloudflare'
export {
	type CloudflareCollaborators,
	type CommandResult,
	type CommandRunner,
	type CommandSpec,
	defaultCloudflareCollaborators,
	type OblakaProvisioner,
	type ProvisionInput,
	type SchemaReconciler,
} from './drivers/cloudflare/collaborators'
export { buildPlan, findMigratableDatabases } from './drivers/cloudflare/plan'
export type { CloudflareJobSpec, CloudflarePlan, CloudflareStepKind, MigratableDatabase } from './drivers/cloudflare/plan'
export { defaultReconcileSchema } from './drivers/shared/schema'
export { createZeropsDriver, zeropsDriver } from './drivers/zerops'
export { asAppVersionStatus, createZeropsApi, ZEROPS_ACTIVE, ZEROPS_API_BASE, ZEROPS_TERMINAL } from './drivers/zerops/api'
export type {
	FetchLike,
	ZeropsApi,
	ZeropsApiOptions,
	ZeropsAppVersion,
	ZeropsAppVersionStatus,
	ZeropsImportedService,
	ZeropsImportResult,
	ZeropsLogAccess,
	ZeropsLogLine,
	ZeropsProcess,
	ZeropsProject,
	ZeropsService,
	ZeropsServiceEnv,
} from './drivers/zerops/api'
export { defaultSleep, defaultZeropsCollaborators } from './drivers/zerops/collaborators'
export type { Sleeper, ZeropsCollaboratorFactory, ZeropsCollaborators } from './drivers/zerops/collaborators'
export {
	assertZeropsInvariants,
	compileImport,
	compileImportYaml,
	compileProvisioningYaml,
	ENV_ISOLATION,
	renderImportYaml,
	renderYaml,
} from './drivers/zerops/compile'
export type { CompileInput, ZeropsImportDocument } from './drivers/zerops/compile'
export { buildZeropsPlan, resolveDeployHostname } from './drivers/zerops/plan'
export type { ZeropsJobSpec, ZeropsPlan, ZeropsStepKind } from './drivers/zerops/plan'
export { compileFabrikaManifest, configFromManifest, FABRIKA_MANIFEST_VERSION, parseFabrikaManifest } from './manifest'
export type { FabrikaManifestV1, ManifestExpectation } from './manifest'
export type {
	AnyAppConfig,
	AppConfig,
	CloudflareTarget,
	DeployContext,
	DeployPlan,
	DeployResult,
	DeployStep,
	DeployTarget,
	DeployTargets,
	JobSpec,
	PlatformId,
	RunStatus,
	SecretRef,
	SecretScope,
	ZeropsTarget,
} from './types'
