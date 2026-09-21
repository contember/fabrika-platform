import {
	type GitHubSetupAttempt,
	type GitHubSetupAttemptRow,
	type GitHubSetupErrorCode,
	type GitHubSetupPhase,
	type GitHubSetupStatus,
	type GitHubSourceConnection,
	type GitHubSourceConnectionRow,
	type GitHubSourceTransportKind,
} from './model'

const ACTIVE_PHASES: readonly GitHubSetupPhase[] = [
	'awaiting_manifest_callback',
	'exchange_claimed',
	'recovery_stored',
	'source_bundle_written',
	'source_activated',
	'webhook_secret_stored',
	'webhook_configured',
	'configuration_verified',
	'installation_required',
]

export function decodeAttempt(row: GitHubSetupAttemptRow): GitHubSetupAttempt {
	const status = parseStatus(row.status)
	const phase = parsePhase(row.phase)
	validateSafePositive(row.version, 'attempt version')
	validateSafeNonNegative(row.created_at, 'created timestamp')
	validateSafeNonNegative(row.updated_at, 'updated timestamp')
	validateSafeNonNegative(row.expires_at, 'expiry timestamp')
	if (row.terminal_at !== null) validateSafeNonNegative(row.terminal_at, 'terminal timestamp')
	if ((status === 'completed' || status === 'failed') !== (row.terminal_at !== null)) throw new Error('invalid GitHub setup terminal state')
	if ((status === 'completed') !== (phase === 'connected')) throw new Error('invalid completed GitHub setup phase')
	if ((status === 'active' && phase === 'awaiting_manifest_callback') !== (row.state_hash !== null)) {
		throw new Error('invalid GitHub setup capability state')
	}
	if (status === 'active' && !ACTIVE_PHASES.includes(phase)) throw new Error('invalid active GitHub setup phase')
	validatePhaseFields(row, phase)
	return {
		id: required(row.id, 'attempt id'),
		status,
		phase,
		version: row.version,
		stateHash: optionalSha256(row.state_hash, 'state hash'),
		manifestStateSecretRef: optionalVaultRef(row.manifest_state_secret_ref),
		initiatedBy: required(row.initiated_by, 'initiating principal'),
		expectedOrigin: required(row.expected_origin, 'expected origin'),
		desiredOwner: required(row.desired_owner, 'desired owner'),
		desiredAppName: required(row.desired_app_name, 'desired app name'),
		desiredPublic: parseBoolean(row.desired_public, 'desired public'),
		requestedRepositories: parseRepositories(row.requested_repositories_json),
		appId: optionalNonEmpty(row.app_id, 'app id'),
		appSlug: optionalNonEmpty(row.app_slug, 'app slug'),
		appHtmlUrl: optionalNonEmpty(row.app_html_url, 'app HTML URL'),
		credentialSha256: optionalSha256(row.credential_sha256, 'credential digest'),
		recoverySecretRef: optionalVaultRef(row.recovery_secret_ref),
		webhookSecretRef: optionalVaultRef(row.webhook_secret_ref),
		lastErrorCode: parseOptionalErrorCode(row.last_error_code),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		expiresAt: row.expires_at,
		terminalAt: row.terminal_at,
	}
}

