// Git workspaces on an authoring target (ADR-0049). A workspace is the branch `fabrika/<id>`; Control
// stores its metadata and owner and performs every GitHub read and write through the app's GitHub connection. Every use case re-checks
// that the environment is still an authoring target and that the caller holds the action at its
// coordinates; anything denied, foreign or no longer authorable is a 404, like the run use cases.

import type { AuthContext } from '@fabrika/auth'
import { CONTRACT_FILE } from '@fabrika/check/contract'
import type { AppEnvKind, RunDto, RunLogLine } from '@fabrika/control-contract'
import { CONTROL_ACTIONS } from '@fabrika/control-contract'
import { uuidv7 } from '@fabrika/platform'
import type { ProviderSourceBinding } from '@fabrika/provider-contract'
import { parseClassification } from '../approval/publish'
import { type AppEnvRow, type AppRow, type ControlRepositories, SourceBindingError, type WorkspaceRow } from '../db'
import { logFailure } from '../error-label'
import { parseGitHubRepo } from '../github/triggers/push-event'
import {
	type WorkspaceChangedFile,
	WorkspaceSourceError,
	type WorkspaceSourcePort,
	type WorkspaceSourceSession,
	type WorkspaceSourceTarget,
	type WorkspaceTreeEntry,
	type WorkspaceUnreadableReason,
} from '../workspace-source-port'
import { ControlApiError, fail } from './domain'
import { canAtCoordinates, createManualRun, type DeployQueue, getRunLogUseCase, getRunUseCase, type LogReader, toRunDto } from './runs'

export const WORKSPACE_BRANCH_PREFIX = 'fabrika/'
export const DEPLOYMENT_LOG_DEFAULT_LINES = 30
export const DEPLOYMENT_LOG_MAX_LINES = 500
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
	/** The console's public origin, for the approval link of a parked run; absent leaves the link out. */
	readonly consoleOrigin?: string
}

export interface AuthoringTargetDto {
	appId: string
	env: string
	/** The environment's kind; an authoring target is always a stage environment, `standard`. */
	kind: AppEnvKind
	/** `owner/name` on GitHub. */
	repository: string
	defaultBranch: string
	publicOrigin: string | null
	/** What the environment runs now: its last successful deploy; null before the first one. */
	deployed: StageDeploymentDto | null
}

export interface StageDeploymentDto {
	runId: string
	commitSha: string | null
	finishedAt: number | null
	/** The workspace whose branch was deployed; null for a branch that is not a workspace's, such as the default branch. */
	workspaceId: string | null
	/** True when that workspace is the caller's own. */
	yours: boolean
}

export interface WorkspaceSummaryDto {
	id: string
	appId: string
	env: string
	branch: string
	baseSha: string
	title: string
	createdAt: number
	/** The pull request create_pull_request opened or found; it may since have been merged or closed on GitHub. */
	pullRequest: { number: number; url: string } | null
}

export interface WorkspaceDto extends WorkspaceSummaryDto {
	/** Live head of the branch; null when the branch no longer exists on GitHub. */
	headSha: string | null
	/** The newest deploy of this workspace's branch, if any. */
	latestRun: RunDto | null
	/** True when the stage environment runs this workspace now: its last successful deploy was of this branch. */
	onStage: boolean
}

/** The bound on one file's content, the GitHub repository client's own. */
export const WORKSPACE_FILE_MAX_BYTES = 512 * 1024

/** A whole-file write (`content` null deletes the file), or one exact replacement in the file at the expected head. */
export type WorkspaceFileChange = WorkspaceFileWrite | WorkspaceFileEdit

export interface WorkspaceFileWrite {
	path: string
	content: string | null
}

export interface WorkspaceFileEdit {
	path: string
	/** Must occur exactly once in the file as the edits before it on the same path left it. */
	oldString: string
	newString: string
}

export interface DeploymentDto {
	run: RunDto
	/** True once the run succeeded or failed; a parked run is not finished. */
	finished: boolean
	/** What the status means for the caller and what to do next, in one line. */
	summary: string
	log: DeploymentLogDto
	/** Present while the run waits for a person to approve its access change (ADR-0050); no MCP token can. */
	approval: DeploymentApprovalDto | null
	/**
	 * The lines of the run's access change that step off the paved road (declared reach, database code) and need a
	 * person's closer review, parked or not; empty before the run is classified.
	 */
	deviations: string[]
}

/**
 * One window of the build log, oldest first. `from` and `to` index the whole log, which only grows, filtered or not:
 * pass `to` as `after` to poll for new lines, `from` as `before` to page back.
 */
export type DeploymentLogDto = LogWindowDto<RunLogLine>

/** One window of a log that only grows; see `DeploymentLogDto`. */
export interface LogWindowDto<Line> {
	lines: Line[]
	from: number
	to: number
	total: number
}

