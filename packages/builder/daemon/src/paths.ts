import { createCanvasPaths } from '@fabrika/canvas-kernel/server'
import { homedir, tmpdir } from 'os'
import { join, resolve } from 'path'

export const NEUTRAL_DATA_DIR = join(homedir(), '.fabrika')

// The CLI passes `--data-dir`; a daemon started by hand falls back to FABRIKA_DATA_DIR.
export function resolveDataDir(argv: readonly string[] = process.argv, env: NodeJS.ProcessEnv = process.env): string {
	const flag = argv.indexOf('--data-dir')
	const explicit = (flag === -1 ? undefined : argv[flag + 1]) ?? env['FABRIKA_DATA_DIR']
	if (explicit) return resolve(explicit)
	return NEUTRAL_DATA_DIR
}

export const paths = createCanvasPaths({
	appName: 'fabrika',
	dataDir: resolveDataDir(),
	tempDir: join(tmpdir(), 'fabrika'),
	ensure: false,
})

export const DATA_DIR = paths.dataDir
export const SESSIONS_DIR = paths.sessionsDir
export const TEMP_DIR = paths.tempDir
export const PID_FILE = paths.pidFile
export const COMPILE_TEMP_DIR = paths.compileTempDir
export const UPLOADS_DIR = paths.uploadsDir

export const DEFAULT_PORT = parseInt(process.env['FABRIKA_PORT'] || '19410', 10)
