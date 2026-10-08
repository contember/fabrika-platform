// Git workspaces on an authoring target (ADR-0049). A workspace is the branch `fabrika/<id>`; Control
// stores its metadata and owner and performs every GitHub read and write through the app's GitHub connection. Every use case re-checks
// that the environment is still an authoring target and that the caller holds the action at its
// coordinates; anything denied, foreign or no longer authorable is a 404, like the run use cases.

import type { AuthContext } from '@fabrika/auth'
import type { RunDto, RunLogLine } from '@fabrika/control-contract'
import { uuidv7 } from '@fabrika/platform'
import type { ProviderSourceBinding } from '@fabrika/provider-contract'
import { ACTIONS } from '../actions'
import { type AppEnvRow, type AppRow, type ControlRepositories, SourceBindingError, type WorkspaceRow } from '../db'
import { parseGitHubRepo } from '../github/triggers/push-event'
import { WorkspaceSourceError, type WorkspaceSourcePort, type WorkspaceSourceTarget } from '../workspace-source-port'
import { ControlApiError, fail } from './domain'
import { canAtCoordinates, createManualRun, type DeployQueue, getRunLogUseCase, getRunUseCase, type LogReader, toRunDto } from './runs'

export const WORKSPACE_BRANCH_PREFIX = 'fabrika/'
export const DEPLOYMENT_LOG_TAIL_LINES = 200
const AUTHOR_NAME_MAX_LENGTH = 200
/** The bound on a commit message, trailers included. */
export const COMMIT_MESSAGE_MAX_BYTES = 8 * 1024

export interface WorkspaceUseCaseContext {
	readonly repositories: ControlRepositories
	readonly source: WorkspaceSourcePort
	readonly queue: DeployQueue
	readonly logs: LogReader
	readonly auth: AuthContext
	readonly signal: AbortSignal
}

export interface AuthoringTargetDto {
	appId: string
	env: string
	/** `owner/name` on GitHub. */
	repository: string
	defaultBranch: string
	publicOrigin: string | null
}

export interface WorkspaceSummaryDto {
	id: string
	appId: string
	env: string
	branch: string
	baseSha: string
	title: string
	createdAt: number
}

export interface WorkspaceDto extends WorkspaceSummaryDto {
	/** Live head of the branch; null when the branch no longer exists on GitHub. */
	headSha: string | null
	/** The newest deploy of this workspace's branch, if any. */
	latestRun: RunDto | null
}

export interface WorkspaceFileChange {
	path: string
	/** null deletes the file. */
	content: string | null
}

export interface DeploymentDto {
	run: RunDto
	/** The last lines of the build log, oldest first. */
	logTail: RunLogLine[]
}

interface AuthoringTarget {
	app: AppRow
	appEnv: AppEnvRow
	source: WorkspaceSourceTarget
}

interface OwnedWorkspace extends AuthoringTarget {
	workspace: WorkspaceRow
}

export async function listTargetsUseCase(c: WorkspaceUseCaseContext): Promise<{ items: AuthoringTargetDto[] }> {
	const items: AuthoringTargetDto[] = []
	for (const appEnv of await c.repositories.registry.listAuthoringAppEnvs()) {
		const target = await findAuthoringTarget(c, appEnv.app_id, appEnv.env, ACTIONS.SOURCE_WORKSPACE_READ)
		if (target === null) continue
		items.push({
			appId: target.app.id,
			env: target.appEnv.env,
			repository: `${target.source.owner}/${target.source.repository}`,
			defaultBranch: target.app.default_branch,
			publicOrigin: target.appEnv.public_origin,
		})
	}
	return { items }
}

