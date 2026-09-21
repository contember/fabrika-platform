import type {
	GitHubSourceConnectionAppDto,
	GitHubSourceConnectionConnectedDto,
	GitHubSourceConnectionListInput,
	GitHubSourceConnectionListResponse,
	GitHubSourceConnectionSetupPendingDto,
	GitHubSourceConnectionStatusDto,
	GitHubSourceConnectionWorkflowDto,
} from '@fabrika/control-contract'
import { type GitHubSetupAttempt, type GitHubSetupErrorCode, type GitHubSetupPhase, type GitHubSourceConnection } from '../github-connection-store'
import { matchesConnectionIdentity } from './configuration'
import { requireHuman, type SourceConnectionWorkflowDeps, throwIfAborted } from './context'
import { SourceConnectionWorkflowError } from './errors'

export async function sourceConnectionStatus(deps: SourceConnectionWorkflowDeps): Promise<GitHubSourceConnectionStatusDto> {
	requireHuman(deps.auth)
	const [firstConnection, workflow] = await Promise.all([
		deps.env.REPOSITORIES.githubConnections.getConnection(),
		deps.env.REPOSITORIES.githubConnections.getWorkflowAttempt(),
	])
	let connection = firstConnection
	if (workflow !== null) {
		const published = await deps.env.REPOSITORIES.githubConnections.getConnectionById(workflow.id)
		if (published === null) return workflowDto(deps.source.provider, workflow)
		connection = published
	}
	if (connection !== null) {
		try {
			const remote = await deps.source.status({
				connectionId: connection.connectionId,
				signal: deps.request.signal,
			})
			if (
				remote.state !== 'active' || remote.credentialSha256 !== connection.credentialSha256 || !matchesConnectionIdentity(connection, remote.githubApp)
			) {
				return baseStatus(deps.source.provider, 'unavailable')
			}
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
		return baseStatus(deps.source.provider, inspection.state === 'anonymous' ? 'anonymous' : 'unavailable')
	} catch {
		throwIfAborted(deps.request.signal)
		return baseStatus(deps.source.provider, 'unavailable')
	}
}

export const MANIFEST_PATH = '/api/source/github/manifest'

export function workflowDto(provider: string, attempt: GitHubSetupAttempt): GitHubSourceConnectionWorkflowDto {
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

export function connectionDto(provider: string, connection: GitHubSourceConnection): GitHubSourceConnectionConnectedDto {
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

function baseStatus(provider: string, state: 'anonymous' | 'unavailable'): GitHubSourceConnectionWorkflowDto {
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

export function splitRepository(value: string): { readonly owner: string; readonly name: string } {
	const separator = value.indexOf('/')
	if (separator <= 0 || separator === value.length - 1) throw new SourceConnectionWorkflowError(500)
	return { owner: value.slice(0, separator), name: value.slice(separator + 1) }
}