export interface DeploymentLogQuery {
	/** The window's size; 0 answers the counts alone. */
	lines: number
	/** Lines from this index on, for polling; without it, the window ends at `before` or at the newest line. */
	after?: number
	before?: number
	/** Only stderr lines and lines that name an error or a failure. */
	failuresOnly: boolean
}

export interface DeploymentApprovalDto {
	/** The console page where a person with `access.approve` decides; null when the console origin is unknown. */
	url: string | null
	/** The plain-language lines of the change the approver reads. */
	changes: string[]
}

export interface AuthoringTarget {
	app: AppRow
	appEnv: AppEnvRow
	source: WorkspaceSourceTarget
}

export interface OwnedWorkspace extends AuthoringTarget {
	workspace: WorkspaceRow
}

export async function listTargetsUseCase(c: WorkspaceUseCaseContext): Promise<{ items: AuthoringTargetDto[] }> {
	const items: AuthoringTargetDto[] = []
	for (const appEnv of await c.repositories.registry.listAuthoringAppEnvs()) {
		const target = await findAuthoringTarget(c, appEnv.app_id, appEnv.env, CONTROL_ACTIONS.SOURCE_WORKSPACE_READ)
		if (target === null) continue
		items.push({
			appId: target.app.id,
			env: target.appEnv.env,
			kind: target.appEnv.kind,
			repository: `${target.source.owner}/${target.source.repository}`,
			defaultBranch: target.app.default_branch,
			publicOrigin: target.appEnv.public_origin,
			deployed: await stageDeployment(c, target.app.id, target.appEnv.env),
		})
	}
	return { items }
}

export async function createWorkspaceUseCase(
	c: WorkspaceUseCaseContext,
	input: { appId: string; env: string; title: string },
): Promise<WorkspaceDto> {
	const ownerId = requireOwner(c.auth)
	const target = await findAuthoringTarget(c, input.appId, input.env, CONTROL_ACTIONS.SOURCE_WORKSPACE_WRITE)
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
	return toWorkspaceDto(workspace, headSha, null, false)
}

/** The caller's workspaces with their live heads, read once per repository, and their latest stage deploys. */
export async function listWorkspacesUseCase(
	c: WorkspaceUseCaseContext,
	input: { appId?: string; env?: string },
): Promise<{ items: WorkspaceDto[] }> {
	const ownerId = requireOwner(c.auth)
	const rows = await c.repositories.workspaces.listWorkspaces({
		ownerId,
		...(input.appId === undefined ? {} : { appId: input.appId }),
		...(input.env === undefined ? {} : { env: input.env }),
	})
	const byTarget = new Map<string, { target: AuthoringTarget; workspaces: WorkspaceRow[] }>()
	for (const workspace of rows) {
		const key = `${workspace.app_id}\u0000${workspace.env}`
		const group = byTarget.get(key)
		if (group !== undefined) {
			group.workspaces.push(workspace)
			continue
		}
		const target = await findAuthoringTarget(c, workspace.app_id, workspace.env, CONTROL_ACTIONS.SOURCE_WORKSPACE_READ)
		if (target !== null) byTarget.set(key, { target, workspaces: [workspace] })
	}
	const heads = new Map<string, string | null>()
	const onStage = new Set<string>()
	for (const { target, workspaces } of byTarget.values()) {
		const branches = workspaces.map((workspace) => workspace.branch)
		const read = await sourceCall(() => c.source.readBranches({ target: target.source, branches, signal: c.signal }))
		for (const [index, branch] of branches.entries()) heads.set(branch, read[index] ?? null)
		const deployed = await stageDeployment(c, target.app.id, target.appEnv.env)
		if (deployed !== null && deployed.workspaceId !== null) onStage.add(deployed.workspaceId)
	}
	const items: WorkspaceDto[] = []
	for (const workspace of rows) {
		if (!heads.has(workspace.branch)) continue
		const headSha = heads.get(workspace.branch) ?? null
		items.push(toWorkspaceDto(workspace, headSha, await latestRunOf(c, workspace), onStage.has(workspace.id)))
	}
	return { items }
}

export async function getWorkspaceUseCase(c: WorkspaceUseCaseContext, input: { workspaceId: string }): Promise<WorkspaceDto> {
	return describeWorkspace(c, await requireWorkspace(c, input.workspaceId, CONTROL_ACTIONS.SOURCE_WORKSPACE_READ))
}

export const LIST_FILES_DEFAULT_LIMIT = 500
export const LIST_FILES_MAX_LIMIT = 5000

export interface WorkspaceListingDto {
	commitSha: string
	entries: WorkspaceTreeEntry[]
	/** The repository listing itself was cut short; name a directory to see past it. */
	truncated: boolean
	/** Pass as `offset` for the next page; null on the last one. */
	nextOffset: number | null
}

