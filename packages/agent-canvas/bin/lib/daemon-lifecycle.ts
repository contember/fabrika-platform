import { createDaemonLifecycle, type DaemonEvent, DaemonStartError, ensureRuntimeDir } from '@fabrika/daemon-kit'
import { join } from 'path'
import { BASE_URL, CLI_AUTH_FILE, PACKAGE_ROOT, PID_FILE, TEMP_DIR, VERSION } from './config.ts'

interface CanvasHealth {
	pid: number
	version: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseHealth(body: unknown): CanvasHealth | undefined {
	if (!isRecord(body) || body.ok !== true || typeof body.version !== 'string') return undefined
	// Only the pid the daemon reports is signalled; a pid file in the runtime directory may name an unrelated process.
	if (typeof body.pid !== 'number') return undefined
	return { pid: body.pid, version: body.version }
}

function report(event: DaemonEvent) {
	if (event.type === 'version-mismatch') {
		console.error(`Daemon version mismatch (daemon: ${event.running}, CLI: ${VERSION}), restarting...`)
	}
	if (event.type === 'starting') console.error('Starting canvas daemon...')
	if (event.type === 'started') console.error('Daemon started.')
}

const lifecycle = createDaemonLifecycle<CanvasHealth>({
	baseUrl: BASE_URL,
	parseHealth,
	pidFile: PID_FILE,
	// The running Bun, not a PATH lookup — `Bun.spawn` throws on a missing executable.
	command: [process.execPath, 'run', join(PACKAGE_ROOT, 'daemon', 'src', 'server.ts')],
	cwd: join(PACKAGE_ROOT, 'daemon'),
	logFile: join(TEMP_DIR, 'daemon-startup.log'),
	versionCheck: { expected: VERSION, of: (health) => health.version },
	cleanupFiles: [CLI_AUTH_FILE],
	onEvent: report,
})

export async function isDaemonRunning(): Promise<boolean> {
	return lifecycle.isRunning()
}

function reportStartFailure(error: unknown): never {
	if (error instanceof DaemonStartError && error.logTail) {
		console.error('Daemon stderr:\n' + error.logTail)
	}
	console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
	process.exit(1)
}

/** The pid and log files of a daemon the CLI spawns go into the runtime directory, so it is made private first. */
function ensureTempDir(): void {
	try {
		ensureRuntimeDir(TEMP_DIR)
	} catch (error: unknown) {
		reportStartFailure(error)
	}
}

export async function startDaemon(): Promise<void> {
	ensureTempDir()
	await lifecycle.start().catch(reportStartFailure)
}

export async function ensureDaemon(): Promise<void> {
	ensureTempDir()
	await lifecycle.ensure().catch(reportStartFailure)
}

export async function stopDaemon(): Promise<boolean> {
	const result = await lifecycle.stop()
	if (result.reason === 'stopped') console.log('Daemon stopped.')
	else if (result.reason === 'stale-pid') console.log('Daemon was not running (stale PID file).')
	else if (result.reason === 'not-running') console.log('No daemon PID file found.')
	else console.log(result.message)
	return result.stopped
}
