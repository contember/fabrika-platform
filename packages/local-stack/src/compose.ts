import { COMPOSE_FILE, REPO_ROOT } from './prepare'

export const BROWSER_COMPOSE_FILE = `${import.meta.dir}/../compose.browser.yaml`

export interface ComposeOptions {
	browser?: boolean
	showOutput?: boolean
	env?: Record<string, string>
}

const composeCommand = (args: string[], browser: boolean): string[] => [
	'docker',
	'compose',
	'--project-name',
	'fabrika-local',
	'--file',
	COMPOSE_FILE,
	...(browser ? ['--file', BROWSER_COMPOSE_FILE] : []),
	...args,
]

export async function compose(args: string[], options: ComposeOptions = {}): Promise<void> {
	const showOutput = options.showOutput ?? true
	const child = Bun.spawn(composeCommand(args, options.browser ?? false), {
		cwd: REPO_ROOT,
		...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
		stdout: showOutput ? 'inherit' : 'ignore',
		stderr: showOutput ? 'inherit' : 'ignore',
		stdin: 'ignore',
	})
	const exitCode = await child.exited
	if (exitCode !== 0) {
		throw new Error(`docker compose failed with exit code ${exitCode}`)
	}
}

export async function composeOutput(args: string[], options: Pick<ComposeOptions, 'browser'> = {}): Promise<string> {
	const child = Bun.spawn(composeCommand(args, options.browser ?? false), {
		cwd: REPO_ROOT,
		stdout: 'pipe',
		stderr: 'ignore',
		stdin: 'ignore',
	})
	const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
	if (exitCode !== 0) {
		throw new Error('docker compose inspection command failed')
	}
	return output
}