/** One page of the entries under `directory`, at most `depth` levels below it. */
export async function listFilesUseCase(
	c: WorkspaceUseCaseContext,
	input: { workspaceId: string; directory?: string; commitSha?: string; depth?: number; offset: number; limit: number },
): Promise<WorkspaceListingDto> {
	const owned = await requireWorkspace(c, input.workspaceId, CONTROL_ACTIONS.SOURCE_WORKSPACE_READ)
	const commitSha = input.commitSha ?? await requireHead(c, owned)
	const tree = await sourceCall(() =>
		c.source.listTree({
			target: owned.source,
			commitSha,
			...(input.directory === undefined ? {} : { directory: input.directory }),
			signal: c.signal,
		})
	)
	const base = input.directory === undefined ? 0 : input.directory.split('/').length
	const { depth } = input
	const entries = depth === undefined ? tree.entries : tree.entries.filter((entry) => entry.path.split('/').length - base <= depth)
	const end = input.offset + input.limit
	return {
		commitSha: tree.commitSha,
		entries: entries.slice(input.offset, end),
		truncated: tree.truncated,
		nextOffset: end < entries.length ? end : null,
	}
}

export async function readFilesUseCase(
	c: WorkspaceUseCaseContext,
	input: { workspaceId: string; paths: readonly string[]; commitSha?: string },
) {
	const owned = await requireWorkspace(c, input.workspaceId, CONTROL_ACTIONS.SOURCE_WORKSPACE_READ)
	const commitSha = input.commitSha ?? await requireHead(c, owned)
	return sourceCall(() => c.source.readFiles({ target: owned.source, commitSha, paths: input.paths, signal: c.signal }))
}

const DIFF_PATCH_MAX_BYTES = 32 * 1024
const DIFF_PATCHES_MAX_BYTES = 256 * 1024

export interface WorkspaceDiffFileDto {
	path: string
	previousPath: string | null
	status: WorkspaceChangedFile['status']
	additions: number
	deletions: number
	/** Present when patches were asked for; null when it was omitted, and `incomplete` says why. */
	patch?: string | null
}

export interface WorkspaceDiffDto {
	/** The workspace's base: the default branch head it was created from. */
	baseSha: string
	headSha: string
	commitsAhead: number
	files: WorkspaceDiffFileDto[]
	/** Why the answer may be incomplete; empty when it is complete. */
	incomplete: string[]
}

/**
 * What the workspace changed since its base, from the live head. Patches are bounded per file and in total; `paths`
 * narrows which files carry one.
 */
export async function getWorkspaceDiffUseCase(
	c: WorkspaceUseCaseContext,
	input: { workspaceId: string; includePatches: boolean; paths?: readonly string[] },
): Promise<WorkspaceDiffDto> {
	const owned = await requireWorkspace(c, input.workspaceId, CONTROL_ACTIONS.SOURCE_WORKSPACE_READ)
	const headSha = await requireHead(c, owned)
	const comparison = await sourceCall(() => c.source.compare({ target: owned.source, baseSha: owned.workspace.base_sha, headSha, signal: c.signal }))
	const incomplete: string[] = []
	if (comparison.filesCapped) incomplete.push(`GitHub lists at most ${comparison.files.length} changed files; more may have changed`)
	const wanted = input.paths === undefined ? null : new Set(input.paths)
	let remainingBytes = DIFF_PATCHES_MAX_BYTES
	const omitted: string[] = []
	const files = comparison.files.map((file): WorkspaceDiffFileDto => {
		const summary = {
			path: file.path,
			previousPath: file.previousPath,
			status: file.status,
			additions: file.additions,
			deletions: file.deletions,
		}
		if (!input.includePatches || (wanted !== null && !wanted.has(file.path))) return summary
		const bytes = file.patch === null ? 0 : new TextEncoder().encode(file.patch).byteLength
		if (file.patch !== null && bytes <= DIFF_PATCH_MAX_BYTES && bytes <= remainingBytes) {
			remainingBytes -= bytes
			return { ...summary, patch: file.patch }
		}
		omitted.push(file.path)
		return { ...summary, patch: null }
	})
	if (omitted.length > 0) {
		incomplete.push(
			`no patch for ${omitted.join(', ')}: GitHub gave none (binary or very large), it is over 32 KiB, or the patches `
				+ 'reached 256 KiB together; read the file, or ask for fewer paths',
		)
	}
	return { baseSha: owned.workspace.base_sha, headSha, commitsAhead: comparison.aheadBy, files, incomplete }
}

/** At most this many files are read for one text search: the GitHub client's bound on one blob read. */
export const SEARCH_MAX_FILES = 100
export const SEARCH_MAX_RESULTS = 200
const SEARCH_LINE_MAX_CHARACTERS = 240

