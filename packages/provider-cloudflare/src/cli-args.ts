export interface ParsedCloudflareArgs {
	readonly command: string | undefined
	readonly subcommand: string | undefined
	readonly env: string | undefined
	readonly config: string
	readonly runnerConfig: string | undefined
	readonly workerConfig: string | undefined
	/** The single-component form of `platform deploy|plan`: deploy exactly this one platform config. */
	readonly componentConfig: string | undefined
	readonly managedVarNames: readonly string[]
	readonly dryRun: boolean
	readonly help: boolean
}

export const parseCloudflareArgs = (argv: readonly string[]): ParsedCloudflareArgs => {
	let command: string | undefined
	let subcommand: string | undefined
	let env: string | undefined
	let config = './fabrika.config.ts'
	let runnerConfig: string | undefined
	let workerConfig: string | undefined
	let componentConfig: string | undefined
	const managedVarNames: string[] = []
	let dryRun = false
	let help = false

	for (const arg of argv) {
		if (arg === '-h' || arg === '--help') {
			help = true
		} else if (arg === '--dry-run') {
			dryRun = true
		} else if (arg.startsWith('--env=')) {
			env = arg.slice('--env='.length)
		} else if (arg.startsWith('--config=')) {
			config = arg.slice('--config='.length)
		} else if (arg.startsWith('--runner-config=')) {
			runnerConfig = arg.slice('--runner-config='.length)
		} else if (arg.startsWith('--worker-config=')) {
			workerConfig = arg.slice('--worker-config='.length)
		} else if (arg.startsWith('--component-config=')) {
			componentConfig = arg.slice('--component-config='.length)
		} else if (arg.startsWith('--managed-var=')) {
			const name = arg.slice('--managed-var='.length)
			if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
				throw new Error('Invalid --managed-var name')
			}
			managedVarNames.push(name)
		} else if (!arg.startsWith('-')) {
			if (command === undefined) {
				command = arg
			} else if (subcommand === undefined) {
				subcommand = arg
			}
		}
	}

	return { command, subcommand, env, config, runnerConfig, workerConfig, componentConfig, managedVarNames, dryRun, help }
}

export interface PlatformComponent {
	readonly label: string
	readonly configPath: string
}

/** What `platformComponents` needs off a parsed command line. */
export type PlatformComponentSelection = Pick<ParsedCloudflareArgs, 'runnerConfig' | 'workerConfig' | 'componentConfig'>

/**
 * One config (`--component-config`) or the executor-then-control pair, never mixed. Both run with
 * `platformResources: 'allow'`, which is why the single form lives here and not on `app deploy`.
 */
export const platformComponents = (selection: PlatformComponentSelection): readonly PlatformComponent[] => {
	const { runnerConfig, workerConfig, componentConfig } = selection
	if (componentConfig !== undefined && componentConfig !== '') {
		if (runnerConfig !== undefined || workerConfig !== undefined) {
			throw new Error('`--component-config` deploys one component and cannot be combined with --runner-config/--worker-config')
		}
		return [{ label: componentConfig, configPath: componentConfig }]
	}
	if (runnerConfig === undefined || runnerConfig === '') {
		throw new Error('Missing --runner-config=<path> (or --component-config=<path>) for `platform deploy`')
	}
	if (workerConfig === undefined || workerConfig === '') {
		throw new Error('Missing --worker-config=<path> for `platform deploy`')
	}
	return [
		{ label: 'runner', configPath: runnerConfig },
		{ label: 'control', configPath: workerConfig },
	]
}
