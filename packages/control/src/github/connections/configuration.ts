import { vault } from '../../services'
import { linkedDeadline, randomToken, type SourceConnectionWorkflowDeps } from './context'
import { type GitHubSetupAttempt, type GitHubSetupErrorCode, type GitHubSetupPhase, type GitHubSourceConnection } from './model'
import type { SourceGitHubAppIdentity } from './port'
import { githubWebhookSecretLabel } from './secrets'

/** Bounds every request-driven run of GitHub App calls, so a stalled GitHub cannot hold a request open. */
export const CONFIGURATION_DEADLINE_MS = 5 * 60_000

const WEBHOOK_SECRET_BYTES = 32

/** Resume a setup from its durable checkpoint; every step reads the App key from the vault. */
async function advanceConfiguration(deps: SourceConnectionWorkflowDeps, initial: GitHubSetupAttempt, signal: AbortSignal): Promise<void> {
	let attempt = initial
	if (attempt.phase === 'credential_stored') {
		const app = await deps.source.verifyApp({ credentialRef: requiredCredentialRef(attempt), connectionId: attempt.id, signal })
		validateIdentity(attempt, app)
		attempt = requiredCheckpoint(
			await deps.env.REPOSITORIES.githubConnections.checkpoint(
				attempt.id,
				attempt.version,
				'credential_stored',
				'app_verified',
				{ appId: String(app.id), appSlug: app.slug, appHtmlUrl: app.htmlUrl },
			),
		)
	}
	if (attempt.phase === 'app_verified') {
		const webhookSecret = randomToken(WEBHOOK_SECRET_BYTES, deps.randomBytes)
		const secretVault = await vault(deps.env)
		const preparedSecret = await secretVault.prepareSecret('platform', githubWebhookSecretLabel(attempt.id), webhookSecret)
		attempt = requiredCheckpoint(
			await deps.env.REPOSITORIES.githubConnections.storeSecretAndCheckpoint(
				attempt.id,
				attempt.version,
				'app_verified',
				'webhook_secret_stored',
				'webhook',
				preparedSecret,
			),
		)
	}
	if (attempt.phase === 'webhook_secret_stored') {
		if (attempt.webhookSecretRef === null) throw new Error('setup state is incomplete')
		const secretVault = await vault(deps.env)
		const webhookSecret = await secretVault.getSecretForPurpose(attempt.webhookSecretRef, {
			scope: 'platform',
			label: githubWebhookSecretLabel(attempt.id),
		})
		await deps.source.configureWebhook({
			credentialRef: requiredCredentialRef(attempt),
			connectionId: attempt.id,
			url: webhookUrl(attempt),
			secret: webhookSecret,
			signal,
		})
		attempt = requiredCheckpoint(
			await deps.env.REPOSITORIES.githubConnections.checkpoint(attempt.id, attempt.version, 'webhook_secret_stored', 'webhook_configured'),
		)
	}
	if (attempt.phase === 'webhook_configured') {
		attempt = requiredCheckpoint(
			await deps.env.REPOSITORIES.githubConnections.checkpoint(attempt.id, attempt.version, 'webhook_configured', 'installation_required'),
		)
	}
}

export async function advanceWithDeadline(deps: SourceConnectionWorkflowDeps, attempt: GitHubSetupAttempt): Promise<void> {
	const deadline = linkedDeadline(deps.request.signal, CONFIGURATION_DEADLINE_MS)
	try {
		await advanceConfiguration(deps, attempt, deadline.signal)
	} finally {
		deadline.dispose()
	}
}

function requiredCredentialRef(attempt: GitHubSetupAttempt): string {
	if (attempt.appCredentialRef === null) throw new Error('setup state is incomplete')
	return attempt.appCredentialRef
}

function validateIdentity(attempt: GitHubSetupAttempt, app: SourceGitHubAppIdentity): void {
	if (
		!validRemoteIdentity(app)
		|| app.owner.type !== 'Organization' || app.owner.login.toLowerCase() !== attempt.desiredOwner.toLowerCase()
		|| app.public !== attempt.desiredPublic || app.permissions.contents !== 'read'
		|| app.events.length !== 1 || app.events[0] !== 'push'
	) throw new Error('verified App identity does not match setup')
}

export function matchesConnectionIdentity(connection: GitHubSourceConnection, app: SourceGitHubAppIdentity): boolean {
	return validRemoteIdentity(app)
		&& app.id === Number(connection.appId) && app.slug === connection.appSlug && app.htmlUrl === connection.appHtmlUrl
		&& app.public === connection.appPublic && app.owner.type === 'Organization'
		&& app.owner.login.toLowerCase() === connection.appOwner.toLowerCase()
		&& app.permissions.contents === 'read' && app.events.length === 1 && app.events[0] === 'push'
}

function validRemoteIdentity(app: SourceGitHubAppIdentity): boolean {
	return Number.isSafeInteger(app.id) && app.id > 0
		&& /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(app.slug)
		&& app.htmlUrl === `https://github.com/apps/${app.slug}`
		&& /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(app.owner.login)
}

export function errorForPhase(phase: GitHubSetupPhase): GitHubSetupErrorCode {
	if (phase === 'credential_stored') return 'credential_activation'
	if (phase === 'app_verified') return 'credential_persistence'
	if (phase === 'webhook_secret_stored' || phase === 'webhook_configured') return 'webhook_configuration'
	if (phase === 'installation_required') return 'installation_verification'
	return 'configuration_verification'
}

export function webhookUrl(attempt: GitHubSetupAttempt): string {
	return `${attempt.expectedOrigin}/webhooks/github/${encodeURIComponent(attempt.id)}`
}

function requiredCheckpoint(attempt: GitHubSetupAttempt | null): GitHubSetupAttempt {
	if (attempt === null) throw new Error('setup state changed')
	return attempt
}
