import {
	buildZeropsSourceCredentialBundleV2,
	serializeZeropsSourceCredentialBundleV2,
	sha256ZeropsSourceCredentialBundleV2,
	type SourceConnectionAdmin,
} from '@fabrika/provider-zerops'
import type { SourceConnectionBindingInput, SourceConnectionPort } from '../source-connection-port'

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
		adoptExisting: (input) => admin.adoptExisting(input),
		activate: (input) => {
			const activation = {
				connectionId: input.connectionId,
				credentialBundle: input.credentialBundle,
				credentialSha256: input.credentialSha256,
				signal: input.signal,
			}
			if (input.transportKind === 'legacy-v1') return admin.activate(activation)
			if (admin.activateV2 === undefined) return Promise.reject(new Error('keyed source activation is unavailable'))
			return admin.activateV2(activation)
		},
		status: (input) => {
			const status = { connectionId: input.connectionId, signal: input.signal }
			if (input.transportKind === 'legacy-v1') return admin.status(status)
			if (admin.statusV2 === undefined) return Promise.resolve({ state: 'unavailable' })
			return admin.statusV2(status)
		},
		configureWebhook: async (input) => {
			await bindLegacyRuntime(admin, input)
			return admin.configureWebhook({
				connectionId: input.connectionId,
				credentialSha256: input.credentialSha256,
				url: input.url,
				secret: input.secret,
				signal: input.signal,
			})
		},
		verifyInstallations: async (input) => {
			await bindLegacyRuntime(admin, input)
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

async function bindLegacyRuntime(
	admin: SourceConnectionAdmin,
	input: SourceConnectionBindingInput & { readonly credentialSha256: string },
): Promise<void> {
	if (input.transportKind !== 'legacy-v1') return
	const status = await admin.status({ connectionId: input.connectionId, signal: input.signal })
	if (status.state !== 'active' || status.credentialSha256 !== input.credentialSha256) {
		throw new Error('legacy source connection is not active')
	}
}
