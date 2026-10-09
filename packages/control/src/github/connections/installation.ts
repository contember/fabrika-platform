import type { GitHubSourceConnectionStatusDto } from '@fabrika/control-contract'
import { vault } from '../../services'
import { advanceWithDeadline, CONFIGURATION_DEADLINE_MS, errorForPhase, matchesConnectionIdentity, webhookUrl } from './configuration'
import { audit, linkedDeadline, requireHuman, type SourceConnectionWorkflowDeps, throwIfAborted } from './context'
import { reconcileUnavailable, repairFailed, SourceConnectionWorkflowError, sourceUnavailable } from './errors'
import { type GitHubSetupAttempt, type GitHubSetupPhase } from './model'
import type { SourceGitHubAppIdentity, SourceInstallationScope, SourceInstallationVerification } from './port'
import { githubWebhookSecretLabel } from './secrets'
import { connectionDto, splitRepository, workflowDto } from './status'

export async function verifySourceInstallation(deps: SourceConnectionWorkflowDeps, connectionId: string): Promise<GitHubSourceConnectionStatusDto> {
	requireHuman(deps.auth)
	const attempt = await requireAttempt(deps, connectionId, 'installation_required')
	if (attempt.appCredentialRef === null) throw new SourceConnectionWorkflowError(409)
	const scope = installationScope(attempt)
	let verification: SourceInstallationVerification
	const deadline = linkedDeadline(deps.request.signal, CONFIGURATION_DEADLINE_MS)
	try {
		verification = await deps.source.verifyInstallations({
			credentialRef: attempt.appCredentialRef,
			connectionId: attempt.id,
			scope,
			signal: deadline.signal,
		})
	} catch (error) {
		throwIfAborted(deps.request.signal)
		throw sourceUnavailable(error)
	} finally {
		deadline.dispose()
	}
	if (verification.status === 'missing' || verification.accountLogin.toLowerCase() !== attempt.desiredOwner.toLowerCase()) {
		throw new SourceConnectionWorkflowError(409, 'GitHub App installation is incomplete')
	}
	const published = await deps.env.REPOSITORIES.githubConnections.publishConnection({
		attemptId: attempt.id,
		expectedVersion: attempt.version,
		webhookUrl: webhookUrl(attempt),
		installationId: verification.installationId,
		installationAccountLogin: verification.accountLogin,
		installationSelection: verification.repositorySelection,
		verifiedRepositories: attempt.requestedRepositories,
		verifiedAt: deps.now?.() ?? Math.floor(Date.now() / 1000),
	})
	if (published === null) throw new SourceConnectionWorkflowError(409)
	await audit(deps.auth, 'source.connection.connected', attempt.id)
	return connectionDto(deps.source.provider, published)
}

export async function repairSourceConnection(deps: SourceConnectionWorkflowDeps, connectionId: string): Promise<GitHubSourceConnectionStatusDto> {
	requireHuman(deps.auth)
	const attempt = await deps.env.REPOSITORIES.githubConnections.getAttempt(connectionId)
	if (attempt === null || attempt.status !== 'repair_required') {
		throw new SourceConnectionWorkflowError(404)
	}
	const resumed = await deps.env.REPOSITORIES.githubConnections.resumeRepair(attempt.id, attempt.version)
	if (resumed === null) throw new SourceConnectionWorkflowError(409)
	let failure: unknown
	try {
		await advanceWithDeadline(deps, resumed)
	} catch (error) {
		failure = error
		const current = await deps.env.REPOSITORIES.githubConnections.getAttempt(resumed.id).catch(() => null)
		if (current !== null && current.status === 'active') {
			await deps.env.REPOSITORIES.githubConnections.markRepairRequired(current.id, current.version, errorForPhase(current.phase)).catch(() => null)
		}
		throwIfAborted(deps.request.signal)
	}
	await audit(deps.auth, 'source.connection.repair', attempt.id)
	// A resume that changed nothing used to answer 200 with the same red lamp, which reads as success
	// to every caller and leaves the console with no reason to show.
	if (failure !== undefined) throw repairFailed(failure)
	const current = await deps.env.REPOSITORIES.githubConnections.getAttempt(attempt.id)
	if (current === null) throw new SourceConnectionWorkflowError(409)
	return workflowDto(deps.source.provider, current)
}

/** Re-verify one stable connection's App with its vault key and reapply its webhook; nothing about the binding changes. */
export async function reconcileSourceConnection(deps: SourceConnectionWorkflowDeps, connectionId: string): Promise<GitHubSourceConnectionStatusDto> {
	requireHuman(deps.auth)
	const connection = await deps.env.REPOSITORIES.githubConnections.getConnectionById(connectionId)
	if (connection === null) throw new SourceConnectionWorkflowError(404)
	const deadline = linkedDeadline(deps.request.signal, CONFIGURATION_DEADLINE_MS)
	try {
		const credential = { credentialRef: connection.appCredentialRef, connectionId: connection.connectionId, signal: deadline.signal }
		let app: SourceGitHubAppIdentity
		try {
			app = await deps.source.verifyApp(credential)
		} catch (error) {
			throwIfAborted(deps.request.signal)
			throw reconcileUnavailable('verify', error)
		}
		if (!matchesConnectionIdentity(connection, app)) {
			throw new SourceConnectionWorkflowError(409, 'the vault-held key belongs to a different GitHub App')
		}
		const secretVault = await vault(deps.env)
		const webhookSecret = await secretVault.getSecretForPurpose(connection.webhookSecretRef, {
			scope: 'platform',
			label: githubWebhookSecretLabel(connection.connectionId),
		})
		try {
			await deps.source.configureWebhook({ ...credential, url: connection.webhookUrl, secret: webhookSecret })
		} catch (error) {
			throwIfAborted(deps.request.signal)
			throw reconcileUnavailable('configure', error)
		}
	} finally {
		deadline.dispose()
	}
	await audit(deps.auth, 'source.connection.reconcile', connection.connectionId)
	return connectionDto(deps.source.provider, connection)
}

function installationScope(attempt: GitHubSetupAttempt): SourceInstallationScope {
	if (attempt.requestedRepositories.length === 0) return { kind: 'organization', organization: attempt.desiredOwner }
	return { kind: 'repositories', repositories: attempt.requestedRepositories.map(splitRepository) }
}

async function requireAttempt(deps: SourceConnectionWorkflowDeps, id: string, phase: GitHubSetupPhase): Promise<GitHubSetupAttempt> {
	const attempt = await deps.env.REPOSITORIES.githubConnections.getAttempt(id)
	if (attempt === null || attempt.status !== 'active' || attempt.phase !== phase) {
		throw new SourceConnectionWorkflowError(404)
	}
	return attempt
}
