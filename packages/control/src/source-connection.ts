import type { AuthContext } from '@fabrika/auth'
import type {
	GitHubSourceConnectionAppDto,
	GitHubSourceConnectionConnectedDto,
	GitHubSourceConnectionListInput,
	GitHubSourceConnectionListResponse,
	GitHubSourceConnectionSetupPendingDto,
	GitHubSourceConnectionStatusDto,
	GitHubSourceConnectionWorkflowDto,
	StartGitHubSourceConnectionRequest,
	StartGitHubSourceConnectionResponse,
} from '@fabrika/control-contract'
import { buildGitHubAppManifest, exchangeGitHubAppManifestCode, type GitHubAppFetch } from '@fabrika/github-app'
import { ACTIONS } from './actions'
import type { Env } from './env'
import {
	githubManifestStateSecretLabel,
	githubRecoverySecretLabel,
	type GitHubSetupAttempt,
	type GitHubSetupErrorCode,
	type GitHubSetupPhase,
	type GitHubSourceConnection,
	githubWebhookSecretLabel,
} from './github-connection-store'
import { controlPublicOrigin } from './iam'
import { vault } from './services'
import type { SourceConnectionPort, SourceGitHubAppIdentity, SourceInstallationScope } from './source-connection-port'
import { uuidv7 } from './uuid'

const CALLBACK_PATH = '/api/source/github/callback'
const MANIFEST_PATH = '/api/source/github/manifest'
const DASHBOARD_PATH = '/settings/source'
const SETUP_TTL_SECONDS = 10 * 60
const MAX_CONNECTION_ID_LENGTH = 128
const MAX_CALLBACK_QUERY_LENGTH = 1024
const RECOVERY_DEADLINE_MS = 30_000
const CONFIGURATION_DEADLINE_MS = 5 * 60_000
const FAILURE_SETTLE_ATTEMPTS = 10
const FAILURE_SETTLE_DELAY_MS = 25
const STATE_BYTES = 32
const WEBHOOK_SECRET_BYTES = 32

export interface SourceConnectionWorkflowDeps {
	readonly env: Env
	readonly source: SourceConnectionPort
	readonly auth: AuthContext
	readonly request: Request
	readonly now?: () => number
	readonly randomBytes?: (length: number) => Uint8Array
	readonly exchangeManifest?: typeof exchangeGitHubAppManifestCode
	readonly githubFetch?: GitHubAppFetch
}

export class SourceConnectionWorkflowError extends Error {
	readonly type = 'source_connection'

	constructor(readonly httpStatus: number, message = 'source connection request failed') {
		super(message)
		this.name = 'SourceConnectionWorkflowError'
	}
}

export async function sourceConnectionStatus(deps: SourceConnectionWorkflowDeps): Promise<GitHubSourceConnectionStatusDto> {
	requireHuman(deps.auth)
	const [compatibilityConnection, workflow] = await Promise.all([
		deps.env.REPOSITORIES.githubConnections.getConnection(),
		deps.env.REPOSITORIES.githubConnections.getWorkflowAttempt(),
	])
	let connection = compatibilityConnection
	if (workflow !== null) {
		const published = await deps.env.REPOSITORIES.githubConnections.getConnectionById(workflow.id)
		if (published === null) return workflowDto(deps.source.provider, workflow)
		connection = published
	}
	if (connection !== null) {
		try {
			const remote = await deps.source.status({
				connectionId: connection.connectionId,
				transportKind: connection.transportKind,
				signal: deps.request.signal,
			})
			if (
				remote.state !== 'active' || remote.credentialSha256 !== connection.credentialSha256
				|| remote.githubApp.id !== Number(connection.appId) || remote.githubApp.slug !== connection.appSlug
				|| remote.githubApp.htmlUrl !== connection.appHtmlUrl || remote.githubApp.public !== connection.appPublic
				|| remote.githubApp.owner.type !== 'Organization' || remote.githubApp.owner.login.toLowerCase() !== connection.appOwner.toLowerCase()
				|| remote.githubApp.permissions.contents !== 'read' || remote.githubApp.events.length !== 1 || remote.githubApp.events[0] !== 'push'
			) return baseStatus(deps.source.provider, 'unavailable')
			return connectionDto(deps.source.provider, connection)
		} catch {
			throwIfAborted(deps.request.signal)
			return baseStatus(deps.source.provider, 'unavailable')
		}
	}
	return inspectEmptySource(deps)
}