export interface WorkspaceSearchInput {
	workspaceId: string
	commitSha?: string
	directory?: string
	/** Matched against the whole repository path with `Bun.Glob`; `**` crosses directories, `*` does not. */
	glob?: string
	/** A literal string, never a pattern: a regular expression could hold Control's event loop. */
	text?: string
	caseSensitive?: boolean
	maxResults: number
}

export interface WorkspaceSearchDto {
	commitSha: string
	/** Without `text`: the file paths the glob matched. */
	paths: string[]
	/** With `text`: the matching lines, 1-based, each cut to 240 characters around the match. */
	matches: { path: string; line: number; text: string }[]
	/** Why the answer may be incomplete; empty when it is complete. */
	incomplete: string[]
}

/**
 * Search the workspace at a commit through the repository's own tree and blobs: by path glob alone, or for a literal
 * text in the files the glob and directory admit. Every bound that cuts the answer short is named in `incomplete`.
 */
export async function searchFilesUseCase(c: WorkspaceUseCaseContext, input: WorkspaceSearchInput): Promise<WorkspaceSearchDto> {
	const owned = await requireWorkspace(c, input.workspaceId, CONTROL_ACTIONS.SOURCE_WORKSPACE_READ)
	if (input.glob === undefined && input.text === undefined) fail(400, 'name a glob, a text, or both')
	const commitSha = input.commitSha ?? await requireHead(c, owned)
	const glob = input.glob === undefined ? null : new Bun.Glob(input.glob)
	const include = (path: string) => glob === null || glob.match(path)
	const directory = input.directory === undefined ? {} : { directory: input.directory }
	const incomplete: string[] = []
	if (input.text === undefined) {
		const tree = await sourceCall(() => c.source.listTree({ target: owned.source, commitSha, ...directory, signal: c.signal }))
		const paths = tree.entries.filter((entry) => entry.kind === 'file' && include(entry.path)).map((entry) => entry.path)
		if (tree.truncated) incomplete.push(TREE_TRUNCATED)
		if (paths.length > input.maxResults) incomplete.push(`${paths.length} paths matched; only the first ${input.maxResults} are listed`)
		return { commitSha: tree.commitSha, paths: paths.slice(0, input.maxResults), matches: [], incomplete }
	}
	const scan = await sourceCall(() =>
		c.source.scanFiles({ target: owned.source, commitSha, ...directory, include, maxFiles: SEARCH_MAX_FILES, signal: c.signal })
	)
	if (scan.treeTruncated) incomplete.push(TREE_TRUNCATED)
	if (scan.candidates > scan.files.length) {
		incomplete.push(`only the first ${scan.files.length} of ${scan.candidates} files were searched; narrow the glob or the directory`)
	}
	for (const [reason, why] of UNSEARCHED) {
		const skipped = scan.files.filter((file) => file.content === null && file.reason === reason).length
		if (skipped > 0) incomplete.push(`${skipped} files were not searched: ${why}`)
	}
	const needle = input.caseSensitive === false ? input.text.toLowerCase() : input.text
	const matches: WorkspaceSearchDto['matches'] = []
	for (const file of scan.files) {
		if (file.content === null) continue
		for (const [index, line] of file.content.split('\n').entries()) {
			const at = (input.caseSensitive === false ? line.toLowerCase() : line).indexOf(needle)
			if (at === -1) continue
			if (matches.length === input.maxResults) {
				incomplete.push(`matches stop at maxResults (${input.maxResults})`)
				return { commitSha: scan.commitSha, paths: [], matches, incomplete }
			}
			matches.push({ path: file.path, line: index + 1, text: lineAround(line, at) })
		}
	}
	return { commitSha: scan.commitSha, paths: [], matches, incomplete }
}

const TREE_TRUNCATED = 'the repository tree has more entries than one listing returns; name a directory'

const UNSEARCHED: readonly [WorkspaceUnreadableReason, string][] = [
	['too_large', 'they are over 512 KiB'],
	['budget', 'the files searched reached 2 MiB together; narrow the glob or the directory'],
]

function lineAround(line: string, at: number): string {
	if (line.length <= SEARCH_LINE_MAX_CHARACTERS) return line
	const start = Math.max(0, Math.min(at - SEARCH_LINE_MAX_CHARACTERS / 3, line.length - SEARCH_LINE_MAX_CHARACTERS))
	return line.slice(start, start + SEARCH_LINE_MAX_CHARACTERS)
}

