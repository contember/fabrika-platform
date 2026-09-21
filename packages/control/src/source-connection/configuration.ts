import {
	githubRecoverySecretLabel,
	type GitHubSetupAttempt,
	type GitHubSetupErrorCode,
	type GitHubSetupPhase,
	type GitHubSourceConnection,
	githubWebhookSecretLabel,
} from '../github-connection-store'
import { vault } from '../services'
import type { SourceGitHubAppIdentity } from '../source-connection-port'
import { linkedDeadline, randomToken, sha256, type SourceConnectionWorkflowDeps } from './context'

const CONFIGURATION_DEADLINE_MS = 5 * 60_000

const WEBHOOK_SECRET_BYTES = 32

async function advanceConfiguration(
	deps: SourceConnectionWorkflowDeps,
	initial: GitHubSetupAttempt,
	prepared?: { readonly bundle: string; readonly sha256: string },
	signal: AbortSignal = deps.request.signal,
): Promise<void> {
	let attempt = initial
	let credential = prepared
	if ((attempt.phase === 'recovery_stored' || attempt.phase === 'source_bundle_written') && credential === undefined) {
		credential = await readRecoveryCredential(deps, attempt)
	}
	if (attempt.phase === 'recovery_stored') {
		if (credential === undefined) throw new Error('setup recovery is unavailable')
		const activated = await deps.source.activate({
			connectionId: attempt.id,
			credentialBundle: credential.bundle,
			credentialSha256: credential.sha256,
			signal,
		})
		if (activated.connectionId !== attempt.id) throw new Error('source activation binding does not match setup')
		validateIdentity(attempt, activated.githubApp, credential.sha256, activated.credentialSha256)
		attempt = requiredCheckpoint(
			await deps.env.REPOSITORIES.githubConnections.checkpoint(
				attempt.id,
				attempt.version,
				'recovery_stored',
				'source_bundle_written',
				{ credentialSha256: credential.sha256 },
			),
		)
		attempt = requiredCheckpoint(
			await deps.env.REPOSITORIES.githubConnections.checkpoint(
				attempt.id,
				attempt.version,
				'source_bundle_written',
				'source_activated',
				{ appId: String(activated.githubApp.id), appSlug: activated.githubApp.slug, appHtmlUrl: activated.githubApp.htmlUrl },
			),
		)
	}
	if (attempt.phase === 'source_bundle_written') {
		if (credential === undefined) throw new Error('setup recovery is unavailable')
		const status = await deps.source.status({ connectionId: attempt.id, signal })
		if (status.state !== 'active') throw new Error('source activation is incomplete')
		validateIdentity(attempt, status.githubApp, credential.sha256, status.credentialSha256)
		attempt = requiredCheckpoint(
			await deps.env.REPOSITORIES.githubConnections.checkpoint(
				attempt.id,
				attempt.version,
				'source_bundle_written',
				'source_activated',
				{ appId: String(status.githubApp.id), appSlug: status.githubApp.slug, appHtmlUrl: status.githubApp.htmlUrl },
			),
		)
	}
	if (attempt.phase === 'source_activated') {
		const webhookSecret = randomToken(WEBHOOK_SECRET_BYTES, deps.randomBytes)
		const secretVault = await vault(deps.env)
		const preparedSecret = await secretVault.prepareSecret('platform', githubWebhookSecretLabel(attempt.id), webhookSecret)
		attempt = requiredCheckpoint(
			await deps.env.REPOSITORIES.githubConnections.storeSecretAndCheckpoint(
				attempt.id,
				attempt.version,
				'source_activated',
				'webhook_secret_stored',
				'webhook',
				preparedSecret,
			),
		)
	}
	if (attempt.phase === 'webhook_secret_stored') {
		if (attempt.webhookSecretRef === null || attempt.credentialSha256 === null) throw new Error('setup state is incomplete')
		const secretVault = await vault(deps.env)
		const webhookSecret = await secretVault.getSecretForPurpose(attempt.webhookSecretRef, {
			scope: 'platform',
			label: githubWebhookSecretLabel(attempt.id),
		})
		const configured = await deps.source.configureWebhook({
			connectionId: attempt.id,
			credentialSha256: attempt.credentialSha256,
			url: webhookUrl(attempt),
			secret: webhookSecret,
			signal,
		})
		if (
			configured.connectionId !== attempt.id || configured.credentialSha256 !== attempt.credentialSha256
			|| configured.webhook.url !== webhookUrl(attempt)
			|| configured.webhook.contentType !== 'json' || configured.webhook.insecureSsl !== '0'
		) throw new Error('webhook configuration binding does not match setup')
		attempt = requiredCheckpoint(
			await deps.env.REPOSITORIES.githubConnections.checkpoint(
				attempt.id,
				attempt.version,
				'webhook_secret_stored',
				'webhook_configured',
			),
		)
	}
	if (attempt.phase === 'webhook_configured') {
		if (attempt.credentialSha256 === null) throw new Error('setup state is incomplete')
		const status = await deps.source.status({ connectionId: attempt.id, signal })
		if (status.state !== 'active') throw new Error('source configuration is incomplete')
		validateIdentity(attempt, status.githubApp, attempt.credentialSha256, status.credentialSha256)
		attempt = requiredCheckpoint(
			await deps.env.REPOSITORIES.githubConnections.checkpoint(
				attempt.id,
				attempt.version,
				'webhook_configured',
				'configuration_verified',
			),
		)
	}
	if (attempt.phase === 'configuration_verified') {
		attempt = requiredCheckpoint(await deps.env.REPOSITORIES.githubConnections.discardRecoveryAndCheckpoint(attempt.id, attempt.version))
	}
}

export async function advanceWithDeadline(
	deps: SourceConnectionWorkflowDeps,
	attempt: GitHubSetupAttempt,
	prepared?: { readonly bundle: string; readonly sha256: string },
): Promise<void> {
	const deadline = linkedDeadline(deps.request.signal, CONFIGURATION_DEADLINE_MS)
	try {
		await advanceConfiguration(deps, attempt, prepared, deadline.signal)
	} finally {
		deadline.dispose()
	}
}

async function readRecoveryCredential(
	deps: SourceConnectionWorkflowDeps,
	attempt: GitHubSetupAttempt,
): Promise<{ readonly bundle: string; readonly sha256: string }> {
	if (attempt.recoverySecretRef === null) throw new Error('setup recovery is unavailable')
	const secretVault = await vault(deps.env)
	const bundle = await secretVault.getSecretForPurpose(attempt.recoverySecretRef, {
		scope: 'platform',
		label: githubRecoverySecretLabel(attempt.id),
	})
	return { bundle, sha256: await sha256(bundle) }
}

function validateIdentity(attempt: GitHubSetupAttempt, app: SourceGitHubAppIdentity, expectedDigest: string, actualDigest: string): void {
	if (
		!validRemoteIdentity(app) || actualDigest !== expectedDigest
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
	if (phase === 'recovery_stored' || phase === 'source_bundle_written') return 'credential_activation'
	if (phase === 'source_activated') return 'credential_persistence'
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
