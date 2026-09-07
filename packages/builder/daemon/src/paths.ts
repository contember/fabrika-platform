import { createCanvasPaths } from '@fabrika/canvas-kernel/server'
import { existsSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join, resolve } from 'path'

export const NEUTRAL_DATA_DIR = join(homedir(), '.fabrika')
export const LEGACY_DATA_DIR = join(homedir(), '.claude', 'fabrika')

export function resolveDataDir(): string {
	const explicit = process.env['FABRIKA_DATA_DIR']
	if (explicit) return resolve(explicit)
	if (existsSync(NEUTRAL_DATA_DIR)) return NEUTRAL_DATA_DIR
	if (existsSync(LEGACY_DATA_DIR)) return LEGACY_DATA_DIR
	return NEUTRAL_DATA_DIR
}

export const paths = createCanvasPaths({
	appName: 'fabrika',
	dataDir: resolveDataDir(),
	tempDir: join(tmpdir(), 'fabrika'),
})

export const DATA_DIR = paths.dataDir
export const SESSIONS_DIR = paths.sessionsDir
export const TEMP_DIR = paths.tempDir
export const PID_FILE = paths.pidFile
export const COMPILE_TEMP_DIR = paths.compileTempDir
export const UPLOADS_DIR = paths.uploadsDir

export const DEFAULT_PORT = parseInt(process.env['FABRIKA_PORT'] || '19410', 10)
