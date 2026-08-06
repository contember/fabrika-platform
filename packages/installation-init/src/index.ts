export { configureEnvironment, type EnvironmentConfig, triggerPlatformWorkflow } from './environment'
export { ghRepoExists, hasGhCli } from './gh'
export { action, detail, fail, info, ok, step, url, warn } from './log'
export { confirm, required, retry, secret, secretOrEnv, select, text } from './prompt'
export {
	INITIAL_SCAFFOLD_COMMIT_MESSAGE,
	REFRESH_SCAFFOLD_COMMIT_MESSAGE,
	scaffoldSidecarRepository,
	type SidecarScaffoldInput,
	type SidecarScaffoldResult,
} from './scaffold'
export { capture, probe, run, type ShellStep } from './shell'
