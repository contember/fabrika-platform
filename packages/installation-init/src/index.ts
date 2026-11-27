export {
	ADMIN_ROLE_KEY,
	createIamAdminClient,
	type EnrollmentOutcome,
	ensureFirstAdministrator,
	type FirstAdministratorApi,
	type FirstAdministratorRequest,
	type FirstAdministratorResult,
	type IamAdminClient,
	type IamAdminConnection,
} from './admin'
export {
	AUTH_METHODS_FLAG,
	type AuthMethods,
	checkedOidcIssuer,
	OIDC_CLIENT_ID_FLAG,
	OIDC_CLIENT_ID_INPUT,
	OIDC_CLIENT_SECRET_INPUT,
	OIDC_ISSUER_FLAG,
	OIDC_ISSUER_INPUT,
	type OidcClient,
	readAuthMethods,
	refuseFlags,
} from './auth-methods'
export { CHECKOUT_FLAG, sidecarCheckoutDir } from './checkout'
export { type Confirmations, confirmations, UNATTENDED_FLAG } from './confirmations'
export { EMAIL_FLAGS, type InstallationEmail, readInstallationEmail } from './email'
export {
	configureEnvironment,
	type EnvironmentConfig,
	type EnvironmentEffects,
	environmentVariables,
	type ExistingEnvironmentProtection,
	existingEnvironmentProtection,
	triggerPlatformWorkflow,
} from './environment'
export { ghRepoExists, hasGhCli } from './gh'
export { action, detail, fail, info, ok, step, url, warn } from './log'
export {
	type IamOAuthConfig,
	MCP_AUTHORING_VARIABLE,
	MCP_CLIENTS_VARIABLE,
	parseMcpAuthoring,
	platformIamOAuthConfig,
	refuseMcpClientsVariable,
} from './mcp'
export {
	type AddressOf,
	checkInstallationModel,
	checkProviderVariables,
	type ControlEntry,
	type GeneratedSecret,
	type ModelService,
	type ModelVariable,
	PLATFORM_HEALTH_PATH,
	PLATFORM_PROXY_HEALTH_PORT,
	PLATFORM_PROXY_PORT,
	PLATFORM_SERVICE_PORT,
	PLATFORM_SERVICES,
	type PlatformArtifact,
	type PlatformBucket,
	type PlatformDatabase,
	type PlatformInstallationModel,
	platformInstallationModel,
	type PlatformInstallationModelInput,
	privateAddress,
	type ScheduledJob,
	type ServicePort,
	staticEnvironment,
	type VariableCondition,
	variableKey,
} from './model'
export { type CommandEnv, describeArgument, readEnv, readFlag, requiredSetting, setting, shellWord } from './options'
export { assertPinnedTag } from './pin'
export { confirm } from './prompt'
export {
	branchProtectionCommand,
	DEPLOYMENT_BRANCH_POLICY,
	environmentPolicyCommand,
	environmentReviewerCommand,
	type GhAttempt,
	isPlanLimited,
	PLAN_LIMITED,
	probeSidecarBranchProtection,
	type ProtectionOutcome,
	protectSidecarBranch,
} from './protection'
export {
	type PlatformHosts,
	type PlatformOAuthApp,
	type PlatformOAuthResourceTemplate,
	platformOAuthResourceVerifiedBy,
	type PlatformOAuthScopeGrant,
	platformOAuthServed,
	type PlatformOAuthServedResource,
	platformOrigin,
	type PlatformProxyApp,
	platformProxyAppFor,
	type PlatformProxyComposition,
	type PlatformProxyManifest,
	type PlatformProxyManifestTemplate,
	type PlatformProxyPlacement,
	type PlatformProxyService,
	platformServiceTableDigest,
	resolvePlatformProxyManifest,
} from './proxy-manifest'
export {
	INITIAL_SCAFFOLD_COMMIT_MESSAGE,
	REFRESH_SCAFFOLD_COMMIT_MESSAGE,
	scaffoldSidecarRepository,
	type SidecarScaffoldEffects,
	type SidecarScaffoldInput,
	type SidecarScaffoldResult,
} from './scaffold'
export { generateInstallationSecrets, generateSigningKeys, generateVaultKey, type InstallationSecrets, randomPxKey, randomSecret } from './secrets'
export { checkedSecretsFilePath, renderSecretsFile, SECRETS_FILE_FLAG, SECRETS_FILE_VARIABLE, writeSecretsFile } from './secrets-file'
export {
	deployedServiceEnvironment,
	type DeployedServiceInput,
	deriveIamProxySecret,
	IAM_OAUTH_CONFIG_VARIABLE,
	IAM_OIDC_CLIENT_SECRET_VARIABLE,
	INSTALLATION_SECRET_VARIABLES,
	type InstallationAuthentication,
	installationServiceEnvironment,
	type InstallationServiceInput,
	OPERATIONS_OAUTH_RESOURCE_VARIABLE,
	type PlatformData,
	type PlatformPlacementInput,
	type PlatformService,
	type PlatformServiceEnvironment,
	type PlatformStorage,
} from './service-environment'
export { attempt, capture, probe, run, type ShellAttempt, type ShellStep } from './shell'
