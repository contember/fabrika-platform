import type { ImportOAuthClientsRequest, ImportOAuthClientsResponse } from '@fabrika/iam-contract'
import type { IamAdminConnection, OAuthClientImportApi } from '@fabrika/installation-init'

export interface RecordedImport {
	readonly connection: IamAdminConnection
	readonly request: ImportOAuthClientsRequest
}

/** IAM's OAuth client import as a deploy reaches it: each call recorded, answered with `status`. */
export const fakeIamAdmin = (status: ImportOAuthClientsResponse['status'] = 'already_imported') => {
	const imports: RecordedImport[] = []
	const iamAdmin = (connection: IamAdminConnection): OAuthClientImportApi => ({
		oauthClients: {
			importOnce: async (request) => {
				imports.push({ connection, request })
				return status === 'imported' ? { status, externalApps: [], oauthClients: [] } : { status }
			},
		},
	})
	return { imports, iamAdmin }
}
