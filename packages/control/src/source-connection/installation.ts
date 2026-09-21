import type { GitHubSourceConnectionStatusDto } from '@fabrika/control-contract'
import { type GitHubSetupAttempt, type GitHubSetupPhase, githubWebhookSecretLabel } from '../github-connection-store'
import { vault } from '../services'
import type { SourceConnectionPort, SourceConnectionRuntimeStatus, SourceInstallationScope } from '../source-connection-port'
import { advanceWithDeadline, errorForPhase, matchesConnectionIdentity, webhookUrl } from './configuration'
import { audit, requireHuman, requireSameOrigin, type SourceConnectionWorkflowDeps, throwIfAborted } from './context'
import { reconcileUnavailable, repairFailed, SourceConnectionWorkflowError, sourceUnavailable } from './errors'
import { connectionDto, splitRepository, workflowDto } from './status'

export async function verifySourceInstallation(deps: SourceConnectionWorkflowDeps, connectionId: string): Promise<GitHubSourceConnectionStatusDto> {
	requireHuman(deps.auth)
	requireSameOrigin(deps.env, deps.request)
	const attempt = await requireAttempt(deps, connectionId, 'installation_required')
	if (attempt.credentialSha256 === null) throw new SourceConnectionWorkflowError(409)
	const scope = installationScope(attempt)
	let verification: Awaited<ReturnType<SourceConnectionPort['verifyInstallations']>>
	try {
		verification = await deps.source.verifyInstallations({
			connectionId: attempt.id,
			credentialSha256: attempt.credentialSha256,
			scope,
			signal: deps.request.signal,
		})
	} catch (error) {
		throwIfAborted(deps.request.signal)
		throw sourceUnavailable(error)
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
	requireSameOrigin(deps.env, deps.request)
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

/** Recover one stable connection from its verified durable credential and reapply its webhook binding. */
export async function reconcileSourceConnection(deps: SourceConnectionWorkflowDeps, connectionId: string): Promise<GitHubSourceConnectionStatusDto> {
	requireHuman(deps.auth)
	requireSameOrigin(deps.env, deps.request)
	const connection = await deps.env.REPOSITORIES.githubConnections.getConnectionById(connectionId)
	if (connection === null) throw new SourceConnectionWorkflowError(404)
	let status: SourceConnectionRuntimeStatus
	try {
		status = await deps.source.status({
			connectionId: connection.connectionId,
			signal: deps.request.signal,
		})
	} catch (error) {
		throwIfAborted(deps.request.signal)
		throw reconcileUnavailable('inspect', error)
	}
	if (status.state !== 'active') throw new SourceConnectionWorkflowError(409, 'the durable source credential is not active')
	if (!matchesConnectionIdentity(connection, status.githubApp)) {
		throw new SourceConnectionWorkflowError(409, 'the durable source credential belongs to a different GitHub App')
	}
	const secretVault = await vault(deps.env)
	const webhookSecret = await secretVault.getSecretForPurpose(connection.webhookSecretRef, {
		scope: 'platform',
		label: githubWebhookSecretLabel(connection.connectionId),
	})
	let configured: Awaited<ReturnType<SourceConnectionPort['configureWebhook']>>
	try {
		configured = await deps.source.configureWebhook({
			connectionId: connection.connectionId,
			credentialSha256: status.credentialSha256,
			url: connection.webhookUrl,
			secret: webhookSecret,
			signal: deps.request.signal,
		})
	} catch (error) {
		throwIfAborted(deps.request.signal)
		throw reconcileUnavailable('configure', error)
	}
	if (
		configured.connectionId !== connection.connectionId || configured.credentialSha256 !== status.credentialSha256
		|| configured.webhook.url !== connection.webhookUrl
		|| configured.webhook.contentType !== 'json' || configured.webhook.insecureSsl !== '0'
	) throw new SourceConnectionWorkflowError(503, 'the source service returned a mismatched webhook binding')
	let reconciled = connection
	if (status.credentialSha256 !== connection.credentialSha256) {
		const rebound = await deps.env.REPOSITORIES.githubConnections.rebindCredential(
			connection.connectionId,
			connection.version,
			connection.credentialSha256,
			status.credentialSha256,
		)
		if (rebound === null) {
			const current = await deps.env.REPOSITORIES.githubConnections.getConnectionById(connection.connectionId)
			if (current === null || current.credentialSha256 !== status.credentialSha256) {
				throw new SourceConnectionWorkflowError(409, 'the source connection changed while it was being reconciled')
			}
			reconciled = current
		} else {
			reconciled = rebound
		}
	}
	await audit(deps.auth, 'source.connection.reconcile', connection.connectionId)
	return connectionDto(deps.source.provider, reconciled)
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