export async function sourceConnectionList(
	deps: SourceConnectionWorkflowDeps,
	input: GitHubSourceConnectionListInput,
): Promise<GitHubSourceConnectionListResponse> {
	requireHuman(deps.auth)
	const [page, workflow] = await Promise.all([
		deps.env.REPOSITORIES.githubConnections.listConnections(input),
		deps.env.REPOSITORIES.githubConnections.getWorkflowAttempt(),
	])
	const publishedWorkflowConnection = workflow === null
		? null
		: await deps.env.REPOSITORIES.githubConnections.getConnectionById(workflow.id)
	let projectedWorkflow: GitHubSourceConnectionWorkflowDto | null = workflow === null || publishedWorkflowConnection !== null
		? null
		: workflowDto(deps.source.provider, workflow)
	if (projectedWorkflow === null) {
		const hasConnections = publishedWorkflowConnection !== null || page.items.length > 0
			|| (input.cursor !== undefined && (await deps.env.REPOSITORIES.githubConnections.listConnections({ limit: 1 })).items.length > 0)
		if (!hasConnections) projectedWorkflow = await inspectEmptySource(deps)
	}
	return {
		items: page.items.map((connection) => connectionDto(deps.source.provider, connection)),
		nextCursor: page.nextCursor,
		workflow: projectedWorkflow,
	}
}

async function inspectEmptySource(deps: SourceConnectionWorkflowDeps): Promise<GitHubSourceConnectionWorkflowDto> {
	try {
		const inspection = await deps.source.inspect(deps.request.signal)
		if (inspection.state === 'anonymous') return baseStatus(deps.source.provider, 'anonymous')
		if (inspection.state === 'legacy-complete' || inspection.state === 'durable') return baseStatus(deps.source.provider, 'adoption-required')
		return baseStatus(deps.source.provider, 'unavailable')
	} catch {
		throwIfAborted(deps.request.signal)
		return baseStatus(deps.source.provider, 'unavailable')
	}
}

export async function adoptExistingSourceConnection(deps: SourceConnectionWorkflowDeps): Promise<GitHubSourceConnectionStatusDto> {
	const principalId = requireHuman(deps.auth)
	const origin = requireSameOrigin(deps.env, deps.request)
	const [existing, workflow] = await Promise.all([
		deps.env.REPOSITORIES.githubConnections.listConnections({ limit: 1 }),
		deps.env.REPOSITORIES.githubConnections.getWorkflowAttempt(),
	])
	if (existing.items.length > 0 || workflow !== null) throw new SourceConnectionWorkflowError(409)
	let activated: Awaited<ReturnType<SourceConnectionPort['adoptExisting']>>
	try {
		activated = await deps.source.adoptExisting({ signal: deps.request.signal })
	} catch {
		throwIfAborted(deps.request.signal)
		throw new SourceConnectionWorkflowError(409)
	}
	validateAdoptedIdentity(activated.githubApp)
	const connectionId = activated.connectionId
	const now = deps.now?.() ?? Math.floor(Date.now() / 1000)
	let attempt: GitHubSetupAttempt
	try {
		attempt = await deps.env.REPOSITORIES.githubConnections.beginAdoption({
			id: connectionId,
			initiatedBy: principalId,
			expectedOrigin: origin,
			appId: String(activated.githubApp.id),
			appSlug: activated.githubApp.slug,
			appHtmlUrl: activated.githubApp.htmlUrl,
			appOwner: activated.githubApp.owner.login,
			appPublic: activated.githubApp.public,
			credentialSha256: activated.credentialSha256,
			expiresAt: now + SETUP_TTL_SECONDS,
		})
	} catch {
		throw new SourceConnectionWorkflowError(409)
	}
	try {
		await advanceWithDeadline(deps, attempt)
	} catch {
		attempt = await deps.env.REPOSITORIES.githubConnections.getAttempt(connectionId) ?? attempt
		if (attempt.status === 'active') {
			await deps.env.REPOSITORIES.githubConnections.markRepairRequired(attempt.id, attempt.version, errorForPhase(attempt.phase)).catch(() => null)
		}
		throwIfAborted(deps.request.signal)
	}
	await audit(deps.auth, 'source.connection.adopt', connectionId)
	const current = await deps.env.REPOSITORIES.githubConnections.getAttempt(connectionId)
	if (current === null) throw new SourceConnectionWorkflowError(409)
	return workflowDto(deps.source.provider, current)
}