/** Commit one batch of changes on the workspace branch, only if its head is still `expectedHeadSha`. */
export async function applyChangesUseCase(
	c: WorkspaceUseCaseContext,
	input: { workspaceId: string; expectedHeadSha: string; message: string; changes: readonly WorkspaceFileChange[] },
): Promise<{ commitSha: string; written: WorkspaceFileWrite[]; warning: string | null }> {
	const owned = await requireWorkspace(c, input.workspaceId, CONTROL_ACTIONS.SOURCE_WORKSPACE_WRITE)
	const protectedPaths = [...new Set(input.changes.map((change) => change.path))].filter(isProtectedPath)
	if (protectedPaths.length > 0) {
		fail(403, `protected paths cannot be changed through a workspace: ${protectedPaths.join(', ')}`)
	}
	const principal = requirePrincipal(c.auth)
	const message = commitMessage(input.message, principal.id, c.auth.oauth?.clientId)
	if (new TextEncoder().encode(message).byteLength > COMMIT_MESSAGE_MAX_BYTES) fail(400, 'the commit message is too long')
	const author = {
		name: (principal.label === '' ? principal.id : principal.label).slice(0, AUTHOR_NAME_MAX_LENGTH),
		email: `${principal.id}@users.noreply.fabrika`,
	}
	// One session reads the edited files and commits: one token, and the head's commit and trees read once.
	const committed = await sourceCall(() =>
		c.source.session({ target: owned.source, signal: c.signal }, async (source) => {
			const changes = await resolveChanges(source, input.expectedHeadSha, input.changes)
			try {
				const sha = await source.commit({ branch: owned.workspace.branch, expectedHeadSha: input.expectedHeadSha, message, author, changes })
				return { sha, changes }
			} catch (cause) {
				if (cause instanceof WorkspaceSourceError && cause.kind === 'stale_head') {
					const headSha = await requireHead(c, owned)
					fail(409, `the workspace head moved to ${headSha}; re-read the files at that commit and retry with expectedHeadSha ${headSha}`)
				}
				throw sourceFailure(cause, 'the workspace branch changed in a conflicting way; re-read the workspace and retry')
			}
		})
	)
	const commitSha = committed.sha
	// The commit persisted, so a failed audit write is answered beside it rather than as a failed call.
	const warning = await c.auth.audit({
		action: 'source.workspace.commit',
		resourceType: 'workspace',
		resourceId: owned.workspace.id,
		metadata: { appId: owned.workspace.app_id, env: owned.workspace.env, commitSha, paths: committed.changes.length },
	}).then(
		() => null,
		(cause: unknown) => {
			const reference = logFailure('apply_changes: the audit entry of a persisted commit', cause)
			return `The commit persisted, but Control could not record its audit entry; tell the operator and quote reference ${reference}.`
		},
	)
	return { commitSha, written: committed.changes, warning }
}

/**
 * Turn the changes into one whole-file write per path. Edits read their file at the expected head and apply in order,
 * each refused unless its `oldString` occurs exactly once; a path written whole appears in no other change.
 */
async function resolveChanges(
	source: WorkspaceSourceSession,
	expectedHeadSha: string,
	changes: readonly WorkspaceFileChange[],
): Promise<WorkspaceFileWrite[]> {
	const writes = new Map<string, WorkspaceFileWrite>()
	const edits = new Map<string, { change: WorkspaceFileEdit; index: number }[]>()
	for (const [index, change] of changes.entries()) {
		if (writes.has(change.path) || ('content' in change && edits.has(change.path))) {
			fail(400, `${change.path} is written whole and changed again in the same batch; send one change for it`)
		}
		if ('content' in change) writes.set(change.path, { path: change.path, content: change.content })
		else edits.set(change.path, [...(edits.get(change.path) ?? []), { change, index }])
	}
	if (edits.size === 0) return [...writes.values()]
	const read = await sourceCall(() => source.readFiles({ commitSha: expectedHeadSha, paths: [...edits.keys()] }))
	for (const file of read.files) {
		if (file.content === null) {
			fail(409, `cannot edit ${file.path} at ${expectedHeadSha}: ${UNEDITABLE[file.reason]}`)
		}
		let content = file.content
		for (const { change, index } of edits.get(file.path) ?? []) {
			content = replaceOnce(content, change, index, expectedHeadSha)
		}
		if (new TextEncoder().encode(content).byteLength > WORKSPACE_FILE_MAX_BYTES) {
			fail(400, `${file.path} would exceed 512 KiB after the edit`)
		}
		writes.set(file.path, { path: file.path, content })
	}
	return [...new Set(changes.map((change) => change.path))].flatMap((path) => {
		const write = writes.get(path)
		return write === undefined ? [] : [write]
	})
}

const UNEDITABLE: Record<WorkspaceUnreadableReason, string> = {
	missing: 'the file does not exist; write it whole with content',
	not_a_file: 'the path is not a regular file',
	too_large: 'the file is over 512 KiB',
	binary: 'the file is not UTF-8 text',
	budget: 'the files to edit exceed 2 MiB together; split the edits into several calls',
}

