import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { localComposeEnv } from './ports'
import { COMPOSE_FILE, REPO_ROOT, STATE_DIR } from './prepare'

/**
 * The compose project of one checkout: its volumes, networks and containers carry this prefix, so a second worktree's
 * `local:up` starts from its own empty volumes instead of meeting another worktree's credentials. The path hash keeps two
 * checkouts with one directory name apart.
 */
export function composeProjectName(repoRoot: string): string {
	const name = basename(repoRoot).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
	const hash = createHash('sha256').update(repoRoot).digest('hex').slice(0, 8)
	return `fabrika-local-${name === '' ? 'root' : name}-${hash}`
}

export const COMPOSE_PROJECT = composeProjectName(REPO_ROOT)

export const BROWSER_COMPOSE_FILE = `${import.meta.dir}/../compose.browser.yaml`
/**
 * The browser stack's seeded Operations source, which `compose.browser.yaml` interpolates into Notes. Read by every
 * browser compose call, so a later recreate of Notes (following a deploy) keeps reporting there.
 */
export const BROWSER_COMPOSE_ENV = 'browser-compose.env'

export interface ComposeOptions {
	browser?: boolean
	showOutput?: boolean
	env?: Record<string, string>
}

const composeCommand = (args: string[], browser: boolean): string[] => [
	'docker',
	'compose',
	'--project-name',
	COMPOSE_PROJECT,
	'--file',
	COMPOSE_FILE,
	...(browser ? ['--file', BROWSER_COMPOSE_FILE, ...browserEnvFile()] : []),
	...args,
]

function browserEnvFile(): string[] {
	const path = resolve(STATE_DIR, BROWSER_COMPOSE_ENV)
	return existsSync(path) ? ['--env-file', path] : []
}

/** The environment of a compose call: `compose.yaml` interpolates this checkout's ports (`ports.ts`). */
export const composeEnv = (extra: Record<string, string> = {}): Record<string, string | undefined> => ({
	...process.env,
	...localComposeEnv(),
	...extra,
})

export async function compose(args: string[], options: ComposeOptions = {}): Promise<void> {
	const showOutput = options.showOutput ?? true
	const child = Bun.spawn(composeCommand(args, options.browser ?? false), {
		cwd: REPO_ROOT,
		env: composeEnv(options.env),
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
		env: composeEnv(),
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
