import { z } from 'zod'
import {
	type GitHubSetupAttempt,
	type GitHubSetupAttemptRow,
	type GitHubSetupErrorCode,
	type GitHubSetupPhase,
	type GitHubSetupStatus,
	type GitHubSourceConnection,
	type GitHubSourceConnectionRow,
} from './model'

const ACTIVE_PHASES: readonly GitHubSetupPhase[] = [
	'awaiting_manifest_callback',
	'exchange_claimed',
	'credential_stored',
	'app_verified',
	'webhook_secret_stored',
	'webhook_configured',
	'installation_required',
]

const PHASES: readonly GitHubSetupPhase[] = [...ACTIVE_PHASES, 'connected']

const storedText = z.string().refine(value => value.trim() !== '')
const storedDigest = z.string().regex(/^[0-9a-f]{64}$/)
const storedVaultRef = z.string().startsWith('vault:').min(7)
const storedBoolean = z.union([z.literal(0), z.literal(1)]).transform(value => value === 1)
const attemptFieldsSchema = z.object({
	id: storedText,
	state_hash: storedDigest.nullable(),
	manifest_state_secret_ref: storedVaultRef.nullable(),
	initiated_by: storedText,
	expected_origin: storedText,
	desired_owner: storedText,
	desired_app_name: storedText,
	desired_public: storedBoolean,
	app_id: storedText.nullable(),
	app_slug: storedText.nullable(),
	app_html_url: storedText.nullable(),
	app_credential_ref: storedVaultRef.nullable(),
	webhook_secret_ref: storedVaultRef.nullable(),
})
const connectionFieldsSchema = z.object({
	connection_id: storedText,
	app_id: storedText,
	app_slug: storedText,
	app_html_url: storedText,
	app_owner: storedText,
	app_name: storedText,
	app_public: storedBoolean,
	app_credential_ref: storedVaultRef,
	webhook_url: storedText,
	webhook_secret_ref: storedVaultRef,
	installation_account_login: storedText,
	connected_by: storedText,
})

const storedFieldLabels: Readonly<Record<string, string>> = {
	id: 'attempt id',
	state_hash: 'state hash',
	manifest_state_secret_ref: 'vault ref',
	initiated_by: 'initiating principal',
	expected_origin: 'expected origin',
	desired_owner: 'desired owner',
	desired_app_name: 'desired app name',
	desired_public: 'desired public',
	app_id: 'app id',
	app_slug: 'app slug',
	app_html_url: 'app HTML URL',
	app_credential_ref: 'vault ref',
	webhook_secret_ref: 'vault ref',
	connection_id: 'connection id',
	app_owner: 'app owner',
	app_name: 'app name',
	app_public: 'app public',
	webhook_url: 'webhook URL',
	installation_account_login: 'installation account',
	connected_by: 'connected principal',
}

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
	const parsed = attemptFieldsSchema.safeParse(row)
	if (!parsed.success) throw new Error(`invalid GitHub setup ${storedFieldLabels[String(parsed.error.issues[0]?.path[0])] ?? 'state'}`)
	const fields = parsed.data
	return {
		id: fields.id,
		status,
		phase,
		version: row.version,
		stateHash: fields.state_hash,
		manifestStateSecretRef: fields.manifest_state_secret_ref,
		initiatedBy: fields.initiated_by,
		expectedOrigin: fields.expected_origin,
		desiredOwner: fields.desired_owner,
		desiredAppName: fields.desired_app_name,
		desiredPublic: fields.desired_public,
		requestedRepositories: parseRepositories(row.requested_repositories_json),
		appId: fields.app_id,
		appSlug: fields.app_slug,
		appHtmlUrl: fields.app_html_url,
		appCredentialRef: fields.app_credential_ref,
		webhookSecretRef: fields.webhook_secret_ref,
		lastErrorCode: parseOptionalErrorCode(row.last_error_code),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		expiresAt: row.expires_at,
		terminalAt: row.terminal_at,
	}
}

function validatePhaseFields(row: GitHubSetupAttemptRow, phase: GitHubSetupPhase): void {
	const credentialStored = phaseIndex(phase) >= phaseIndex('credential_stored')
	const appVerified = phaseIndex(phase) >= phaseIndex('app_verified')
	const webhookStored = phaseIndex(phase) >= phaseIndex('webhook_secret_stored')
	if (appVerified) {
		if (row.app_id === null || !/^[1-9][0-9]*$/.test(row.app_id)) throw new Error('invalid GitHub setup App id')
		if (row.app_slug === null || !/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(row.app_slug)) {
			throw new Error('invalid GitHub setup App slug')
		}
		if (row.app_html_url !== `https://github.com/apps/${row.app_slug}`) throw new Error('invalid GitHub setup App URL')
	}
	if (credentialStored !== (row.app_credential_ref !== null)) throw new Error('invalid GitHub setup credential state')
	if (webhookStored !== (row.webhook_secret_ref !== null)) throw new Error('invalid GitHub setup webhook state')
}