function validatePhaseFields(row: GitHubSetupAttemptRow, phase: GitHubSetupPhase): void {
	const sourceWritten = phaseIndex(phase) >= phaseIndex('source_bundle_written')
	const sourceActivated = phaseIndex(phase) >= phaseIndex('source_activated')
	const webhookStored = phaseIndex(phase) >= phaseIndex('webhook_secret_stored')
	const recoveryExpected = phaseIndex(phase) >= phaseIndex('recovery_stored') && phaseIndex(phase) < phaseIndex('installation_required')
	if (sourceWritten && row.credential_sha256 === null) throw new Error('invalid GitHub setup credential state')
	if (sourceActivated && (row.app_id === null || row.app_slug === null || row.app_html_url === null)) {
		throw new Error('invalid GitHub setup App state')
	}
	if (sourceActivated) {
		if (row.app_id === null || !/^[1-9][0-9]*$/.test(row.app_id)) throw new Error('invalid GitHub setup App id')
		if (row.app_slug === null || !/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(row.app_slug)) {
			throw new Error('invalid GitHub setup App slug')
		}
		if (row.app_html_url !== `https://github.com/apps/${row.app_slug}`) throw new Error('invalid GitHub setup App URL')
	}
	if (recoveryExpected !== (row.recovery_secret_ref !== null)) throw new Error('invalid GitHub setup recovery state')
	if (webhookStored !== (row.webhook_secret_ref !== null)) throw new Error('invalid GitHub setup webhook state')
}

function phaseIndex(phase: GitHubSetupPhase): number {
	const phases: readonly GitHubSetupPhase[] = [
		'awaiting_manifest_callback',
		'exchange_claimed',
		'recovery_stored',
		'source_bundle_written',
		'source_activated',
		'webhook_secret_stored',
		'webhook_configured',
		'configuration_verified',
		'installation_required',
		'connected',
	]
	return phases.indexOf(phase)
}

export function decodeConnection(row: GitHubSourceConnectionRow): GitHubSourceConnection {
	validateSafePositive(row.version, 'connection version')
	validateSafePositive(row.installation_id, 'installation id')
	validateSafeNonNegative(row.connected_at, 'connected timestamp')
	validateSafeNonNegative(row.verified_at, 'verified timestamp')
	return {
		connectionId: required(row.connection_id, 'connection id'),
		transportKind: parseTransportKind(row.transport_kind),
		appId: required(row.app_id, 'app id'),
		appSlug: required(row.app_slug, 'app slug'),
		appHtmlUrl: required(row.app_html_url, 'app HTML URL'),
		appOwner: required(row.app_owner, 'app owner'),
		appName: required(row.app_name, 'app name'),
		appPublic: parseBoolean(row.app_public, 'app public'),
		credentialSha256: requiredSha256(row.credential_sha256, 'credential digest'),
		webhookUrl: required(row.webhook_url, 'webhook URL'),
		webhookSecretRef: requiredVaultRef(row.webhook_secret_ref),
		installationId: row.installation_id,
		installationAccountLogin: required(row.installation_account_login, 'installation account'),
		installationSelection: parseInstallationSelection(row.installation_selection),
		verifiedRepositories: parseRepositories(row.verified_repositories_json),
		requestedRepositories: parseRepositories(row.requested_repositories_json),
		connectedBy: required(row.connected_by, 'connected principal'),
		connectedAt: row.connected_at,
		verifiedAt: row.verified_at,
		version: row.version,
	}
}

function parseTransportKind(value: string): GitHubSourceTransportKind {
	if (value === 'keyed-v2') return value
	throw new Error('invalid GitHub source transport kind')
}

function parseStatus(value: string): GitHubSetupStatus {
	if (value === 'active' || value === 'repair_required' || value === 'completed' || value === 'failed') return value
	throw new Error('invalid GitHub setup status')
}

function parseInstallationSelection(value: string): 'all' | 'selected' {
	if (value === 'all' || value === 'selected') return value
	throw new Error('invalid GitHub installation selection')
}

function parsePhase(value: string): GitHubSetupPhase {
	if (
		value === 'awaiting_manifest_callback' || value === 'exchange_claimed' || value === 'recovery_stored' || value === 'source_bundle_written'
		|| value === 'source_activated' || value === 'webhook_secret_stored' || value === 'webhook_configured'
		|| value === 'configuration_verified' || value === 'installation_required' || value === 'connected'
	) return value
	throw new Error('invalid GitHub setup phase')
}

