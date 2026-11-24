import {
	createDaemonLifecycle,
	type DaemonLifecycleConfig,
	DaemonStartError,
	ensureRuntimeDir,
	openerAllowed,
	openLinkThroughFile,
} from '@fabrika/daemon-kit'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { z } from 'zod'
import { healthInfoSchema } from '../../shared'
import { BASE_URL, CLI_AUTH_FILE, DATA_DIR, PID_FILE, SESSIONS_DIR, TEMP_DIR } from './config'

export type DaemonHealthInfo = z.output<typeof healthInfoSchema> & { pid: number }

function parseDaemonHealth(body: unknown): DaemonHealthInfo | undefined {
	const result = healthInfoSchema.safeParse(body)
	if (!result.success) return undefined
	const { pid } = result.data
	return pid !== undefined && Number.isInteger(pid) ? { ...result.data, pid } : undefined
}

function comparablePath(path: string): string {
	const absolute = resolve(path)
	return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

export function healthMatchesDataRoot(info: { sessionsDir: string }, expectedSessionsDir: string = SESSIONS_DIR): boolean {
	return comparablePath(info.sessionsDir) === comparablePath(expectedSessionsDir)
}

function daemonIdentity(sessionsDir: string, cliAuthFile: string | undefined): string {
	return `${comparablePath(sessionsDir)} (capability ${cliAuthFile === undefined ? 'not named' : comparablePath(cliAuthFile)})`
}

const DAEMON_BIN = fileURLToPath(new URL('../../daemon/src/bin.ts', import.meta.url))

export const daemonLifecycleConfig: DaemonLifecycleConfig<DaemonHealthInfo> = {
	baseUrl: BASE_URL,
	parseHealth: parseDaemonHealth,
	pidFile: PID_FILE,
	cleanupFiles: [CLI_AUTH_FILE],
	command: [process.execPath, DAEMON_BIN, '--data-dir', DATA_DIR],
	// Never the caller's project: its bunfig.toml preloads must not load into the daemon.
	cwd: dirname(dirname(DAEMON_BIN)),
	logFile: join(TEMP_DIR, 'daemon.log'),
	// A daemon serving another data root, or writing its capability where this CLI does not read it (a release before the
	// runtime directory, another XDG_RUNTIME_DIR), is restarted, like one of another version.
	versionCheck: {
		expected: daemonIdentity(SESSIONS_DIR, CLI_AUTH_FILE),
		of: (health) => daemonIdentity(health.sessionsDir, health.cliAuthFile),
	},
}

export const daemon = createDaemonLifecycle(daemonLifecycleConfig)

export async function ensureDaemon(opts: { quiet?: boolean } = {}): Promise<boolean> {
	const report = (message: string) => {
		if (!opts.quiet) console.error(`[fabrika] ${message}`)
	}
	const lifecycle = createDaemonLifecycle({
		...daemonLifecycleConfig,
		onEvent: (event) => {
			if (event.type === 'version-mismatch') {
				report(`daemon data-root or capability mismatch: active ${event.running}, requested ${event.expected}; restarting the daemon.`)
			}
		},
	})
	try {
		// The pid and log files of a daemon the CLI spawns go into the runtime directory, so it is made private first.
		ensureRuntimeDir(TEMP_DIR)
		const health = await lifecycle.ensure()
		if (healthMatchesDataRoot(health)) return true
		report(`daemon data-root mismatch: active ${health.sessionsDir}, requested ${SESSIONS_DIR}`)
		return false
	} catch (error: unknown) {
		if (error instanceof DaemonStartError) {
			report(error.logTail ? `${error.message}\nDaemon log (${error.logFile}):\n${error.logTail}` : error.message)
		} else {
			report(error instanceof Error ? error.message : String(error))
		}
		return false
	}
}

export async function isDaemonRunning(): Promise<boolean> {
	const health = await daemon.health()
	return health.status === 'up' && healthMatchesDataRoot(health)
}

export function openBrowser(url: string, fallbackUrl: string = url): void {
	const candidates = process.platform === 'darwin'
		? ['open']
		: ['xdg-open', 'wslview', 'sensible-browser']
	for (const cmd of candidates) {
		const which = Bun.spawnSync(['which', cmd])
		if (which.exitCode === 0) {
			// Under a test run only the test's own fake opener runs, never the user's real browser.
			if (!openerAllowed(which.stdout.toString())) break
			const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' })
			child.on('error', () => console.error(`Open this URL in your browser: ${fallbackUrl}`))
			child.unref()
			return
		}
	}
	console.error(`Open this URL in your browser: ${fallbackUrl}`)
}

/** Opens a sign-in link to the dashboard through a file only its owner reads: a process argument would show its code. */
export function openDashboardLink(link: string): void {
	openLinkThroughFile(link, TEMP_DIR, 'Fabrika builder', (url) => openBrowser(url))
}