export async function createWorkspaceUseCase(
	c: WorkspaceUseCaseContext,
	input: { appId: string; env: string; title: string },
): Promise<WorkspaceDto> {
	const ownerId = requireOwner(c.auth)
	const target = await findAuthoringTarget(c, input.appId, input.env, ACTIONS.SOURCE_WORKSPACE_WRITE)
	if (target === null) fail(404, 'authoring target not found')
	const baseSha = await sourceCall(() => c.source.readBranch({ target: target.source, branch: target.app.default_branch, signal: c.signal }))
	if (baseSha === null) fail(409, 'the default branch does not exist')
	const id = uuidv7()
	const branch = `${WORKSPACE_BRANCH_PREFIX}${id}`
	const headSha = await sourceCall(
		() => c.source.createBranch({ target: target.source, branch, fromSha: baseSha, signal: c.signal }),
		'the workspace branch already exists',
	)
	// A failed insert after this point leaves the new branch on GitHub with no workspace row referencing it.
	const workspace = await c.repositories.workspaces.createWorkspace({
		id,
		appId: input.appId,
		env: input.env,
		ownerId,
		branch,
		baseSha: headSha,
		title: input.title,
	})
	await c.auth.audit({
		action: 'source.workspace.create',
		resourceType: 'workspace',
		resourceId: id,
		metadata: { appId: input.appId, env: input.env, branch, baseSha: headSha },
	})
	return toWorkspaceDto(workspace, headSha, null)
}

/** Workspace metadata without the live head; `get_workspace` reads the head from GitHub. */
export async function listWorkspacesUseCase(
	c: WorkspaceUseCaseContext,
	input: { appId?: string; env?: string },
): Promise<{ items: WorkspaceSummaryDto[] }> {
	const ownerId = requireOwner(c.auth)
	const rows = await c.repositories.workspaces.listWorkspaces({
		ownerId,
		...(input.appId === undefined ? {} : { appId: input.appId }),
		...(input.env === undefined ? {} : { env: input.env }),
	})
	const items: WorkspaceSummaryDto[] = []
	for (const workspace of rows) {
		const target = await findAuthoringTarget(c, workspace.app_id, workspace.env, ACTIONS.SOURCE_WORKSPACE_READ)
		if (target !== null) items.push(toWorkspaceSummaryDto(workspace))
	}
	return { items }
}

export async function getWorkspaceUseCase(c: WorkspaceUseCaseContext, input: { workspaceId: string }): Promise<WorkspaceDto> {
	return describeWorkspace(c, await requireWorkspace(c, input.workspaceId, ACTIONS.SOURCE_WORKSPACE_READ))
}

export async function listFilesUseCase(
	c: WorkspaceUseCaseContext,
	input: { workspaceId: string; directory?: string; commitSha?: string },
) {
	const owned = await requireWorkspace(c, input.workspaceId, ACTIONS.SOURCE_WORKSPACE_READ)
	const commitSha = input.commitSha ?? await requireHead(c, owned)
	return sourceCall(() =>
		c.source.listTree({
			target: owned.source,
			commitSha,
			...(input.directory === undefined ? {} : { directory: input.directory }),
			signal: c.signal,
		})
	)
}

export async function readFilesUseCase(
	c: WorkspaceUseCaseContext,
	input: { workspaceId: string; paths: readonly string[]; commitSha?: string },
) {
	const owned = await requireWorkspace(c, input.workspaceId, ACTIONS.SOURCE_WORKSPACE_READ)
	const commitSha = input.commitSha ?? await requireHead(c, owned)
	return sourceCall(() => c.source.readFiles({ target: owned.source, commitSha, paths: input.paths, signal: c.signal }))
}

/** Commit one batch of changes on the workspace branch, only if its head is still `expectedHeadSha`. */
export async function applyChangesUseCase(
	c: WorkspaceUseCaseContext,
	input: { workspaceId: string; expectedHeadSha: string; message: string; changes: readonly WorkspaceFileChange[] },
): Promise<{ commitSha: string }> {
	const owned = await requireWorkspace(c, input.workspaceId, ACTIONS.SOURCE_WORKSPACE_WRITE)
	const protectedPaths = input.changes.map((change) => change.path).filter(isProtectedPath)
	if (protectedPaths.length > 0) {
		fail(403, `protected paths cannot be changed through a workspace: ${protectedPaths.join(', ')}`)
	}
	const principal = requirePrincipal(c.auth)
	const message = commitMessage(input.message, principal.id, c.auth.oauth?.clientId)
	if (new TextEncoder().encode(message).byteLength > COMMIT_MESSAGE_MAX_BYTES) fail(400, 'the commit message is too long')
	let commitSha: string
	try {
		commitSha = await c.source.commit({
			target: owned.source,
			branch: owned.workspace.branch,
			expectedHeadSha: input.expectedHeadSha,
			message,
			author: {
				name: (principal.label === '' ? principal.id : principal.label).slice(0, AUTHOR_NAME_MAX_LENGTH),
				email: `${principal.id}@users.noreply.fabrika`,
			},
			changes: input.changes,
			signal: c.signal,
		})
	} catch (cause) {
		if (cause instanceof WorkspaceSourceError && cause.kind === 'stale_head') {
			const headSha = await requireHead(c, owned)
			fail(409, `the workspace head moved to ${headSha}; re-read the files at that commit and retry with expectedHeadSha ${headSha}`)
		}
		throw sourceFailure(cause, 'the workspace branch changed in a conflicting way; re-read the workspace and retry')
	}
	await c.auth.audit({
		action: 'source.workspace.commit',
		resourceType: 'workspace',
		resourceId: owned.workspace.id,
		metadata: { appId: owned.workspace.app_id, env: owned.workspace.env, commitSha, paths: input.changes.length },
	})
	return { commitSha }
}

