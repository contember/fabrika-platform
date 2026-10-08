export type GitHubSetupStatus = 'active' | 'repair_required' | 'completed' | 'failed'

export type GitHubSetupErrorCode =
	| 'callback_expired'
	| 'manifest_exchange'
	| 'credential_persistence'
	| 'credential_activation'
	| 'webhook_configuration'
	| 'configuration_verification'
	| 'installation_verification'
	| 'configuration_conflict'

export type GitHubSetupPhase =
	| 'awaiting_manifest_callback'
	| 'exchange_claimed'
	| 'credential_stored'
	| 'app_verified'
	| 'webhook_secret_stored'
	| 'webhook_configured'
	| 'installation_required'
	| 'connected'

export interface GitHubSetupAttempt {
	id: string
	status: GitHubSetupStatus
	phase: GitHubSetupPhase
	version: number
	stateHash: string | null
	manifestStateSecretRef: string | null
	initiatedBy: string
	expectedOrigin: string
	desiredOwner: string
	desiredAppName: string
	desiredPublic: boolean
	requestedRepositories: string[]
	appId: string | null
	appSlug: string | null
	appHtmlUrl: string | null
	appCredentialRef: string | null
	webhookSecretRef: string | null
	lastErrorCode: GitHubSetupErrorCode | null
	createdAt: number
	updatedAt: number
	expiresAt: number
	terminalAt: number | null
}

export interface GitHubSourceConnection {
	connectionId: string
	appId: string
	appSlug: string
	appHtmlUrl: string
	appOwner: string
	appName: string
	appPublic: boolean
	appCredentialRef: string
	webhookUrl: string
	webhookSecretRef: string
	installationId: number
	installationAccountLogin: string
	installationSelection: 'all' | 'selected'
	verifiedRepositories: string[]
	requestedRepositories: string[]
	connectedBy: string
	connectedAt: number
	verifiedAt: number
	version: number
}

export interface GitHubWebhookSecretBinding {
	connectionId: string
	webhookSecretRef: string
}

export interface GitHubSetupAttemptRow {
	id: string
	status: string
	phase: string
	version: number
	state_hash: string | null
	manifest_state_secret_ref: string | null
	initiated_by: string
	expected_origin: string
	desired_owner: string
	desired_app_name: string
	desired_public: number
	requested_repositories_json: string
	app_id: string | null
	app_slug: string | null
	app_html_url: string | null
	app_credential_ref: string | null
	webhook_secret_ref: string | null
	last_error_code: string | null
	created_at: number
	updated_at: number
	expires_at: number
	terminal_at: number | null
}

export interface GitHubSourceConnectionRow {
	connection_id: string
	app_id: string
	app_slug: string
	app_html_url: string
	app_owner: string
	app_name: string
	app_public: number
	app_credential_ref: string
	webhook_url: string
	webhook_secret_ref: string
	installation_id: number
	installation_account_login: string
	installation_selection: string
	verified_repositories_json: string
	requested_repositories_json: string
	connected_by: string
	connected_at: number
	verified_at: number
	version: number
}

export interface GitHubSourceConnectionPageInput {
	readonly cursor?: string
	readonly limit?: number
}

export interface GitHubSourceConnectionPage {
	readonly items: readonly GitHubSourceConnection[]
	readonly nextCursor: string | null
}

export interface BeginGitHubSetupInput {
	id?: string
	stateHash: string
	initiatedBy: string
	expectedOrigin: string
	desiredOwner: string
	desiredAppName: string
	desiredPublic: boolean
	requestedRepositories: readonly string[]
	expiresAt: number
}

export interface GitHubSetupPatch {
	appId?: string
	appSlug?: string
	appHtmlUrl?: string
	lastErrorCode?: GitHubSetupErrorCode
}

export interface PublishGitHubConnectionInput {
	attemptId: string
	expectedVersion: number
	webhookUrl: string
	installationId: number
	installationAccountLogin: string
	installationSelection: 'all' | 'selected'
	verifiedRepositories: readonly string[]
	verifiedAt: number
}

export type GitHubSetupSecretKind = 'app-credential' | 'webhook'

export class GitHubConnectionCasError extends Error {
	constructor() {
		super('GitHub source connection state changed')
		this.name = 'GitHubConnectionCasError'
	}
}
