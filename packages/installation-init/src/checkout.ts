import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

/** `--checkout=<dir>`: where `platform init` keeps the sidecar repository's local checkout. */
export const CHECKOUT_FLAG = '--checkout'

/** `dir` with every symlink in its existing part resolved, so a link into a repository is seen as inside it. */
const physicalPath = (dir: string): string => {
	let existing = dir
	while (!existsSync(existing)) {
		const parent = dirname(existing)
		if (parent === existing) return dir
		existing = parent
	}
	return join(realpathSync(existing), relative(existing, dir))
}

/** The git work tree that encloses `dir`, not counting `dir` being a checkout itself. */
const enclosingRepository = (dir: string): string | undefined => {
	let current = dirname(physicalPath(dir))
	while (true) {
		if (existsSync(resolve(current, '.git'))) return current
		const parent = dirname(current)
		if (parent === current) return undefined
		current = parent
	}
}

/**
 * The sidecar checkout directory: `--checkout`, or `defaultName` in the working directory.
 *
 * Refused inside another repository, where it would sit as an untracked nested repository that a
 * blanket `git add` records as a gitlink.
 */
export const sidecarCheckoutDir = (explicit: string | undefined, defaultName: string, cwd: string = process.cwd()): string => {
	const dir = resolve(cwd, explicit ?? defaultName)
	const repository = enclosingRepository(dir)
	if (repository !== undefined) {
		throw new Error(
			`the sidecar checkout ${dir} would sit inside the git repository at ${repository}. `
				+ `Pass ${CHECKOUT_FLAG}=<dir> outside it, or run init from a directory that is not in a repository`,
		)
	}
	return dir
}