/** Deploy the live head of the workspace branch, pinned, to the authoring environment as an ordinary manual run. */
export async function deployStageUseCase(c: WorkspaceUseCaseContext, input: { workspaceId: string }): Promise<RunDto> {
	const owned = await requireWorkspace(c, input.workspaceId, ACTIONS.DEPLOY_TRIGGER)
	const commitSha = await requireHead(c, owned)
	return createManualRun(c, {
		appId: owned.workspace.app_id,
		env: owned.workspace.env,
		ref: `refs/heads/${owned.workspace.branch}`,
		commitSha,
	})
}

/** Only a run of one of the caller's own workspaces, on a target that is still authorable. */
export async function getDeploymentUseCase(c: WorkspaceUseCaseContext, input: { runId: string }): Promise<DeploymentDto> {
	const ownerId = requireOwner(c.auth)
	const row = await c.repositories.runs.getRun(input.runId)
	const branch = row?.ref.startsWith(`refs/heads/${WORKSPACE_BRANCH_PREFIX}`) ? row.ref.slice('refs/heads/'.length) : null
	const workspace = branch === null ? null : await c.repositories.workspaces.getWorkspaceByBranch(branch)
	if (
		row === null || workspace === null || workspace.owner_id !== ownerId || workspace.app_id !== row.app_id || workspace.env !== row.env
		|| await findAuthoringTarget(c, workspace.app_id, workspace.env, ACTIONS.DEPLOY_READ) === null
	) fail(404, 'run not found')
	const run = await getRunUseCase(c, input.runId)
	const log = await getRunLogUseCase(c, input.runId)
	return { run, logTail: log.lines.slice(-DEPLOYMENT_LOG_TAIL_LINES) }
}

export async function createPullRequestUseCase(
	c: WorkspaceUseCaseContext,
	input: { workspaceId: string; title: string; body: string },
): Promise<{ number: number; url: string; created: boolean }> {
	const owned = await requireWorkspace(c, input.workspaceId, ACTIONS.SOURCE_PULL_REQUEST_CREATE)
	const pullRequest = await sourceCall(() =>
		c.source.openPullRequest({
			target: owned.source,
			head: owned.workspace.branch,
			base: owned.app.default_branch,
			title: input.title,
			body: input.body,
			signal: c.signal,
		})
	)
	await c.auth.audit({
		action: 'source.pull-request.create',
		resourceType: 'workspace',
		resourceId: owned.workspace.id,
		metadata: { appId: owned.workspace.app_id, env: owned.workspace.env, number: pullRequest.number, created: pullRequest.created },
	})
	return { number: pullRequest.number, url: pullRequest.url, created: pullRequest.created }
}

