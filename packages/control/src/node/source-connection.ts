import {
	buildZeropsSourceCredentialBundle,
	serializeZeropsSourceCredentialBundle,
	sha256ZeropsSourceCredentialBundle,
	type SourceConnectionAdmin,
} from '@fabrika/provider-zerops'
import type { SourceConnectionPort } from '../source-connection-port'

/** Keep provider protocol types at the process composition edge. */
export function zeropsSourceConnectionPort(admin: SourceConnectionAdmin): SourceConnectionPort {
	return {
		provider: 'zerops',
		inspect: (signal) => admin.inspect(signal),
		prepareCredential: async (input) => {
			const bundle = serializeZeropsSourceCredentialBundle(buildZeropsSourceCredentialBundle({
				githubAppId: input.appId,
				privateKeyPem: input.privateKeyPem,
			}))
			return { bundle, sha256: await sha256ZeropsSourceCredentialBundle(bundle) }
		},
		adoptExisting: (input) => admin.adoptExisting(input),
		activate: (input) =>
			admin.activate({
				connectionId: input.connectionId,
				credentialBundle: input.credentialBundle,
				credentialSha256: input.credentialSha256,
				signal: input.signal,
			}),
		status: (input) => admin.status(input),
		configureWebhook: (input) => admin.configureWebhook(input),
		verifyInstallations: async (input) => {
			const response = await admin.verifyInstallations(input)
			return response.installation
		},
	}
}