export async function startSourceConnection(
	deps: SourceConnectionWorkflowDeps,
	input: StartGitHubSourceConnectionRequest,
): Promise<StartGitHubSourceConnectionResponse> {
	const principalId = requireHuman(deps.auth)
	const origin = requireSameOrigin(deps.env, deps.request)
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(input.organization) || input.appName.length < 1 || input.appName.length > 100) {
		throw new SourceConnectionWorkflowError(400)
	}
	if (input.visibility !== 'private') throw new SourceConnectionWorkflowError(400)
	const owner = input.organization.toLowerCase()
	const repositories = canonicalRepositories(input.organization, input.repositories)
	const attemptId = uuidv7()
	buildManifest(owner, input.appName, origin, attemptId)
	const [existing, workflow, sameOwner] = await Promise.all([
		deps.env.REPOSITORIES.githubConnections.listConnections({ limit: 1 }),
		deps.env.REPOSITORIES.githubConnections.getWorkflowAttempt(),
		deps.env.REPOSITORIES.githubConnections.getConnectionByOwner(owner),
	])
	if (workflow !== null || sameOwner !== null) throw new SourceConnectionWorkflowError(409)
	if (existing.items.length === 0) {
		let inspection: Awaited<ReturnType<SourceConnectionPort['inspect']>>
		try {
			inspection = await deps.source.inspect(deps.request.signal)
		} catch {
			throwIfAborted(deps.request.signal)
			throw new SourceConnectionWorkflowError(503)
		}
		if (inspection.state === 'unavailable') throw new SourceConnectionWorkflowError(503)
		if (inspection.state !== 'anonymous') throw new SourceConnectionWorkflowError(409)
	}
	const state = randomToken(STATE_BYTES, deps.randomBytes)
	const stateHash = await sha256(state)
	const secretVault = await vault(deps.env)
	const prepared = await secretVault.prepareSecret('platform', githubManifestStateSecretLabel(attemptId), state)
	const now = deps.now?.() ?? Math.floor(Date.now() / 1000)
	try {
		await deps.env.REPOSITORIES.githubConnections.beginAttemptWithManifestState({
			id: attemptId,
			stateHash,
			initiatedBy: principalId,
			expectedOrigin: origin,
			desiredOwner: owner,
			desiredAppName: input.appName,
			desiredPublic: false,
			requestedRepositories: repositories.map((repository) => `${repository.owner}/${repository.name}`),
			expiresAt: now + SETUP_TTL_SECONDS,
		}, prepared)
	} catch {
		throw new SourceConnectionWorkflowError(409)
	}
	await audit(deps.auth, 'source.connection.start', attemptId)
	return { connectionId: attemptId, continuePath: `${MANIFEST_PATH}/${encodeURIComponent(attemptId)}` }
}

