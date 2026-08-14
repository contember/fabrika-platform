/** Provider-neutral privileged source administration used only by the authenticated setup workflow. */
export interface SourceConnectionPort {
	readonly provider: string
	inspect(signal: AbortSignal): Promise<SourceConnectionInspection>
	prepareCredential(input: SourceCredentialInput): Promise<PreparedSourceCredential>
	adoptExisting(input: { readonly signal: AbortSignal }): Promise<SourceCredentialActivation>
	activate(input: SourceCredentialActivationInput): Promise<SourceCredentialActivation>
	status(input: SourceConnectionBindingInput): Promise<SourceConnectionRuntimeStatus>
	configureWebhook(input: SourceWebhookConfigurationInput): Promise<SourceWebhookConfiguration>
	verifyInstallations(input: SourceInstallationVerificationInput): Promise<SourceInstallationVerification>
}

export type SourceConnectionInspection =
	| { readonly state: 'unavailable' }
	| { readonly state: 'anonymous' }
	| { readonly state: 'legacy-complete' }
	| { readonly state: 'legacy-partial' }
	| { readonly state: 'durable'; readonly credentialSha256: string }

export interface SourceCredentialInput {
	readonly appId: string
	readonly privateKeyPem: string
}

export interface PreparedSourceCredential {
	readonly bundle: string
	readonly sha256: string
}

export interface SourceConnectionBindingInput {
	readonly connectionId: string
	readonly signal: AbortSignal
}

export interface SourceCredentialActivationInput extends SourceConnectionBindingInput {
	readonly credentialBundle: string
	readonly credentialSha256: string
}

export interface SourceGitHubAppIdentity {
	readonly id: number
	readonly slug: string
	readonly htmlUrl: string
	readonly public: boolean
	readonly owner: { readonly login: string; readonly type: 'Organization' }
	readonly permissions: { readonly contents: 'read' }
	readonly events: readonly string[]
}

export interface SourceCredentialActivation {
	readonly connectionId: string
	readonly credentialSha256: string
	readonly githubApp: SourceGitHubAppIdentity
}

export type SourceConnectionRuntimeStatus =
	| SourceConnectionInspection
	| { readonly state: 'activation-required'; readonly credentialSha256: string }
	| { readonly state: 'active'; readonly credentialSha256: string; readonly githubApp: SourceGitHubAppIdentity }

export interface SourceWebhookConfigurationInput extends SourceConnectionBindingInput {
	readonly credentialSha256: string
	readonly url: string
	readonly secret: string
}

export interface SourceWebhookConfiguration {
	readonly connectionId: string
	readonly credentialSha256: string
	readonly webhook: { readonly url: string; readonly contentType: 'json'; readonly insecureSsl: '0' }
}

export type SourceInstallationScope =
	| { readonly kind: 'organization'; readonly organization: string }
	| { readonly kind: 'repositories'; readonly repositories: readonly { readonly owner: string; readonly name: string }[] }

export interface SourceInstallationVerificationInput extends SourceConnectionBindingInput {
	readonly credentialSha256: string
	readonly scope: SourceInstallationScope
}

export type SourceInstallationVerification =
	| { readonly status: 'missing' }
	| {
		readonly status: 'installed'
		readonly installationId: number
		readonly accountLogin: string
		readonly repositorySelection: 'all' | 'selected'
	}

export function unavailableSourceConnection(provider: string): SourceConnectionPort {
	return {
		provider,
		inspect: () => Promise.resolve({ state: 'unavailable' }),
		prepareCredential: () => Promise.reject(new Error('source connection is unavailable')),
		adoptExisting: () => Promise.reject(new Error('source connection is unavailable')),
		activate: () => Promise.reject(new Error('source connection is unavailable')),
		status: () => Promise.resolve({ state: 'unavailable' }),
		configureWebhook: () => Promise.reject(new Error('source connection is unavailable')),
		verifyInstallations: () => Promise.reject(new Error('source connection is unavailable')),
	}
}
