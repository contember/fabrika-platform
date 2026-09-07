import { spawn } from 'child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { DATA_DIR, PID_FILE, SESSIONS_DIR, TEMP_DIR } from './config'
import { health, type HealthInfo, healthMatchesDataRoot, isDaemonRunning } from './daemon-client'

const HERE = dirname(fileURLToPath(import.meta.url))

export function resolveDaemonServer(): string | null {
	const candidates = [
		resolve(HERE, '../../daemon/src/bin.ts'),
	]
	for (const c of candidates) {
		if (existsSync(c)) return c
	}
	return null
}

export class DaemonUnavailableError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'DaemonUnavailableError'
	}
}

export async function startDaemon(): Promise<void> {
	const server = resolveDaemonServer()
	if (!server) {
		throw new DaemonUnavailableError(
			'fabrika builder daemon not found. '
				+ 'Build/start it manually, or run the CLI in offline mode.',
		)
	}

	mkdirSync(TEMP_DIR, { recursive: true })
	const startupLog = join(TEMP_DIR, 'daemon-startup.log')
	const fd = openSync(startupLog, 'w')

	const child = spawn('bun', ['run', server], {
		detached: true,
		stdio: ['ignore', 'ignore', fd],
		cwd: dirname(dirname(server)),
		env: daemonSpawnEnvironment(),
	})
	child.unref()
	closeSync(fd)

	for (let i = 0; i < 30; i++) {
		await new Promise((r) => setTimeout(r, 100))
		if (await isDaemonRunning()) return
	}

	let detail = ''
	if (existsSync(startupLog)) {
		const log = readFileSync(startupLog, 'utf-8').trim()
		if (log) detail = '\nDaemon stderr:\n' + log
	}
	throw new DaemonUnavailableError('Daemon failed to start within 3 seconds.' + detail)
}

export function daemonSpawnEnvironment(
	base: NodeJS.ProcessEnv = process.env,
	dataDir: string = DATA_DIR,
): NodeJS.ProcessEnv {
	return { ...base, FABRIKA_DATA_DIR: resolve(dataDir) }
}

export async function ensureDaemon(opts: { quiet?: boolean } = {}): Promise<boolean> {
	const active = await health()
	if (active && healthMatchesDataRoot(active)) return true

	if (active) {
		const stopped = await stopMismatchedManagedDaemon(active, opts.quiet ?? false)
		if (!stopped) return false
	}

	if (existsSync(PID_FILE)) {
		const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10)
		if (!isAlive(pid)) {
			try {
				unlinkSync(PID_FILE)
			} catch {}
		}
	}

	try {
		await startDaemon()
		return true
	} catch (error: unknown) {
		if (!opts.quiet) {
			console.error(`[fabrika] ${error instanceof Error ? error.message : String(error)}`)
		}
		return false
	}
}

async function stopMismatchedManagedDaemon(info: HealthInfo, quiet: boolean): Promise<boolean> {
	const actual = info.sessionsDir ?? '<not reported by legacy daemon>'
	const mismatch = `daemon data-root mismatch: active ${actual}, requested ${SESSIONS_DIR}`
	if (!existsSync(PID_FILE)) {
		if (!quiet) console.error(`[fabrika] ${mismatch}; no managed PID file, refusing to stop it.`)
		return false
	}

	const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10)
	if (!isAlive(pid) || info.pid === undefined || info.pid !== pid) {
		if (!quiet) console.error(`[fabrika] ${mismatch}; daemon PID ownership could not be verified.`)
		return false
	}

	if (!quiet) console.error(`[fabrika] ${mismatch}; restarting managed daemon ${pid}.`)
	try {
		process.kill(pid, 'SIGTERM')
	} catch {
		return false
	}

	for (let attempt = 0; attempt < 30; attempt++) {
		await new Promise((resolveP) => setTimeout(resolveP, 100))
		if ((await health()) === null) {
			try {
				unlinkSync(PID_FILE)
			} catch {}
			return true
		}
	}
	if (!quiet) console.error(`[fabrika] mismatched daemon did not stop within 3 seconds.`)
	return false
}

export function stopDaemon(): boolean {
	if (!existsSync(PID_FILE)) return false
	const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10)
	try {
		process.kill(pid, 'SIGTERM')
		try {
			unlinkSync(PID_FILE)
		} catch {}
		return true
	} catch {
		try {
			unlinkSync(PID_FILE)
		} catch {}
		return false
	}
}

function isAlive(pid: number): boolean {
	if (!Number.isFinite(pid) || pid <= 0) return false
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

export function openBrowser(url: string): void {
	const candidates = process.platform === 'darwin'
		? ['open']
		: ['xdg-open', 'wslview', 'sensible-browser']
	for (const cmd of candidates) {
		const which = Bun.spawnSync(['which', cmd])
		if (which.exitCode === 0) {
			spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref()
			return
		}
	}
	console.error(`Open this URL in your browser: ${url}`)
}
