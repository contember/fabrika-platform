// The local copy of every credential `platform install` creates.
//
// The services hold the same values in Zerops, but stored SENSITIVE, and Zerops hands a sensitive value
// back only to a token in sudo mode (measured 2026-10-15). So the operator's copy is the one this
// command writes, before the first of them is placed: a run that fails later loses nothing.

import { existsSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { InstallationSecrets } from './secrets'

/** `--secrets-file`: where the local copy goes. A new file, outside the source checkout. */
export const SECRETS_FILE_FLAG = '--secrets-file'
export const SECRETS_FILE_VARIABLE = 'FABRIKA_PLATFORM_SECRETS_FILE'

/**
 * Settle the path before anything is contacted.
 *
 * Refused when it exists, because overwriting one would destroy another installation's only copy, and
 * when it is inside the source checkout, where it would dirty the checkout `platform deploy` uploads
 * and could be committed.
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

/** What the file records beside the credentials, so it identifies its installation on its own. */
export interface InstallationSecretsRecord {
	readonly environment: string
	readonly projectId: string
	readonly clientId: string
	readonly secrets: InstallationSecrets
	/** The integration token minted for the control plane. */
	readonly zeropsAccessToken: string
}

/**
 * The file's text: shell-sourceable assignments, named as the commands that read them name them.
 *
 * `FABRIKA_ZEROPS_ACCESS_TOKEN` is the INTEGRATION token, which is what `platform init` and
 * `platform deploy` take; the personal token the install ran with is not written.
 */
export const renderSecretsFile = (record: InstallationSecretsRecord): string => {
	const { secrets } = record
	const assignments: readonly (readonly [string, string])[] = [
		['FABRIKA_ZEROPS_PROJECT_ID', record.projectId],
		['FABRIKA_ZEROPS_CLIENT_ID', record.clientId],
		['FABRIKA_IAM_PROVISIONING_KEY', secrets.provisioningKey],
		['FABRIKA_ZEROPS_ACCESS_TOKEN', record.zeropsAccessToken],
		['FABRIKA_IAM_RPC_KEY', secrets.rpcKey],
		['FABRIKA_IAM_PROXY_KEY', secrets.proxyKey],
		['OPERATIONS_SYNC_KEY', secrets.operationsSyncKey],
		['FABRIKA_CONTROL_VAULT_KEY', secrets.vaultKey],
		['FABRIKA_IAM_SIGNING_KEYS', secrets.signingKeys],
	]
	const lines = assignments.map(([name, value]) => {
		// Single quotes keep every character literal; none of these values can contain one.
		if (value.includes("'") || value.includes('\n')) {
			throw new Error(`${name} cannot be written to the secrets file as one quoted line`)
		}
		return `${name}='${value}'`
	})
	return [
		`# fabrika on Zerops — installation \`${record.environment}\`, project ${record.projectId}.`,
		'# Written by `fabrika platform install`. Every value below is a credential: keep this file private.',
		'# Zerops holds the same values as sensitive variables and does not hand them back.',
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
