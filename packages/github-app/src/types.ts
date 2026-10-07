export interface GitHubAppClientConfig {
	/** Numeric GitHub App id, kept as a string because it is the JWT issuer. */
	appId: string
	/** GitHub App RSA private key in PKCS1 or PKCS8 PEM form. */
	privateKeyPem: string
	/** GitHub API base URL. Defaults to the public GitHub API. */
	apiBaseUrl?: string
	/** HTTP implementation for the current runtime. */
	fetch?: GitHubAppFetch
	/** Millisecond Unix clock. */
	now?: () => number
	/** Upper bound for each GitHub API request, including its response body. */
	timeoutMs?: number
}

export interface GitHubInstallationToken {
	token: string
	expiresAt: number
}

export interface GitHubAppInstallation {
	readonly id: number
	readonly accountLogin: string
	readonly accountType: 'Organization' | 'User'
	readonly repositorySelection: 'all' | 'selected'
}

export interface GitHubAppIdentity {
	readonly id: number
	readonly slug: string
	readonly htmlUrl: string
	readonly public: boolean
	readonly permissions: {
		readonly contents: 'read' | 'write'
		readonly pull_requests?: 'read' | 'write'
	}
	readonly events: readonly string[]
	readonly owner: {
		readonly login: string
		readonly type: 'Organization' | 'User'
	}
}

export interface GitHubAppWebhookConfig {
	readonly url: string
	readonly contentType: 'json' | 'form'
	readonly insecureSsl: '0' | '1'
}

export interface GitHubAppWebhookUpdate {
	readonly url: string
	readonly secret: string
	readonly signal?: AbortSignal
}

export interface GitHubRepositoryTokenRequest {
	installationId: number
	owner: string
	repository: string
	signal?: AbortSignal
}

export type GitHubAppFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface CreatedGitHubApp {
	readonly id: number
	readonly slug: string
	readonly htmlUrl: string
	readonly pem: string
	readonly webhookSecret: string
}

export interface GitHubAppManifestInput {
	readonly organization: string
	readonly appName: string
	readonly homepageUrl: string
	readonly webhookUrl: string
	readonly redirectUrl?: string
	/** GitHub requires a public App when repositories outside its owner organization need it. */
	readonly public: boolean
}

export interface GitHubAppManifestExchangeOptions {
	readonly fetch?: GitHubAppFetch
	readonly signal?: AbortSignal
	readonly timeoutMs?: number
}