export async function manifestHandoff(deps: SourceConnectionWorkflowDeps, connectionId: string): Promise<Response> {
	const principalId = requireHuman(deps.auth)
	const origin = requireControlOrigin(deps.env)
	if (connectionId === '' || connectionId.length > MAX_CONNECTION_ID_LENGTH || new URL(deps.request.url).search !== '') {
		throw new SourceConnectionWorkflowError(400)
	}
	await deps.env.REPOSITORIES.githubConnections.reapExpiredAttempt()
	const current = await deps.env.REPOSITORIES.githubConnections.getAttempt(connectionId)
	if (
		current === null || current.status !== 'active' || current.phase !== 'awaiting_manifest_callback'
		|| current.initiatedBy !== principalId || current.expectedOrigin !== origin || current.manifestStateSecretRef === null
	) throw new SourceConnectionWorkflowError(404)
	const attempt = await deps.env.REPOSITORIES.githubConnections.renewManifestHandoff(
		current.id,
		current.version,
		principalId,
		origin,
		(deps.now?.() ?? Math.floor(Date.now() / 1000)) + SETUP_TTL_SECONDS,
	)
	if (attempt === null || attempt.manifestStateSecretRef === null || attempt.stateHash === null) {
		throw new SourceConnectionWorkflowError(409)
	}
	const secretVault = await vault(deps.env)
	let state: string
	try {
		state = await secretVault.getSecretForPurpose(attempt.manifestStateSecretRef, {
			scope: 'platform',
			label: githubManifestStateSecretLabel(attempt.id),
		})
	} catch {
		throw new SourceConnectionWorkflowError(409)
	}
	if (await sha256(state) !== attempt.stateHash) throw new SourceConnectionWorkflowError(409)
	const manifest = buildManifest(attempt.desiredOwner, attempt.desiredAppName, origin, attempt.id)
	const action = `https://github.com/organizations/${encodeURIComponent(attempt.desiredOwner)}/settings/apps/new?state=${encodeURIComponent(state)}`
	return secureHtml(manifestForm(action, JSON.stringify(manifest)))
}

