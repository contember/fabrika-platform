import { ensureRuntimeDir } from '@fabrika/daemon-kit'
import { TEMP_DIR } from '../config.ts'

/** Prints the user's private runtime directory, made `0700` first; agents keep a session's canvas files under it. */
export function handleDir(): void {
	try {
		console.log(ensureRuntimeDir(TEMP_DIR))
	} catch (error: unknown) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
		process.exit(1)
	}
}
