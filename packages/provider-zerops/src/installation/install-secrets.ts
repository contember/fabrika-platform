// What a Zerops installation's secrets file records.
//
// The services hold the same values in Zerops, but stored SENSITIVE, and Zerops hands a sensitive value
// back only to a token in sudo mode (measured 2026-10-15). The file's path rule, quoting and 0600 write
// are `@fabrika/installation-init`'s `secrets-file.ts`.

import { type InstallationSecrets, renderSecretsFile } from '@fabrika/installation-init'

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
 * The file's text, named as the commands that read it name each value.
 *
 * `FABRIKA_ZEROPS_ACCESS_TOKEN` is the INTEGRATION token, which is what `platform init` and
 * `platform deploy` take; the personal token the install ran with is not written.
 */
export const renderInstallationSecretsFile = (record: InstallationSecretsRecord): string => {
	const { secrets } = record
	return renderSecretsFile(
		[
			`fabrika on Zerops — installation \`${record.environment}\`, project ${record.projectId}.`,
			'Written by `fabrika platform install`. Every value below is a credential: keep this file private.',
			'Zerops holds the same values as sensitive variables and does not hand them back.',
		],
		[
			['FABRIKA_ZEROPS_PROJECT_ID', record.projectId],
			['FABRIKA_ZEROPS_CLIENT_ID', record.clientId],
			['FABRIKA_IAM_PROVISIONING_KEY', secrets.provisioningKey],
			['FABRIKA_ZEROPS_ACCESS_TOKEN', record.zeropsAccessToken],
			['FABRIKA_IAM_RPC_KEY', secrets.rpcKey],
			['FABRIKA_IAM_PROXY_KEY', secrets.proxyKey],
			['OPERATIONS_SYNC_KEY', secrets.operationsSyncKey],
			['FABRIKA_CONTROL_VAULT_KEY', secrets.vaultKey],
			['FABRIKA_IAM_SIGNING_KEYS', secrets.signingKeys],
		],
	)
}