export async function manifestCallback(deps: SourceConnectionWorkflowDeps): Promise<Response> {
	const principalId = requireHuman(deps.auth)
	const origin = requireControlOrigin(deps.env)
	const url = new URL(deps.request.url)
	if (url.search.length > MAX_CALLBACK_QUERY_LENGTH) throw new SourceConnectionWorkflowError(400)
	if ([...url.searchParams.keys()].some((key) => key !== 'state' && key !== 'code')) throw new SourceConnectionWorkflowError(400)
	const state = exactQueryValue(deps.request, 'state', 256)
	const code = exactQueryValue(deps.request, 'code', 256)
	if (state === null || code === null) throw new SourceConnectionWorkflowError(400)
	const stateHash = await sha256(state)
	const claimed = await deps.env.REPOSITORIES.githubConnections.claimCallback(stateHash, principalId)
	if (claimed === null || claimed.expectedOrigin !== origin) throw new SourceConnectionWorkflowError(409)

	let created: Awaited<ReturnType<typeof exchangeGitHubAppManifestCode>>
	try {
		created = await (deps.exchangeManifest ?? exchangeGitHubAppManifestCode)(code, {
			...(deps.githubFetch === undefined ? {} : { fetch: deps.githubFetch }),
			signal: deps.request.signal,
		})
	} catch {
		await deps.env.REPOSITORIES.githubConnections.markFailed(claimed.id, claimed.version, 'manifest_exchange').catch(() => null)
		throwIfAborted(deps.request.signal)
		throw new SourceConnectionWorkflowError(502)
	}

	let preparedCredential: Awaited<ReturnType<SourceConnectionPort['prepareCredential']>>
	try {
		const persistence = serverDeadline(RECOVERY_DEADLINE_MS)
		let stored: GitHubSetupAttempt | null
		try {
			preparedCredential = await abortable(
				deps.source.prepareCredential({ connectionId: claimed.id, appId: String(created.id), privateKeyPem: created.pem }),
				persistence.signal,
			)
			const secretVault = await abortable(vault(deps.env), persistence.signal)
			const recovery = await abortable(
				secretVault.prepareSecret('platform', githubRecoverySecretLabel(claimed.id), preparedCredential.bundle),
				persistence.signal,
			)
			stored = await abortable(
				deps.env.REPOSITORIES.githubConnections.storeSecretAndCheckpoint(
					claimed.id,
					claimed.version,
					'exchange_claimed',
					'recovery_stored',
					'recovery',
					recovery,
				),
				persistence.signal,
			)
		} finally {
			persistence.dispose()
		}
		if (stored === null) throw new Error('checkpoint failed')
		await advanceWithDeadline(deps, stored, preparedCredential)
	} catch {
		const disposition = await settleCallbackFailure(deps, claimed)
		throwIfAborted(deps.request.signal)
		if (disposition === 'failed') throw new SourceConnectionWorkflowError(503)
	}
	return cleanRedirect(DASHBOARD_PATH)
}

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
			transportKind: transportKind(attempt),
			credentialSha256: attempt.credentialSha256,
			scope,
			signal: deps.request.signal,
		})
	} catch {
		throwIfAborted(deps.request.signal)
		throw new SourceConnectionWorkflowError(502)
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
	try {
		await advanceWithDeadline(deps, resumed)
	} catch {
		const current = await deps.env.REPOSITORIES.githubConnections.getAttempt(resumed.id).catch(() => null)
		if (current !== null && current.status === 'active') {
			await deps.env.REPOSITORIES.githubConnections.markRepairRequired(current.id, current.version, errorForPhase(current.phase)).catch(() => null)
		}
		throwIfAborted(deps.request.signal)
	}
	await audit(deps.auth, 'source.connection.repair', attempt.id)
	const current = await deps.env.REPOSITORIES.githubConnections.getAttempt(attempt.id)
	if (current === null) throw new SourceConnectionWorkflowError(409)
	return workflowDto(deps.source.provider, current)
}

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
			transportKind: transportKind(attempt),
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
		const status = await deps.source.status({ connectionId: attempt.id, transportKind: transportKind(attempt), signal })
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
			transportKind: transportKind(attempt),
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
		const status = await deps.source.status({ connectionId: attempt.id, transportKind: transportKind(attempt), signal })
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
		attempt = attempt.setupKind === 'manifest'
			? requiredCheckpoint(await deps.env.REPOSITORIES.githubConnections.discardRecoveryAndCheckpoint(attempt.id, attempt.version))
			: requiredCheckpoint(
				await deps.env.REPOSITORIES.githubConnections.checkpoint(
					attempt.id,
					attempt.version,
					'configuration_verified',
					'installation_required',
				),
			)
	}
}

