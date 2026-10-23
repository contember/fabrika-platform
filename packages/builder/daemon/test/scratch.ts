import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A fresh scratch directory under the system temp directory, symlinks resolved. The daemon refuses a project root with
 * a symlink anywhere on its path, and on macOS `tmpdir()` (`/var/folders/…`) and `/tmp` both sit behind one.
 */
export function scratchDir(prefix: string): string {
	return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}
