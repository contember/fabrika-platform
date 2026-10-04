export type GitHubSetupStatus = 'active' | 'repair_required' | 'completed' | 'failed'

export type GitHubSourceTransportKind = 'keyed-v2'

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
	| 'recovery_stored'
	| 'source_bundle_written'
	| 'source_activated'
	| 'webhook_secret_stored'
	| 'webhook_configured'
	| 'configuration_verified'
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
	credentialSha256: string | null
	recoverySecretRef: string | null
	webhookSecretRef: string | null
	lastErrorCode: GitHubSetupErrorCode | null
	createdAt: number
	updatedAt: number
	expiresAt: number
	terminalAt: number | null
}

export interface GitHubSourceConnection {
	connectionId: string
	transportKind: GitHubSourceTransportKind
	appId: string
	appSlug: string
	appHtmlUrl: string
	appOwner: string
	appName: string
	appPublic: boolean
	credentialSha256: string
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
	credential_sha256: string | null
	recovery_secret_ref: string | null
	webhook_secret_ref: string | null
	last_error_code: string | null
	created_at: number
	updated_at: number
	expires_at: number
	terminal_at: number | null
}

export interface GitHubSourceConnectionRow {
	connection_id: string
	transport_kind: string
	app_id: string
	app_slug: string
	app_html_url: string
	app_owner: string
	app_name: string
	app_public: number
	credential_sha256: string
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
	credentialSha256?: string
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

export type GitHubSetupSecretKind = 'recovery' | 'webhook'

export class GitHubConnectionCasError extends Error {
	constructor() {
		super('GitHub source connection state changed')
		this.name = 'GitHubConnectionCasError'
	}
}