/** Repository-relative with forward slashes: no leading slash, no empty, `.` or `..` segment, no control character. */
export function isRepositoryPath(path: string): boolean {
	return !path.startsWith('/') && !path.includes('\\')
		&& ![...path].some((character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f)
		&& path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/**
 * ADR-0049 D4: deployment configuration and CI are changed through normal review only — `zerops.yaml`
 * / `zerops.yml` at any depth, any `fabrika.*` file, and anything under `.github/`.
 */
export function isProtectedPath(path: string): boolean {
	const lower = path.toLowerCase()
	const name = lower.split('/').at(-1) ?? lower
	return name === 'zerops.yaml' || name === 'zerops.yml' || name.startsWith('fabrika.') || lower.startsWith('.github/')
}

function commitMessage(message: string, principalId: string, clientId: string | undefined): string {
	const trailers = [`Fabrika-Principal: ${principalId}`, ...(clientId === undefined ? [] : [`Fabrika-Client: ${clientId}`])]
	return `${message.trimEnd()}\n\n${trailers.join('\n')}`
}

/** The authoring target at the coordinates, or null when it is not one, is misconfigured, or is denied. */
async function findAuthoringTarget(c: WorkspaceUseCaseContext, appId: string, env: string, action: string): Promise<AuthoringTarget | null> {
	if (!canAtCoordinates(c.auth, action, appId, env)) return null
	const appEnv = await c.repositories.registry.getAppEnv(appId, env)
	if (appEnv === null || appEnv.authoring !== 1) return null
	const app = await c.repositories.registry.getApp(appId)
	if (app === null) return null
	let binding: ProviderSourceBinding | null
	try {
		binding = await c.repositories.registry.getSourceBinding(appId)
	} catch (cause) {
		if (cause instanceof SourceBindingError) return null
		throw cause
	}
	const repository = parseGitHubRepo(app.repo_url)
	if (binding === null || repository === null) return null
	return {
		app,
		appEnv,
		source: { connectionId: binding.connectionId, installationId: binding.installationId, owner: repository.owner, repository: repository.repo },
	}
}

async function requireWorkspace(c: WorkspaceUseCaseContext, workspaceId: string, action: string): Promise<OwnedWorkspace> {
	const ownerId = requireOwner(c.auth)
	const workspace = await c.repositories.workspaces.getWorkspace(workspaceId)
	if (workspace === null || workspace.owner_id !== ownerId) fail(404, 'workspace not found')
	const target = await findAuthoringTarget(c, workspace.app_id, workspace.env, action)
	if (target === null) fail(404, 'workspace not found')
	return { ...target, workspace }
}

async function requireHead(c: WorkspaceUseCaseContext, owned: OwnedWorkspace): Promise<string> {
	const headSha = await sourceCall(() => c.source.readBranch({ target: owned.source, branch: owned.workspace.branch, signal: c.signal }))
	if (headSha === null) fail(404, 'the workspace branch no longer exists')
	return headSha
}

async function describeWorkspace(c: WorkspaceUseCaseContext, owned: OwnedWorkspace): Promise<WorkspaceDto> {
	const headSha = await sourceCall(() => c.source.readBranch({ target: owned.source, branch: owned.workspace.branch, signal: c.signal }))
	const latestRun = await c.repositories.runs.getLatestRunForRef({
		appId: owned.workspace.app_id,
		env: owned.workspace.env,
		ref: `refs/heads/${owned.workspace.branch}`,
	})
	return toWorkspaceDto(owned.workspace, headSha, latestRun === null ? null : toRunDto(latestRun))
}

function toWorkspaceSummaryDto(row: WorkspaceRow): WorkspaceSummaryDto {
	return {
		id: row.id,
		appId: row.app_id,
		env: row.env,
		branch: row.branch,
		baseSha: row.base_sha,
		title: row.title,
		createdAt: row.created_at,
	}
}

function toWorkspaceDto(row: WorkspaceRow, headSha: string | null, latestRun: RunDto | null): WorkspaceDto {
	return { ...toWorkspaceSummaryDto(row), headSha, latestRun }
}

function requirePrincipal(auth: AuthContext) {
	const principal = auth.principal
	if (principal === null || principal.type !== 'user') fail(403, 'workspaces belong to a signed-in user')
	return principal
}

function requireOwner(auth: AuthContext): string {
	return requirePrincipal(auth).id
}

async function sourceCall<T>(operation: () => Promise<T>, conflictMessage = 'GitHub reported a conflict'): Promise<T> {
	try {
		return await operation()
	} catch (cause) {
		throw sourceFailure(cause, conflictMessage)
	}
}

/** Map a classified repository failure to a domain error; anything else propagates as an internal failure. */
function sourceFailure(cause: unknown, conflictMessage: string): unknown {
	if (!(cause instanceof WorkspaceSourceError)) return cause
	if (cause.kind === 'stale_head') return new ControlApiError(409, 'the workspace head moved; re-read the workspace and retry')
	if (cause.kind === 'not_found') return new ControlApiError(404, 'branch, commit or path not found')
	if (cause.kind === 'conflict') return new ControlApiError(409, conflictMessage)
	return new ControlApiError(502, 'GitHub is unavailable')
}