async function advanceWithDeadline(
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

function workflowDto(provider: string, attempt: GitHubSetupAttempt): GitHubSourceConnectionWorkflowDto {
	if (attempt.status === 'repair_required') {
		const app = attemptAppDto(attempt)
		return {
			provider,
			kind: 'github-app',
			state: 'repair-required',
			connectionId: attempt.id,
			reason: repairReason(attempt.lastErrorCode),
			...(app === null ? {} : { app }),
		}
	}
	if (attempt.status !== 'active') throw new SourceConnectionWorkflowError(500)
	if (attempt.phase === 'installation_required') {
		const app = attemptAppDto(attempt)
		if (app === null || attempt.appHtmlUrl === null) throw new SourceConnectionWorkflowError(500)
		return {
			provider,
			kind: 'github-app',
			state: 'installation-required',
			connectionId: attempt.id,
			app,
			installationUrl: `${attempt.appHtmlUrl}/installations/new`,
		}
	}
	if (attempt.phase === 'connected') throw new SourceConnectionWorkflowError(500)
	{
		const pending: GitHubSourceConnectionSetupPendingDto = {
			provider,
			kind: 'github-app',
			state: 'setup-pending',
			connectionId: attempt.id,
			phase: publicPhase(attempt.phase),
		}
		if (attempt.phase !== 'awaiting_manifest_callback') return pending
		return { ...pending, continuePath: `${MANIFEST_PATH}/${encodeURIComponent(attempt.id)}` }
	}
}

function connectionDto(provider: string, connection: GitHubSourceConnection): GitHubSourceConnectionConnectedDto {
	return {
		provider,
		kind: 'github-app',
		state: 'connected',
		connectionId: connection.connectionId,
		app: appDto(connection),
		installation: {
			id: connection.installationId,
			accountLogin: connection.installationAccountLogin,
			repositorySelection: connection.installationSelection,
			verifiedRepositories: connection.verifiedRepositories.map(splitRepository),
		},
	}
}

function baseStatus(provider: string, state: 'anonymous' | 'unavailable' | 'adoption-required'): GitHubSourceConnectionWorkflowDto {
	return { provider, kind: 'github-app', state }
}

function attemptAppDto(attempt: GitHubSetupAttempt): GitHubSourceConnectionAppDto | null {
	if (attempt.appId === null || attempt.appSlug === null || attempt.appHtmlUrl === null) return null
	return appDto({
		appId: attempt.appId,
		appSlug: attempt.appSlug,
		appHtmlUrl: attempt.appHtmlUrl,
		appPublic: attempt.desiredPublic,
		appOwner: attempt.desiredOwner,
	})
}

function appDto(state: {
	readonly appId: string
	readonly appSlug: string
	readonly appHtmlUrl: string
	readonly appPublic: boolean
	readonly appOwner: string
}): GitHubSourceConnectionAppDto {
	const id = Number(state.appId)
	if (!Number.isSafeInteger(id) || id <= 0) throw new SourceConnectionWorkflowError(500)
	return {
		id,
		slug: state.appSlug,
		htmlUrl: state.appHtmlUrl,
		public: state.appPublic,
		owner: { login: state.appOwner, type: 'Organization' },
		permissions: { contents: 'read' },
		events: ['push'],
	}
}

function validateIdentity(attempt: GitHubSetupAttempt, app: SourceGitHubAppIdentity, expectedDigest: string, actualDigest: string): void {
	if (
		!validRemoteIdentity(app) || actualDigest !== expectedDigest
		|| app.owner.type !== 'Organization' || app.owner.login.toLowerCase() !== attempt.desiredOwner.toLowerCase()
		|| app.public !== attempt.desiredPublic || app.permissions.contents !== 'read'
		|| app.events.length !== 1 || app.events[0] !== 'push'
	) throw new Error('verified App identity does not match setup')
}

function validateAdoptedIdentity(app: SourceGitHubAppIdentity): void {
	if (
		!validRemoteIdentity(app) || app.owner.type !== 'Organization' || app.permissions.contents !== 'read'
		|| app.events.length !== 1 || app.events[0] !== 'push'
	) throw new SourceConnectionWorkflowError(409)
}

function validRemoteIdentity(app: SourceGitHubAppIdentity): boolean {
	return Number.isSafeInteger(app.id) && app.id > 0
		&& /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(app.slug)
		&& app.htmlUrl === `https://github.com/apps/${app.slug}`
		&& /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(app.owner.login)
}

function publicPhase(phase: GitHubSetupPhase): 'starting' | 'awaiting-manifest-callback' | 'persisting' | 'activating' {
	if (phase === 'awaiting_manifest_callback') return 'awaiting-manifest-callback'
	if (phase === 'exchange_claimed') return 'starting'
	if (phase === 'recovery_stored' || phase === 'source_bundle_written') return 'persisting'
	return 'activating'
}

function repairReason(error: GitHubSetupErrorCode | null): 'interrupted-setup' | 'credential-activation' | 'installation-verification' {
	if (error === 'installation_verification') return 'installation-verification'
	if (error === 'credential_activation' || error === 'credential_persistence' || error === 'configuration_conflict') return 'credential-activation'
	return 'interrupted-setup'
}

function errorForPhase(phase: GitHubSetupPhase): GitHubSetupErrorCode {
	if (phase === 'recovery_stored' || phase === 'source_bundle_written') return 'credential_activation'
	if (phase === 'source_activated') return 'credential_persistence'
	if (phase === 'webhook_secret_stored' || phase === 'webhook_configured') return 'webhook_configuration'
	if (phase === 'installation_required') return 'installation_verification'
	return 'configuration_verification'
}

function transportKind(attempt: GitHubSetupAttempt): 'legacy-v1' | 'keyed-v2' {
	return attempt.setupKind === 'adoption' ? 'legacy-v1' : 'keyed-v2'
}

function webhookUrl(attempt: GitHubSetupAttempt): string {
	return attempt.setupKind === 'adoption'
		? `${attempt.expectedOrigin}/webhooks/github`
		: `${attempt.expectedOrigin}/webhooks/github/${encodeURIComponent(attempt.id)}`
}

function requireHuman(auth: AuthContext): string {
	if (!auth.can(ACTIONS.SOURCE_CONNECTION_MANAGE)) throw new SourceConnectionWorkflowError(403)
	if (auth.principal === null || auth.principal.type !== 'user') throw new SourceConnectionWorkflowError(403)
	return auth.principal.id
}

function requireSameOrigin(env: Env, request: Request): string {
	const expected = requireControlOrigin(env)
	const origin = request.headers.get('origin')
	if (origin !== expected) throw new SourceConnectionWorkflowError(403)
	return expected
}

function requireControlOrigin(env: Env): string {
	const expected = controlPublicOrigin(env)
	if (expected === undefined) throw new SourceConnectionWorkflowError(403)
	return expected
}

function exactQueryValue(request: Request, key: string, maxLength: number): string | null {
	const values = new URL(request.url).searchParams.getAll(key)
	if (values.length !== 1) return null
	const value = values[0]
	return value === undefined || value === '' || value.length > maxLength ? null : value
}

function canonicalRepositories(
	organization: string,
	repositories: readonly { readonly owner: string; readonly name: string }[],
): { readonly owner: string; readonly name: string }[] {
	const owner = organization.toLowerCase()
	const unique = new Map<string, { readonly owner: string; readonly name: string }>()
	for (const repository of repositories) {
		if (repository.owner.toLowerCase() !== owner) throw new SourceConnectionWorkflowError(400, 'repositories must belong to the App organization')
		if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(repository.owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repository.name)) {
			throw new SourceConnectionWorkflowError(400)
		}
		const normalized = { owner, name: repository.name.toLowerCase() }
		unique.set(`${normalized.owner}/${normalized.name}`, normalized)
	}
	return [...unique.values()].sort((left, right) => `${left.owner}/${left.name}`.localeCompare(`${right.owner}/${right.name}`))
}

