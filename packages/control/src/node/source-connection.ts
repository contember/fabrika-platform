import {
	buildZeropsSourceCredentialBundleV2,
	serializeZeropsSourceCredentialBundleV2,
	sha256ZeropsSourceCredentialBundleV2,
	type SourceConnectionAdmin,
} from '@fabrika/provider-zerops'
import type { SourceConnectionPort } from '../source-connection-port'

/** Keep provider protocol types at the process composition edge. */
export function zeropsSourceConnectionPort(admin: SourceConnectionAdmin): SourceConnectionPort {
	return {
		provider: 'zerops',
		inspect: (signal) => admin.inspect(signal),
		prepareCredential: async (input) => {
			const bundle = serializeZeropsSourceCredentialBundleV2(buildZeropsSourceCredentialBundleV2({
				connectionId: input.connectionId,
				githubAppId: input.appId,
				privateKeyPem: input.privateKeyPem,
			}))
			return { bundle, sha256: await sha256ZeropsSourceCredentialBundleV2(bundle) }
		},
		activate: (input) =>
			admin.activateV2({
				connectionId: input.connectionId,
				credentialBundle: input.credentialBundle,
				credentialSha256: input.credentialSha256,
				signal: input.signal,
			}),
		status: (input) => admin.statusV2({ connectionId: input.connectionId, signal: input.signal }),
		configureWebhook: (input) =>
			admin.configureWebhook({
				connectionId: input.connectionId,
				credentialSha256: input.credentialSha256,
				url: input.url,
				secret: input.secret,
				signal: input.signal,
			}),
		verifyInstallations: async (input) => {
			const response = await admin.verifyInstallations({
				connectionId: input.connectionId,
				credentialSha256: input.credentialSha256,
				scope: input.scope,
				signal: input.signal,
			})
			return response.installation
		},
	}
}
