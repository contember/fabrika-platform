export interface ParsedCloudflareArgs {
	readonly command: string | undefined
	readonly subcommand: string | undefined
	readonly env: string | undefined
	readonly config: string
	readonly runnerConfig: string | undefined
	readonly workerConfig: string | undefined
	readonly managedVarNames: readonly string[]
	readonly buildRunnerImage: boolean
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
	const managedVarNames: string[] = []
	let buildRunnerImage = false
	let dryRun = false
	let help = false

	for (const arg of argv) {
		if (arg === '-h' || arg === '--help') {
			help = true
		} else if (arg === '--dry-run') {
			dryRun = true
		} else if (arg === '--build-runner-image') {
			buildRunnerImage = true
		} else if (arg.startsWith('--env=')) {
			env = arg.slice('--env='.length)
		} else if (arg.startsWith('--config=')) {
			config = arg.slice('--config='.length)
		} else if (arg.startsWith('--runner-config=')) {
			runnerConfig = arg.slice('--runner-config='.length)
		} else if (arg.startsWith('--worker-config=')) {
			workerConfig = arg.slice('--worker-config='.length)
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

	return { command, subcommand, env, config, runnerConfig, workerConfig, managedVarNames, buildRunnerImage, dryRun, help }
}

export interface PlatformComponent {
	readonly label: string
	readonly configPath: string
}

/** The executor must exist before the control plane binds to it. */
export const platformComponents = (runnerConfig: string | undefined, workerConfig: string | undefined): readonly PlatformComponent[] => {
	if (runnerConfig === undefined || runnerConfig === '') {
		throw new Error('Missing --runner-config=<path> for `platform deploy`')
	}
	if (workerConfig === undefined || workerConfig === '') {
		throw new Error('Missing --worker-config=<path> for `platform deploy`')
	}
	return [
		{ label: 'vozka-runner', configPath: runnerConfig },
		{ label: 'vozka', configPath: workerConfig },
	]
}