function replaceOnce(content: string, edit: WorkspaceFileEdit, index: number, expectedHeadSha: string): string {
	const first = content.indexOf(edit.oldString)
	if (first === -1) {
		fail(409, `oldString of changes[${index}] does not occur in ${edit.path} at ${expectedHeadSha}; re-read the file and retry`)
	}
	if (content.indexOf(edit.oldString, first + 1) !== -1) {
		fail(409, `oldString of changes[${index}] occurs more than once in ${edit.path}; include more of the surrounding text so it occurs once`)
	}
	return content.slice(0, first) + edit.newString + content.slice(first + edit.oldString.length)
}

/** Deploy the live head of the workspace branch, pinned, to the authoring environment as an ordinary manual run. */
export async function deployStageUseCase(c: WorkspaceUseCaseContext, input: { workspaceId: string }): Promise<RunDto> {
	const owned = await requireWorkspace(c, input.workspaceId, CONTROL_ACTIONS.DEPLOY_TRIGGER)
	const commitSha = await requireHead(c, owned)
	return createManualRun(c, {
		appId: owned.workspace.app_id,
		env: owned.workspace.env,
		ref: `refs/heads/${owned.workspace.branch}`,
		commitSha,
	})
}

/** Only a run of one of the caller's own workspaces, on a target that is still authorable. */
export async function getDeploymentUseCase(
	c: WorkspaceUseCaseContext,
	input: { runId: string; log: DeploymentLogQuery },
): Promise<DeploymentDto> {
	const ownerId = requireOwner(c.auth)
	const row = await c.repositories.runs.getRun(input.runId)
	const branch = row?.ref.startsWith(`refs/heads/${WORKSPACE_BRANCH_PREFIX}`) ? row.ref.slice('refs/heads/'.length) : null
	const workspace = branch === null ? null : await c.repositories.workspaces.getWorkspaceByBranch(branch)
	if (
		row === null || workspace === null || workspace.owner_id !== ownerId || workspace.app_id !== row.app_id
		|| (workspace.env !== row.env && !await isDevEnvironment(c, row.app_id, row.env))
		|| !canAtCoordinates(c.auth, CONTROL_ACTIONS.DEPLOY_READ, row.app_id, row.env)
		|| await findAuthoringTarget(c, workspace.app_id, workspace.env, CONTROL_ACTIONS.DEPLOY_READ) === null
	) fail(404, 'run not found')
	const run = await getRunUseCase(c, input.runId)
	const log = await getRunLogUseCase(c, input.runId)
	const changes = row.classification_json === null ? [] : parseClassification(row.classification_json).changes
	const approval = row.status === 'awaiting_approval' && row.classification_json !== null
		? {
			url: c.consoleOrigin === undefined ? null : `${c.consoleOrigin}/approvals/${encodeURIComponent(row.id)}`,
			changes: changes.map((change) => change.line),
		}
		: null
	const deviations = changes.filter((change) => change.review === 'closer').map((change) => change.line)
	const finished = run.status === 'succeeded' || run.status === 'failed'
	return {
		run,
		finished,
		summary: deploymentSummary(run, row.env === workspace.env ? 'stage' : 'dev'),
		log: logWindow(log.lines, input.log),
		approval,
		deviations,
	}
}

/** A workspace's runs are its stage deploys and the bootstrap runs of its application's dev environment. */
async function isDevEnvironment(c: WorkspaceUseCaseContext, appId: string, env: string): Promise<boolean> {
	return (await c.repositories.registry.getAppEnv(appId, env))?.kind === 'dev'
}

function deploymentSummary(run: RunDto, environment: 'stage' | 'dev'): string {
	switch (run.status) {
		case 'pending':
			return 'Queued and not started yet; poll again.'
		case 'running':
			return 'Running; poll with after set to log.to for the new lines only.'
		case 'awaiting_approval':
			return 'Waiting for a person to approve its access change (see approval); it continues only after that.'
		case 'succeeded':
			return environment === 'stage'
				? `Succeeded: the stage environment runs ${run.commitSha ?? 'the deployed commit'}.`
				: `Succeeded: the dev environment runs ${run.commitSha ?? 'the deployed commit'}; commits now sync without a run.`
		case 'failed':
			return 'Failed; read the log with failuresOnly for the lines that name the failure.'
	}
}

/**
 * A line that names an error or a failure, or a non-zero exit. The stream says nothing: bun prints the commands it runs
 * and its test output on stderr. A count of none (`0 fail`) is no failure, colored or not.
 */
const FAILURE_TEXT = /\b(?:error|errors|fail|failed|failure|failures|fatal|panic|exception)\b|\bexit(?:ed)?(?: with)?(?: code| status)?[ :]+[1-9]/i
const ZERO_COUNT = /\b0 (?:fail|failed|failures?|errors?)\b/gi
const COLOR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