export function canTransition(current: GitHubSetupPhase, next: GitHubSetupPhase): boolean {
	if (current === 'exchange_claimed') return next === 'recovery_stored'
	if (current === 'recovery_stored') return next === 'source_bundle_written'
	if (current === 'source_bundle_written') return next === 'source_activated'
	if (current === 'source_activated') return next === 'webhook_secret_stored'
	if (current === 'webhook_secret_stored') return next === 'webhook_configured'
	if (current === 'webhook_configured') return next === 'configuration_verified'
	if (current === 'configuration_verified') return next === 'installation_required'
	return false
}

export function canonicalRepositories(values: readonly string[]): string[] {
	const unique = new Set<string>()
	for (const value of values) {
		const [owner, name, ...rest] = value.split('/')
		if (owner === undefined || name === undefined || rest.length !== 0) throw new Error('invalid GitHub setup repository')
		validateGitHubOwner(owner)
		if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) throw new Error('invalid GitHub setup repository')
		unique.add(`${owner.toLowerCase()}/${name.toLowerCase()}`)
	}
	return [...unique].sort()
}

function parseRepositories(json: string): string[] {
	let parsed: unknown
	try {
		parsed = JSON.parse(json)
	} catch {
		throw new Error('invalid GitHub setup repository state')
	}
	if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string' && value !== '')) {
		throw new Error('invalid GitHub setup repository state')
	}
	const repositories: string[] = []
	for (const value of parsed) {
		if (typeof value !== 'string') throw new Error('invalid GitHub setup repository state')
		repositories.push(value)
	}
	if (JSON.stringify(canonicalRepositories(repositories)) !== JSON.stringify(repositories)) {
		throw new Error('non-canonical GitHub setup repository state')
	}
	return repositories
}

function required(value: string, field: string): string {
	validateNonEmpty(value, field)
	return value
}

export function validateNonEmpty(value: string, field: string): void {
	if (value.trim() === '') throw new Error(`invalid GitHub setup ${field}`)
}

export function validateControlOrigin(value: string): void {
	let url: URL
	try {
		url = new URL(value)
	} catch {
		throw new Error('invalid GitHub setup expected origin')
	}
	if (url.protocol !== 'https:' || url.origin !== value || url.username !== '' || url.password !== '') {
		throw new Error('invalid GitHub setup expected origin')
	}
}

export function validateGitHubOwner(value: string): void {
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value)) throw new Error('invalid GitHub setup owner')
}

export function validateConnectionId(value: string): void {
	if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new Error('invalid GitHub setup connection id')
}

function optionalNonEmpty(value: string | null, field: string): string | null {
	if (value === null) return null
	return required(value, field)
}

function optionalSha256(value: string | null, field: string): string | null {
	if (value === null) return null
	return requiredSha256(value, field)
}

function requiredSha256(value: string, field: string): string {
	validateSha256(value, field)
	return value
}

export function validateSha256(value: string, field: string): void {
	if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`invalid GitHub setup ${field}`)
}

function optionalVaultRef(value: string | null): string | null {
	if (value === null) return null
	return requiredVaultRef(value)
}

function requiredVaultRef(value: string): string {
	if (!value.startsWith('vault:') || value.length === 'vault:'.length) throw new Error('invalid GitHub setup vault ref')
	return value
}

function parseBoolean(value: number, field: string): boolean {
	if (value === 0) return false
	if (value === 1) return true
	throw new Error(`invalid GitHub setup ${field}`)
}

export function validateSafePositive(value: number, field: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid GitHub setup ${field}`)
}

function validateSafeNonNegative(value: number, field: string): void {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid GitHub setup ${field}`)
}

function parseOptionalErrorCode(value: string | null): GitHubSetupErrorCode | null {
	if (value === null) return null
	if (
		value === 'callback_expired' || value === 'manifest_exchange' || value === 'credential_persistence'
		|| value === 'credential_activation' || value === 'webhook_configuration' || value === 'configuration_verification'
		|| value === 'installation_verification' || value === 'configuration_conflict'
	) return value
	throw new Error('invalid GitHub setup error code')
}
