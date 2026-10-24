// The operator's local copy of every credential a bring-up creates.
//
// A cloud that stores a credential write-only hands nothing back, so this file is the copy the command
// writes before the first credential is placed: a run that fails later loses nothing.

import { existsSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

/** `--secrets-file`: where the local copy goes. A new file, outside the source checkout. */
export const SECRETS_FILE_FLAG = '--secrets-file'
export const SECRETS_FILE_VARIABLE = 'FABRIKA_PLATFORM_SECRETS_FILE'

/**
 * Settle the path before anything is contacted.
 *
 * Refused when it exists, because overwriting one would destroy another installation's only copy, and
 * when it is inside the source checkout, where it would dirty the checkout a deploy uploads and could be
 * committed.
 */
export const checkedSecretsFilePath = (path: string, sourceDir: string): string => {
	const absolute = resolve(path)
	const fromSource = relative(resolve(sourceDir), absolute)
	if (fromSource === '' || (!fromSource.startsWith('..') && !isAbsolute(fromSource))) {
		throw new Error(`${SECRETS_FILE_FLAG}=${path} is inside the source checkout — name a path outside it, so it is never uploaded or committed`)
	}
	if (existsSync(absolute)) {
		throw new Error(`${SECRETS_FILE_FLAG}=${path} already exists — it may be another installation's only copy; name a new file`)
	}
	return absolute
}

/**
 * The file's text: comment lines, then shell-sourceable assignments, named as the commands that read
 * them name them. `header` is the provider's own lines, each written as a `#` comment.
 */
export const renderSecretsFile = (header: readonly string[], assignments: readonly (readonly [string, string])[]): string => {
	const lines = assignments.map(([name, value]) => {
		// Single quotes keep every character literal; none of these values can contain one.
		if (value.includes("'") || value.includes('\n')) {
			throw new Error(`${name} cannot be written to the secrets file as one quoted line`)
		}
		return `${name}='${value}'`
	})
	return [
		...header.map((line) => `# ${line}`),
		'# Load it in a subshell: ( set -a && . <this file> && set +a && fabrika … )',
		...lines,
		'',
	].join('\n')
}

/** Create the file with mode 0600, failing rather than replacing one that appeared since the check. */
export const writeSecretsFile = async (path: string, text: string): Promise<void> => {
	const file = await open(path, 'wx', 0o600)
	try {
		await file.writeFile(text)
	} finally {
		await file.close()
	}
}
