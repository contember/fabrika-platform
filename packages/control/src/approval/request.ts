// A non-person's manual run of a protected environment is its own approval request (ADR-0050 §4): the run records who
// asked and the commit's message when it is created, and parks for a person whatever its lines. The commit must be
// merged unless the environment chose `deployRequestCommits: any`; Control asks the source and fails closed.

import type { AuthContext } from '@fabrika/auth'
import type { DeployRequestDto } from '@fabrika/control-contract'
import { z } from 'zod'
import { ControlApiError, fail } from '../api/domain'
import type { AppEnvRow, AppRow, ControlRepositories, RunRow } from '../db'
import type { CommitSource } from '../github/source/commit-files'
import { SourceFailure } from '../github/source/failure'
import { parseGitHubRepo } from '../github/triggers/push-event'
import { isRefPattern } from '../ref-match'
import { appEnvSettings } from './categories'

/** The longest commit message a request keeps; the page shows the agent's text, never all of an arbitrary one. */
export const MAX_REQUEST_MESSAGE_CHARS = 4096

// Not strict: a key a later release adds is dropped, so a rollback still lists and reads the run.
const storedRequestSchema = z.object({
	principal: z.object({ id: z.string(), type: z.string(), label: z.string() }),
	credential: z.enum(['oauth', 'key']),
	clientId: z.string().optional(),
	commitMessage: z.string().nullable(),
})

/** What `runs.request_json` holds: who asked, through which credential, and the commit's message. */
export type StoredDeployRequest = z.infer<typeof storedRequestSchema>

export function parseDeployRequest(raw: string): StoredDeployRequest {
	return storedRequestSchema.parse(JSON.parse(raw))
}

/** The branch or tag (short name) a requested commit must be merged into: the trigger ref, or the default branch. */
export function mergeTarget(appEnv: Pick<AppEnvRow, 'trigger_ref'>, app: Pick<AppRow, 'default_branch'>): string {
	const trigger = appEnv.trigger_ref
	if (trigger === null || isRefPattern(trigger)) return app.default_branch
	if (trigger.startsWith('refs/heads/')) return trigger.slice('refs/heads/'.length)
	if (trigger.startsWith('refs/tags/')) return trigger.slice('refs/tags/'.length)
	return trigger
}

export interface DeployRequestContext {
	readonly auth: AuthContext
	readonly repositories: Pick<ControlRepositories, 'registry'>
	readonly commits?: CommitSource
	readonly signal?: AbortSignal
}

/**
 * The record of a non-person's request to deploy `commitSha` to a protected environment. Under `merged` the source must
 * show the commit reachable from the merge target, and anything else, an unreadable source included, is refused (400).
 */
export async function deployRequestOf(c: DeployRequestContext, appEnv: AppEnvRow, commitSha: string): Promise<StoredDeployRequest> {
	const app = await c.repositories.registry.getApp(appEnv.app_id)
	if (app === null) fail(404, 'app env not found')
	const mergedInto = appEnvSettings(appEnv).deployRequestCommits === 'merged' ? mergeTarget(appEnv, app) : null
	const commitMessage = await readRequestedMessage(c, app, commitSha, mergedInto, appEnv.env)
	const principal = c.auth.principal
	if (principal === null) fail(403, `environment \`${appEnv.env}\` is protected: an anonymous caller cannot ask to deploy it`)
	return {
		principal: { id: principal.id, type: principal.type, label: principal.label },
		credential: c.auth.oauth === undefined ? 'key' : 'oauth',
		...(c.auth.oauth === undefined ? {} : { clientId: c.auth.oauth.clientId }),
		commitMessage: commitMessage === null ? null : commitMessage.slice(0, MAX_REQUEST_MESSAGE_CHARS),
	}
}

async function readRequestedMessage(
	c: DeployRequestContext,
	app: AppRow,
	commitSha: string,
	mergedInto: string | null,
	env: string,
): Promise<string | null> {
	const unproven = `environment \`${env}\` is protected: a deploy an agent or a key asks for must be merged into \`${mergedInto}\``
	if (c.commits === undefined) {
		if (mergedInto === null) return null
		fail(400, `${unproven}, and Control has no source to ask whether commit ${commitSha} is`)
	}
	const sourceBinding = await c.repositories.registry.getSourceBinding(app.id)
	try {
		const read = await c.commits.requestedCommit({
			repoUrl: app.repo_url,
			commitSha,
			...(sourceBinding === null ? {} : { sourceBinding }),
			mergedInto,
			signal: c.signal ?? AbortSignal.timeout(60_000),
		})
		if (read.merged === false) fail(400, `${unproven}; commit ${commitSha} is not`)
		return read.message
	} catch (error) {
		if (error instanceof ControlApiError) throw error
		// Under `any` the message is context only: the deploy reads the commit itself and fails if it cannot.
		if (mergedInto === null) return null
		const cause = error instanceof SourceFailure ? error.code : 'internal'
		fail(400, `${unproven}, and the source did not answer whether commit ${commitSha} is (${cause}); try again`)
	}
}

/** The request as the approval page shows it, beside the commit the environment runs and a compare of the two. */
export async function toDeployRequestDto(
	repositories: Pick<ControlRepositories, 'registry' | 'runs'>,
	run: RunRow,
): Promise<DeployRequestDto | undefined> {
	if (run.request_json === null) return undefined
	const request = parseDeployRequest(run.request_json)
	const commitSha = run.commit_sha ?? run.ref
	const running = await repositories.runs.getLatestSucceededRun({ appId: run.app_id, env: run.env })
	const runningCommitSha = running?.commit_sha ?? null
	const app = await repositories.registry.getApp(run.app_id)
	const repository = app === null ? null : parseGitHubRepo(app.repo_url)
	return {
		principal: request.principal,
		credential: request.credential,
		...(request.clientId === undefined ? {} : { clientId: request.clientId }),
		commitSha,
		commitMessage: request.commitMessage,
		runningCommitSha,
		compareUrl: repository === null || runningCommitSha === null || runningCommitSha === commitSha
			? null
			: `https://github.com/${repository.owner}/${repository.repo}/compare/${runningCommitSha}...${commitSha}`,
	}
}