const isFailureLine = (text: string): boolean => FAILURE_TEXT.test(text.replace(COLOR, '').replace(ZERO_COUNT, ''))

/**
 * A window of `all`. `from`, `to` and `total` always index the whole log, so `after: to` resumes it whether or not the
 * next call filters. With `failuresOnly` the window holds up to `lines` failure lines between `from` and `to`.
 */
export function logWindow<Line extends { stream: string; text: string }>(all: readonly Line[], query: DeploymentLogQuery): LogWindowDto<Line> {
	if (query.after !== undefined && query.before !== undefined) fail(400, 'name after or before, not both')
	const total = all.length
	const keep = (line: Line): boolean => !query.failuresOnly || isFailureLine(line.text)
	if (query.after !== undefined) {
		const from = Math.min(query.after, total)
		const lines: Line[] = []
		let to = from
		while (to < total && lines.length < query.lines) {
			const line = all[to]
			to += 1
			if (line !== undefined && keep(line)) lines.push(line)
		}
		return { lines, from, to: lines.length < query.lines ? total : to, total }
	}
	const to = Math.min(query.before ?? total, total)
	const lines: Line[] = []
	let from = to
	while (from > 0 && lines.length < query.lines) {
		from -= 1
		const line = all[from]
		if (line !== undefined && keep(line)) lines.unshift(line)
	}
	return { lines, from: lines.length < query.lines ? 0 : from, to, total }
}

export async function createPullRequestUseCase(
	c: WorkspaceUseCaseContext,
	input: { workspaceId: string; title: string; body: string },
): Promise<{ number: number; url: string; created: boolean }> {
	const owned = await requireWorkspace(c, input.workspaceId, CONTROL_ACTIONS.SOURCE_PULL_REQUEST_CREATE)
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
	await c.repositories.workspaces.recordPullRequest(owned.workspace.id, { number: pullRequest.number, url: pullRequest.url })
	await c.auth.audit({
		action: 'source.pull-request.create',
		resourceType: 'workspace',
		resourceId: owned.workspace.id,
		metadata: { appId: owned.workspace.app_id, env: owned.workspace.env, number: pullRequest.number, created: pullRequest.created },
	})
	return { number: pullRequest.number, url: pullRequest.url, created: pullRequest.created }
}

/**
 * Abandon a workspace: delete its branch, which closes an open pull request from it on GitHub, then mark it so it is no
 * longer listed or usable. The stage environment keeps running whatever it last deployed. Repeating it is harmless.
 */
export async function abandonWorkspaceUseCase(
	c: WorkspaceUseCaseContext,
	input: { workspaceId: string },
): Promise<{ workspaceId: string; branchDeleted: boolean }> {
	const owned = await requireWorkspace(c, input.workspaceId, CONTROL_ACTIONS.SOURCE_WORKSPACE_WRITE, 'allow')
	const { branch } = owned.workspace
	// Only ever a workspace branch: never the default branch or anything the operator owns.
	if (!branch.startsWith(WORKSPACE_BRANCH_PREFIX)) fail(409, 'the workspace does not own a fabrika/ branch')
	// The branch goes first, so a failure leaves the workspace usable and the call can be repeated.
	const branchDeleted = await sourceCall(() => c.source.deleteBranch({ target: owned.source, branch, signal: c.signal }))
	await c.repositories.workspaces.markAbandoned(owned.workspace.id)
	await c.auth.audit({
		action: 'source.workspace.abandon',
		resourceType: 'workspace',
		resourceId: owned.workspace.id,
		metadata: { appId: owned.workspace.app_id, env: owned.workspace.env, branch, branchDeleted },
	})
	return { workspaceId: owned.workspace.id, branchDeleted }
}