function phaseIndex(phase: GitHubSetupPhase): number {
	return PHASES.indexOf(phase)
}

export function decodeConnection(row: GitHubSourceConnectionRow): GitHubSourceConnection {
	validateSafePositive(row.version, 'connection version')
	validateSafePositive(row.installation_id, 'installation id')
	validateSafeNonNegative(row.connected_at, 'connected timestamp')
	validateSafeNonNegative(row.verified_at, 'verified timestamp')
	const parsed = connectionFieldsSchema.safeParse(row)
	if (!parsed.success) throw new Error(`invalid GitHub setup ${storedFieldLabels[String(parsed.error.issues[0]?.path[0])] ?? 'state'}`)
	const fields = parsed.data
	return {
		connectionId: fields.connection_id,
		appId: fields.app_id,
		appSlug: fields.app_slug,
		appHtmlUrl: fields.app_html_url,
		appOwner: fields.app_owner,
		appName: fields.app_name,
		appPublic: fields.app_public,
		appCredentialRef: fields.app_credential_ref,
		webhookUrl: fields.webhook_url,
		webhookSecretRef: fields.webhook_secret_ref,
		installationId: row.installation_id,
		installationAccountLogin: fields.installation_account_login,
		installationSelection: parseInstallationSelection(row.installation_selection),
		verifiedRepositories: parseRepositories(row.verified_repositories_json),
		requestedRepositories: parseRepositories(row.requested_repositories_json),
		connectedBy: fields.connected_by,
		connectedAt: row.connected_at,
		verifiedAt: row.verified_at,
		version: row.version,
	}
}

function parseStatus(value: string): GitHubSetupStatus {
	const parsed = z.enum(['active', 'repair_required', 'completed', 'failed']).safeParse(value)
	if (parsed.success) return parsed.data
	throw new Error('invalid GitHub setup status')
}

function parseInstallationSelection(value: string): 'all' | 'selected' {
	const parsed = z.enum(['all', 'selected']).safeParse(value)
	if (parsed.success) return parsed.data
	throw new Error('invalid GitHub installation selection')
}

function parsePhase(value: string): GitHubSetupPhase {
	const parsed = z.enum([
		'awaiting_manifest_callback',
		'exchange_claimed',
		'credential_stored',
		'app_verified',
		'webhook_secret_stored',
		'webhook_configured',
		'installation_required',
		'connected',
	]).safeParse(value)
	if (parsed.success) return parsed.data
	throw new Error('invalid GitHub setup phase')
}

export function canTransition(current: GitHubSetupPhase, next: GitHubSetupPhase): boolean {
	if (current === 'exchange_claimed') return next === 'credential_stored'
	if (current === 'credential_stored') return next === 'app_verified'
	if (current === 'app_verified') return next === 'webhook_secret_stored'
	if (current === 'webhook_secret_stored') return next === 'webhook_configured'
	if (current === 'webhook_configured') return next === 'installation_required'
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
	const result = z.array(z.string().min(1)).safeParse(parsed)
	if (!result.success) {
		throw new Error('invalid GitHub setup repository state')
	}
	const repositories = result.data
	if (JSON.stringify(canonicalRepositories(repositories)) !== JSON.stringify(repositories)) {
		throw new Error('non-canonical GitHub setup repository state')
	}
	return repositories
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

export function validateSha256(value: string, field: string): void {
	if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`invalid GitHub setup ${field}`)
}

export function validateSafePositive(value: number, field: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid GitHub setup ${field}`)
}

function validateSafeNonNegative(value: number, field: string): void {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid GitHub setup ${field}`)
}

function parseOptionalErrorCode(value: string | null): GitHubSetupErrorCode | null {
	const parsed = z.enum([
		'callback_expired',
		'manifest_exchange',
		'credential_persistence',
		'credential_activation',
		'webhook_configuration',
		'configuration_verification',
		'installation_verification',
		'configuration_conflict',
	]).nullable().safeParse(value)
	if (parsed.success) return parsed.data
	throw new Error('invalid GitHub setup error code')
}
