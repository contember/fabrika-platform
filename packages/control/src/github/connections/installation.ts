import type { AuthContext } from '@fabrika/auth'
import type { GitHubSetupOutcome, GitHubSourceConnectionStatusDto } from '@fabrika/control-contract'
import { vault } from '../../services'
import { consoleRedirect, handoffResult } from './browser'
import { advanceWithDeadline, CONFIGURATION_DEADLINE_MS, matchesConnectionIdentity, settleFailedStep, webhookUrl } from './configuration'
import { audit, linkedDeadline, requireHuman, type SourceConnectionRequestDeps, type SourceConnectionWorkflowDeps, throwIfAborted } from './context'
import { appOwnerFailed, reconcileUnavailable, repairFailed, SourceConnectionWorkflowError, sourceUnavailable } from './errors'
import { type GitHubSetupAttempt, type GitHubSetupPhase, type GitHubSourceConnection } from './model'
import type { SourceGitHubAppIdentity, SourceInstallationScope, SourceInstallationVerification } from './port'
import { githubWebhookSecretLabel } from './secrets'
import { connectionDto, splitRepository, workflowDto } from './status'

const MAX_CONNECTION_ID_LENGTH = 128

const MAX_SETUP_QUERY_LENGTH = 1024

export async function verifySourceInstallation(deps: SourceConnectionWorkflowDeps, connectionId: string): Promise<GitHubSourceConnectionStatusDto> {
	requireHuman(deps.auth)
	const attempt = await requireAttempt(deps, connectionId, 'installation_required')
	return connectionDto(deps.source.provider, await publishVerifiedInstallation(deps, deps.auth, attempt, null))
}

/**
 * GitHub's return to the App's setup URL after an install or an installation update. The query is a hint, never
 * evidence: anyone can send this URL with any `installation_id`. Control finds the installation itself with the App's
 * own key, exactly as the verify action does, and publishes only the connection named by the path. A query
 * `installation_id` that names another installation publishes nothing.
 */
export async function installationSetup(deps: SourceConnectionWorkflowDeps, connectionId: string): Promise<Response> {
	requireHuman(deps.auth)
	const outcome = await completeInstallationSetup(deps, deps.auth, connectionId, false)
	return consoleRedirect(outcome ?? undefined)
}

/**
 * The same return for an App whose manifest was posted through a handoff link, in the owner's browser, which has no
 * console session. It needs no caller because the setup URL never was evidence: the App's own key finds the
 * installation. It serves only an attempt an administrator minted a link for, and answers a page, not the console.
 */
export async function handedOffInstallationSetup(deps: SourceConnectionRequestDeps, connectionId: string): Promise<Response> {
	const outcome = await completeInstallationSetup(deps, null, connectionId, true)
	return handoffResult(outcome ?? 'setup-incomplete', deps.randomBytes)
}

async function completeInstallationSetup(
	deps: SourceConnectionRequestDeps,
	caller: AuthContext | null,
	connectionId: string,
	handedOff: boolean,
): Promise<GitHubSetupOutcome | null> {
	const url = new URL(deps.request.url)
	if (connectionId === '' || connectionId.length > MAX_CONNECTION_ID_LENGTH || url.search.length > MAX_SETUP_QUERY_LENGTH) {
		throw new SourceConnectionWorkflowError(400)
	}
	const setup = setupQuery(url.searchParams)
	const attempt = await deps.env.REPOSITORIES.githubConnections.getAttempt(connectionId)
	if (handedOff && (attempt === null || attempt.handoffTokenHash === null)) throw new SourceConnectionWorkflowError(404)
	if (await deps.env.REPOSITORIES.githubConnections.getConnectionById(connectionId) !== null) return 'connected'
	if (attempt === null) throw new SourceConnectionWorkflowError(404)
	if (attempt.status !== 'active' || attempt.phase !== 'installation_required') return null
	if (setup.action === 'request') return 'approval-requested'
	try {
		await publishVerifiedInstallation(deps, caller, attempt, setup.installationId)
	} catch (error) {
		throwIfAborted(deps.request.signal)
		if (!(error instanceof SourceConnectionWorkflowError)) throw error
		// A concurrent verify from the console may have published it first.
		const published = await deps.env.REPOSITORIES.githubConnections.getConnectionById(connectionId)
		return published === null ? 'unverified' : 'connected'
	}
	return 'connected'
}

type SetupQuery = { readonly action: 'install' | 'update'; readonly installationId: number } | { readonly action: 'request' }

/**
 * `request` is an installation an organization owner still has to approve (a personal account never sends it); GitHub
 * sends no installation id with it.
 */
function setupQuery(query: URLSearchParams): SetupQuery {
	const actions = query.getAll('setup_action')
	const installationIds = query.getAll('installation_id')
	const action = actions.length === 1 ? actions[0] : undefined
	if (action === 'request') return { action }
	if ((action === 'install' || action === 'update') && installationIds.length === 1) {
		const value = installationIds[0] ?? ''
		const installationId = /^[1-9][0-9]{0,15}$/.test(value) ? Number(value) : Number.NaN
		if (Number.isSafeInteger(installationId)) return { action, installationId }
	}
	throw new SourceConnectionWorkflowError(400)
}

/**
 * Find the attempt's installation with the App's vault key and publish it; `expected` must then name the same one. A
 * handed-off setup has no caller to audit as; the administrator's minting of the link is the audited act.
 */
async function publishVerifiedInstallation(
	deps: SourceConnectionRequestDeps,
	caller: AuthContext | null,
	attempt: GitHubSetupAttempt,
	expected: number | null,
): Promise<GitHubSourceConnection> {
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
	if (expected !== null && verification.installationId !== expected) {
		throw new SourceConnectionWorkflowError(409, 'GitHub returned from another installation of the App')
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
	if (caller !== null) await audit(caller, 'source.connection.connected', attempt.id)
	return published
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
	let settled: GitHubSetupAttempt | null = null
	try {
		await advanceWithDeadline(deps, resumed)
	} catch (error) {
		failure = error
		const current = await deps.env.REPOSITORIES.githubConnections.getAttempt(resumed.id).catch(() => null)
		if (current !== null && current.status === 'active') settled = await settleFailedStep(deps, current, error).catch(() => null)
		throwIfAborted(deps.request.signal)
	}
	await audit(deps.auth, 'source.connection.repair', attempt.id)
	// A resume that changed nothing used to answer 200 with the same red lamp, which reads as success
	// to every caller and leaves the console with no reason to show.
	// An App on another owner failed the attempt for good: say how to fix it, as the callback does. Only once the attempt
	// has failed, though; one a concurrent request moved is not over, and starting again would be the wrong advice.
	if (failure !== undefined) {
		throw (settled?.status === 'failed' ? appOwnerFailed(attempt.desiredOwner, failure) : undefined) ?? repairFailed(failure)
	}
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
	if (attempt.requestedRepositories.length === 0) return { kind: 'account', owner: attempt.desiredOwner, ownerType: attempt.desiredOwnerType }
	return { kind: 'repositories', repositories: attempt.requestedRepositories.map(splitRepository) }
}

async function requireAttempt(deps: SourceConnectionWorkflowDeps, id: string, phase: GitHubSetupPhase): Promise<GitHubSetupAttempt> {
	const attempt = await deps.env.REPOSITORIES.githubConnections.getAttempt(id)
	if (attempt === null || attempt.status !== 'active' || attempt.phase !== phase) {
		throw new SourceConnectionWorkflowError(404)
	}
	return attempt
}