/** Repository-relative with forward slashes: no leading slash, no empty, `.` or `..` segment, no control character. */
export function isRepositoryPath(path: string): boolean {
	return !path.startsWith('/') && !path.includes('\\')
		&& ![...path].some((character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f)
		&& path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/**
 * ADR-0049 D6: deployment configuration and CI are changed through normal review only — `zerops.yaml`
 * / `zerops.yml` at any depth, every `fabrika.*` file but the contract, and anything under `.github/`.
 * `fabrika.contract.ts` is editable because Control classifies its changes at deploy time (ADR-0050).
 */
export function isProtectedPath(path: string): boolean {
	const lower = path.toLowerCase()
	const name = lower.split('/').at(-1) ?? lower
	if (name === 'zerops.yaml' || name === 'zerops.yml' || lower.startsWith('.github/')) return true
	// Exact case only: a case-insensitive file system could otherwise check out `Fabrika.Contract.ts` as something else.
	return name.startsWith('fabrika.') && path.split('/').at(-1) !== CONTRACT_FILE
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
	const source = await sourceTargetOf(c.repositories, app)
	return source === null ? null : { app, appEnv, source }
}

/** The repository of the application's GitHub source and the connection that reaches it; null when it has none. */
export async function workspaceSourceTarget(repositories: ControlRepositories, appId: string): Promise<WorkspaceSourceTarget | null> {
	const app = await repositories.registry.getApp(appId)
	return app === null ? null : sourceTargetOf(repositories, app)
}

async function sourceTargetOf(repositories: ControlRepositories, app: AppRow): Promise<WorkspaceSourceTarget | null> {
	let binding: ProviderSourceBinding | null
	try {
		binding = await repositories.registry.getSourceBinding(app.id)
	} catch (cause) {
		if (cause instanceof SourceBindingError) return null
		throw cause
	}
	const repository = parseGitHubRepo(app.repo_url)
	if (binding === null || repository === null) return null
	return { connectionId: binding.connectionId, installationId: binding.installationId, owner: repository.owner, repository: repository.repo }
}

export async function requireWorkspace(
	c: WorkspaceUseCaseContext,
	workspaceId: string,
	action: string,
	abandoned: 'refuse' | 'allow' = 'refuse',
): Promise<OwnedWorkspace> {
	const ownerId = requireOwner(c.auth)
	const workspace = await c.repositories.workspaces.getWorkspace(workspaceId)
	if (workspace === null || workspace.owner_id !== ownerId) fail(404, 'workspace not found')
	if (workspace.abandoned_at !== null && abandoned === 'refuse') fail(410, 'the workspace was abandoned; create a new one')
	const target = await findAuthoringTarget(c, workspace.app_id, workspace.env, action)
	if (target === null) fail(404, 'workspace not found')
	return { ...target, workspace }
}

export async function requireHead(c: WorkspaceUseCaseContext, owned: OwnedWorkspace): Promise<string> {
	const headSha = await sourceCall(() => c.source.readBranch({ target: owned.source, branch: owned.workspace.branch, signal: c.signal }))
	if (headSha === null) fail(404, 'the workspace branch no longer exists')
	return headSha
}

async function describeWorkspace(c: WorkspaceUseCaseContext, owned: OwnedWorkspace): Promise<WorkspaceDto> {
	const headSha = await sourceCall(() => c.source.readBranch({ target: owned.source, branch: owned.workspace.branch, signal: c.signal }))
	const deployed = await stageDeployment(c, owned.workspace.app_id, owned.workspace.env)
	return toWorkspaceDto(owned.workspace, headSha, await latestRunOf(c, owned.workspace), deployed?.workspaceId === owned.workspace.id)
}

async function stageDeployment(c: WorkspaceUseCaseContext, appId: string, env: string): Promise<StageDeploymentDto | null> {
	const run = await c.repositories.runs.getLatestSucceededRun({ appId, env })
	if (run === null) return null
	const branch = run.ref.startsWith(`refs/heads/${WORKSPACE_BRANCH_PREFIX}`) ? run.ref.slice('refs/heads/'.length) : null
	const workspace = branch === null ? null : await c.repositories.workspaces.getWorkspaceByBranch(branch)
	const sameTarget = workspace !== null && workspace.app_id === appId && workspace.env === env
	return {
		runId: run.id,
		commitSha: run.commit_sha,
		finishedAt: run.finished_at,
		workspaceId: sameTarget ? workspace.id : null,
		yours: sameTarget && workspace.owner_id === requireOwner(c.auth),
	}
}

async function latestRunOf(c: WorkspaceUseCaseContext, workspace: WorkspaceRow): Promise<RunDto | null> {
	const latestRun = await c.repositories.runs.getLatestRunForRef({
		appId: workspace.app_id,
		env: workspace.env,
		ref: `refs/heads/${workspace.branch}`,
	})
	return latestRun === null ? null : toRunDto(latestRun)
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
		pullRequest: row.pull_request_number === null || row.pull_request_url === null
			? null
			: { number: row.pull_request_number, url: row.pull_request_url },
	}
}

function toWorkspaceDto(row: WorkspaceRow, headSha: string | null, latestRun: RunDto | null, onStage: boolean): WorkspaceDto {
	return { ...toWorkspaceSummaryDto(row), headSha, latestRun, onStage }
}

function requirePrincipal(auth: AuthContext) {
	const principal = auth.principal
	if (principal === null || principal.type !== 'user') fail(403, 'workspaces belong to a signed-in user')
	return principal
}

export function requireOwner(auth: AuthContext): string {
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
	if (cause.kind === 'refused') {
		return new ControlApiError(
			502,
			"GitHub refused this app's GitHub App: its installation, permissions or key, or a protected branch. Retrying will not help; "
				+ 'tell the operator.',
		)
	}
	return new ControlApiError(503, 'GitHub is unavailable or rate-limited. Retry in a minute; if it keeps failing, tell the operator.')
}
