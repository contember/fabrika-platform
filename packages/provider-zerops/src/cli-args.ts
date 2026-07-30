export interface ZeropsCliArgs {
	command: string | undefined
	subcommand: string | undefined
	env: string | undefined
	config: string
	output: string
	namespaceId: string | undefined
	preset: string | undefined
	exclusiveAppId: string | undefined
	projectId: string | undefined
	projectName: string | undefined
	corePackage: string | undefined
	publicAccess: string | undefined
	postgresType: string | undefined
	postgresProfile: string | undefined
	proxyBuildFromGit: string | undefined
	controlUrl: string | undefined
	help: boolean
}

export const parseZeropsCliArgs = (argv: readonly string[]): ZeropsCliArgs => {
	let command: string | undefined
	let subcommand: string | undefined
	let env: string | undefined
	let config = './fabrika.config.ts'
	let output = './fabrika.manifest.json'
	let namespaceId: string | undefined
	let preset: string | undefined
	let exclusiveAppId: string | undefined
	let projectId: string | undefined
	let projectName: string | undefined
	let corePackage: string | undefined
	let publicAccess: string | undefined
	let postgresType: string | undefined
	let postgresProfile: string | undefined
	let proxyBuildFromGit: string | undefined
	let controlUrl: string | undefined
	let help = false

	for (const arg of argv) {
		if (arg === '-h' || arg === '--help') {
			help = true
		} else if (arg.startsWith('--env=')) {
			env = arg.slice('--env='.length)
		} else if (arg.startsWith('--config=')) {
			config = arg.slice('--config='.length)
		} else if (arg.startsWith('--output=')) {
			output = arg.slice('--output='.length)
		} else if (arg.startsWith('--id=')) {
			namespaceId = arg.slice('--id='.length)
		} else if (arg.startsWith('--preset=')) {
			preset = arg.slice('--preset='.length)
		} else if (arg.startsWith('--exclusive-app=')) {
			exclusiveAppId = arg.slice('--exclusive-app='.length)
		} else if (arg.startsWith('--project-id=')) {
			projectId = arg.slice('--project-id='.length)
		} else if (arg.startsWith('--project-name=')) {
			projectName = arg.slice('--project-name='.length)
		} else if (arg.startsWith('--core-package=')) {
			corePackage = arg.slice('--core-package='.length)
		} else if (arg.startsWith('--public-access=')) {
			publicAccess = arg.slice('--public-access='.length)
		} else if (arg.startsWith('--postgres-type=')) {
			postgresType = arg.slice('--postgres-type='.length)
		} else if (arg.startsWith('--postgres-profile=')) {
			postgresProfile = arg.slice('--postgres-profile='.length)
		} else if (arg.startsWith('--proxy-build-from-git=')) {
			proxyBuildFromGit = arg.slice('--proxy-build-from-git='.length)
		} else if (arg.startsWith('--control-url=')) {
			controlUrl = arg.slice('--control-url='.length)
		} else if (arg.startsWith('-')) {
			throw new Error(`Unknown option: ${arg}`)
		} else if (command === undefined) {
			command = arg
		} else if (subcommand === undefined && command === 'namespace') {
			subcommand = arg
		} else {
			throw new Error(`Unexpected argument: ${arg}`)
		}
	}

	return {
		command,
		subcommand,
		env,
		config,
		output,
		namespaceId,
		preset,
		exclusiveAppId,
		projectId,
		projectName,
		corePackage,
		publicAccess,
		postgresType,
		postgresProfile,
		proxyBuildFromGit,
		controlUrl,
		help,
	}
}
