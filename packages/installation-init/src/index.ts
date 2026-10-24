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
export { CHECKOUT_FLAG, sidecarCheckoutDir } from './checkout'
export { type Confirmations, confirmations, UNATTENDED_FLAG } from './confirmations'
export { EMAIL_FLAGS, type InstallationEmail, readInstallationEmail } from './email'
export {
	configureEnvironment,
	type EnvironmentConfig,
	type EnvironmentEffects,
	type ExistingEnvironmentProtection,
	existingEnvironmentProtection,
	triggerPlatformWorkflow,
} from './environment'
export { ghRepoExists, hasGhCli } from './gh'
export { action, detail, fail, info, ok, step, url, warn } from './log'
export { type IamOAuthConfig, type McpClient, parseMcpClientsJson, platformIamOAuthConfig } from './mcp'
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
	type PlatformOAuthResourceTemplate,
	type PlatformOAuthScopeGrant,
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
	INSTALLATION_SECRET_VARIABLES,
	installationServiceEnvironment,
	type InstallationServiceInput,
	type PlatformData,
	type PlatformPlacementInput,
	type PlatformService,
	type PlatformServiceEnvironment,
	type PlatformStorage,
} from './service-environment'
export { attempt, capture, probe, run, type ShellAttempt, type ShellStep } from './shell'
