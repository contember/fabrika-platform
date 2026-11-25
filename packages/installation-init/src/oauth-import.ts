// The deploy's one import of the operator's OAuth client list into IAM's registry (ADR-0089 §5, release N). Every
// deploy of every provider calls it with the parsed variable, or with none when the variable is unset; IAM writes the
// list on the first call only, so after it an administrator's edit in the registry is never undone by a deploy.

import type { ImportOAuthClientsResponse } from '@fabrika/iam-contract'
import { adminRpcStep, type IamAdminClient } from './admin'
import type { McpClient } from './mcp'

/** The slice of IAM's admin surface the import calls; `IamAdminClient` satisfies it. */
export interface OAuthClientImportApi {
	readonly oauthClients: Pick<IamAdminClient['oauthClients'], 'importOnce'>
}

export interface OAuthClientImport {
	/** The parsed client list; absent when its variable is unset. */
	readonly clients: readonly McpClient[] | undefined
	/** The variable the list came from, named in what the deploy reports. */
	readonly variable: string
	readonly dryRun: boolean
	/** IAM's admin surface over the provisioning key; a dry run never asks for it. */
	readonly connect: () => OAuthClientImportApi
	readonly log: { info(message: string): void; warn(message: string): void }
}

/** The answer as IAM's contract states it, or a refusal: the address answered, but not as release N's IAM. */
const checkedResponse = (response: ImportOAuthClientsResponse): ImportOAuthClientsResponse => {
	if (response.status === 'already_imported') return response
	if (response.status === 'imported' && Array.isArray(response.externalApps) && Array.isArray(response.oauthClients)) return response
	throw new Error('oauthClients.importOnce answered neither imported nor already_imported')
}

/**
 * Import the client list once. Any failure throws and fails the deploy; the message names the procedure and IAM's own
 * wording, never the key or the raw error.
 */
export const importOAuthClientsOnce = async (input: OAuthClientImport): Promise<void> => {
	const { clients, variable, log } = input
	const count = clients?.length ?? 0
	if (input.dryRun) {
		const source = clients === undefined ? `nothing (${variable} is unset)` : `${count} OAuth client(s) from ${variable}`
		log.info(`would import ${source} into IAM's registry, unless an earlier deploy already did`)
		return
	}
	const api = input.connect()
	const response = checkedResponse(
		await adminRpcStep('oauthClients.importOnce', () => api.oauthClients.importOnce({ clients: [...(clients ?? [])] })),
	)
	if (response.status === 'imported') {
		const apps = response.externalApps.length === 0 ? '' : ` (${response.externalApps.join(', ')})`
		log.info(
			`IAM imported the OAuth client list: ${response.externalApps.length} external application(s)${apps}, `
				+ `${response.oauthClients.length} client(s); it serves its registry from now on`,
		)
	} else {
		log.info("IAM's registry was imported by an earlier deploy; nothing was written")
	}
	// Every deploy while the variable is set, the importing one included (ADR-0089 §5).
	if (clients !== undefined) {
		const imported = response.status === 'imported' ? 'imported; ' : ''
		log.warn(
			`${variable} ${imported}this release no longer reads the variable after the import: IAM's registry holds the OAuth `
				+ 'clients, and an IAM administrator registers external applications in the console. Delete it once this release '
				+ 'is accepted on the installation; a later release refuses a deploy that still sets it',
		)
	}
}
