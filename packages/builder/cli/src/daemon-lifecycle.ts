import { createDaemonLifecycle, type DaemonLifecycleConfig, DaemonStartError } from '@fabrika/daemon-kit'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { z } from 'zod'
import { healthInfoSchema } from '../../shared'
import { BASE_URL, DATA_DIR, PID_FILE, SESSIONS_DIR, TEMP_DIR } from './config'

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

const DAEMON_BIN = fileURLToPath(new URL('../../daemon/src/bin.ts', import.meta.url))

export const daemonLifecycleConfig: DaemonLifecycleConfig<DaemonHealthInfo> = {
	baseUrl: BASE_URL,
	parseHealth: parseDaemonHealth,
	pidFile: PID_FILE,
	command: [process.execPath, DAEMON_BIN, '--data-dir', DATA_DIR],
	// Never the caller's project: its bunfig.toml preloads must not load into the daemon.
	cwd: dirname(dirname(DAEMON_BIN)),
	logFile: join(TEMP_DIR, 'daemon.log'),
	// A daemon serving another data root is restarted, like one of another version.
	versionCheck: {
		expected: comparablePath(SESSIONS_DIR),
		of: (health) => comparablePath(health.sessionsDir),
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
				report(`daemon data-root mismatch: active ${event.running}, requested ${event.expected}; restarting the daemon.`)
			}
		},
	})
	try {
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
			const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' })
			child.on('error', () => console.error(`Open this URL in your browser: ${fallbackUrl}`))
			child.unref()
			return
		}
	}
	console.error(`Open this URL in your browser: ${fallbackUrl}`)
}
