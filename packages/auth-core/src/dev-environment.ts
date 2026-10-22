// What the platform's build hands the launcher of a `dev` environment: a generated file beside the generated entrypoint.
// The provider writes it, the application's own framework release reads it (ADR-0062: protocol, changed additively).

/** Relative to the application root. The build writes it after the checks, so no authored file can stand in for it. */
export const DEV_LAUNCHER_CONFIG_FILE = 'fabrika/dev.generated.json'

/**
 * The module whose `runDevLauncher(process.env)` a `dev` environment's `run.start` calls instead of the serving entry.
 * No file is generated for it: the checker allows `process.env` in the generated serving entry only.
 */
export const DEV_LAUNCHER_MODULE = '@fabrika/app/dev'

/** Where the launcher records what it holds, so a restart of the same container resumes it. A new container has none. */
export const DEV_LAUNCHER_STATE_FILE = 'fabrika/dev-state.json'

/** One command of the build's check chain, run by the shell in the application root. */
export interface DevLauncherCheck {
	readonly name: string
	readonly command: string
}

export interface DevLauncherConfig {
	readonly format: 1
	readonly appId: string
	/** The commit the bootstrap run built: what a new container holds before its first sync. */
	readonly head: string
	/** The port the serving entry listens on (`PORT`). */
	readonly port: number
	/** The contract's health endpoint, which says when a respawned application serves. */
	readonly healthPath: string
	/** The serving entry, as an argument vector run in the application root. */
	readonly serve: readonly string[]
	/** `fabrika db migrate`, as an argument vector; it runs only with the provisioning credential. */
	readonly migrate: readonly string[]
	/** The authored SPA commands of the build, each run by the shell when a web source changed. */
	readonly spaBuild: readonly string[]
	/** The build's check chain, which `run_checks` asks for. */
	readonly checks: readonly DevLauncherCheck[]
}