function installationScope(attempt: GitHubSetupAttempt): SourceInstallationScope {
	if (attempt.requestedRepositories.length === 0) return { kind: 'organization', organization: attempt.desiredOwner }
	return { kind: 'repositories', repositories: attempt.requestedRepositories.map(splitRepository) }
}

function splitRepository(value: string): { readonly owner: string; readonly name: string } {
	const separator = value.indexOf('/')
	if (separator <= 0 || separator === value.length - 1) throw new SourceConnectionWorkflowError(500)
	return { owner: value.slice(0, separator), name: value.slice(separator + 1) }
}

async function requireAttempt(deps: SourceConnectionWorkflowDeps, id: string, phase: GitHubSetupPhase): Promise<GitHubSetupAttempt> {
	const attempt = await deps.env.REPOSITORIES.githubConnections.getAttempt(id)
	if (attempt === null || attempt.status !== 'active' || attempt.phase !== phase) {
		throw new SourceConnectionWorkflowError(404)
	}
	return attempt
}

function requiredCheckpoint(attempt: GitHubSetupAttempt | null): GitHubSetupAttempt {
	if (attempt === null) throw new Error('setup state changed')
	return attempt
}

function randomToken(length: number, source?: (length: number) => Uint8Array): string {
	const value = source?.(length) ?? crypto.getRandomValues(new Uint8Array(length))
	if (value.byteLength !== length) throw new SourceConnectionWorkflowError(500)
	let binary = ''
	for (const byte of value) binary += String.fromCharCode(byte)
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

async function sha256(value: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
	return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function manifestForm(action: string, manifest: string): string {
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Connect GitHub</title></head><body><form method="post" action="${
		html(action)
	}"><input type="hidden" name="manifest" value="${html(manifest)}"><button type="submit">Continue to GitHub</button></form></body></html>`
}

function buildManifest(organization: string, appName: string, origin: string, connectionId: string) {
	try {
		return buildGitHubAppManifest({
			organization,
			appName,
			homepageUrl: origin,
			webhookUrl: `${origin}/webhooks/github/${encodeURIComponent(connectionId)}`,
			redirectUrl: `${origin}${CALLBACK_PATH}`,
			public: false,
		})
	} catch {
		throw new SourceConnectionWorkflowError(400)
	}
}

async function settleCallbackFailure(
	deps: SourceConnectionWorkflowDeps,
	claimed: GitHubSetupAttempt,
): Promise<'failed' | 'repair_required'> {
	for (let attemptNumber = 0; attemptNumber < FAILURE_SETTLE_ATTEMPTS; attemptNumber++) {
		const current = await deps.env.REPOSITORIES.githubConnections.getAttempt(claimed.id).catch(() => undefined)
		if (current === undefined) {
			await delay(FAILURE_SETTLE_DELAY_MS)
			continue
		}
		if (current === null || current.status === 'failed') return 'failed'
		if (current.status === 'repair_required') return 'repair_required'
		if (current.status !== 'active') throw new SourceConnectionWorkflowError(503)
		if (current.recoverySecretRef !== null) {
			const repair = await deps.env.REPOSITORIES.githubConnections.markRepairRequired(
				current.id,
				current.version,
				errorForPhase(current.phase),
			).catch(() => null)
			if (repair !== null) return 'repair_required'
		} else {
			const failed = await deps.env.REPOSITORIES.githubConnections.markFailed(
				current.id,
				current.version,
				'credential_persistence',
			).catch(() => null)
			if (failed !== null) return 'failed'
		}
		await delay(FAILURE_SETTLE_DELAY_MS)
	}
	throw new SourceConnectionWorkflowError(503)
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function html(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

function secureHtml(body: string): Response {
	return new Response(body, {
		headers: {
			'cache-control': 'no-store',
			'content-security-policy': "default-src 'none'; form-action https://github.com; base-uri 'none'; frame-ancestors 'none'",
			'content-type': 'text/html; charset=utf-8',
			'referrer-policy': 'no-referrer',
			'x-content-type-options': 'nosniff',
		},
	})
}

function cleanRedirect(location: string): Response {
	return new Response(null, {
		status: 303,
		headers: {
			'cache-control': 'no-store',
			location,
			'referrer-policy': 'no-referrer',
		},
	})
}

function serverDeadline(timeoutMs: number): { readonly signal: AbortSignal; dispose(): void } {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), timeoutMs)
	return { signal: controller.signal, dispose: () => clearTimeout(timer) }
}

function linkedDeadline(caller: AbortSignal, timeoutMs: number): { readonly signal: AbortSignal; dispose(): void } {
	const controller = new AbortController()
	const abort = (): void => controller.abort()
	if (caller.aborted) controller.abort()
	else caller.addEventListener('abort', abort, { once: true })
	const timer = setTimeout(abort, timeoutMs)
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timer)
			caller.removeEventListener('abort', abort)
		},
	}
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(new DOMException('The source connection operation timed out', 'TimeoutError'))
	return new Promise((resolve, reject) => {
		const abort = (): void => reject(new DOMException('The source connection operation timed out', 'TimeoutError'))
		signal.addEventListener('abort', abort, { once: true })
		operation.then(
			(value) => {
				signal.removeEventListener('abort', abort)
				resolve(value)
			},
			(error: unknown) => {
				signal.removeEventListener('abort', abort)
				reject(error)
			},
		)
	})
}

async function audit(auth: AuthContext, action: string, resourceId: string): Promise<void> {
	await auth.audit({ action, resourceType: 'source_connection', resourceId })
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw new DOMException('The source connection request was aborted', 'AbortError')
}
