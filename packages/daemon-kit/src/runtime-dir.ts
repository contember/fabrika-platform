import { chmodSync, lstatSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { isAbsolute, join } from 'path'

/**
 * Where a host keeps its runtime files (pid file, CLI capability, logs, link files, compile scratch): `<appName>` under
 * `$XDG_RUNTIME_DIR` when it is set, else `<tmpdir>/<appName>-<uid>`. A fixed name in a shared temp directory lets
 * another OS user create it first and keep the daemon from starting.
 */
export function userRuntimeDir(appName: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
	const runtime = env['XDG_RUNTIME_DIR']
	if (runtime !== undefined && isAbsolute(runtime)) return join(runtime, appName)
	const uid = process.getuid?.()
	return join(tmpdir(), uid === undefined ? appName : `${appName}-${uid}`)
}

/**
 * Creates `directory` `0700`, or takes the one there when it is a real directory of this user's, and returns it. Refuses
 * a symlink, a file, or a directory another user owns: the runtime files never land where someone else chose.
 */
export function ensureRuntimeDir(directory: string): string {
	mkdirSync(directory, { recursive: true, mode: 0o700 })
	const stat = lstatSync(directory)
	const uid = process.getuid?.()
	if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) {
		throw new Error(`${directory} is not a private directory of this user (a symlink, a file or another user's); set XDG_RUNTIME_DIR to one`)
	}
	// Not a symlink and ours: in a sticky temp directory or a private runtime one, nobody else can swap it before this.
	chmodSync(directory, 0o700)
	return directory
}
