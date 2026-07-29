export interface ZeropsCliArgs {
	command: string | undefined
	env: string | undefined
	config: string
	output: string
	help: boolean
}

export const parseZeropsCliArgs = (argv: string[]): ZeropsCliArgs => {
	let command: string | undefined
	let env: string | undefined
	let config = './fabrika.config.ts'
	let output = './fabrika.manifest.json'
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
		} else if (arg.startsWith('-')) {
			throw new Error(`Unknown option: ${arg}`)
		} else if (command === undefined) {
			command = arg
		} else {
			throw new Error(`Unexpected argument: ${arg}`)
		}
	}

	return { command, env, config, output, help }
}
