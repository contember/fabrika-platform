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
export { type CommandEnv, describeArgument, readEnv, readFlag, requiredSetting, setting, shellWord } from './options'
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
	INITIAL_SCAFFOLD_COMMIT_MESSAGE,
	REFRESH_SCAFFOLD_COMMIT_MESSAGE,
	scaffoldSidecarRepository,
	type SidecarScaffoldEffects,
	type SidecarScaffoldInput,
	type SidecarScaffoldResult,
} from './scaffold'
export { attempt, capture, probe, run, type ShellAttempt, type ShellStep } from './shell'
