import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join, resolve } from 'path'

export const DAEMON_PORT = parseInt(process.env['FABRIKA_PORT'] || '19410', 10)
export const BASE_URL = `http://localhost:${DAEMON_PORT}`
export const WS_URL = `ws://localhost:${DAEMON_PORT}`

export const TIMEOUT_MS = parseInt(process.env['FABRIKA_TIMEOUT'] || String(60 * 60 * 1000), 10)

export const LEGACY_DATA_DIR = join(homedir(), '.claude', 'fabrika')
export const NEUTRAL_DATA_DIR = join(homedir(), '.fabrika')
export const DATA_DIR = resolveDataDir()
export const SESSIONS_DIR = join(DATA_DIR, 'sessions')
export const TEMP_DIR = join(tmpdir(), 'fabrika')
export const PID_FILE = join(TEMP_DIR, 'daemon.pid')

export const FABRIKA_DIRNAME = '.fabrika'

export function resolveDataDir(opts: {
	home?: string
	explicit?: string
	exists?: (path: string) => boolean
} = {}): string {
	const home = opts.home ?? homedir()
	const explicit = opts.explicit ?? process.env['FABRIKA_DATA_DIR']
	if (explicit) return resolve(explicit)
	const neutral = join(home, '.fabrika')
	const legacy = join(home, '.claude', 'fabrika')
	const exists = opts.exists ?? existsSync
	if (exists(neutral)) return neutral
	if (exists(legacy)) return legacy
	return neutral
}

export function getSessionId(explicit?: string, recorded?: string, repoRoot?: string): string {
	if (explicit) return explicit
	if (process.env['FABRIKA_SESSION_ID']) return process.env['FABRIKA_SESSION_ID']
	if (recorded) return recorded
	return hashRepoPath(repoRoot ?? process.cwd())
}

export function hashRepoPath(repoRoot: string): string {
	const abs = resolve(repoRoot)
	return 's_' + createHash('sha256').update(abs).digest('hex').slice(0, 16)
}
