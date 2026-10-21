import type { SqlDatabase } from '@fabrika/platform'
import { firstRow } from './returning'

/** Metadata of one Git workspace; the branch on GitHub holds the content (ADR-0049). */
export interface WorkspaceRow {
	id: string
	app_id: string
	env: string
	owner_id: string
	branch: string
	base_sha: string
	title: string
	created_at: number
	pull_request_number: number | null
	pull_request_url: string | null
	/** Unix seconds; set once, by `markAbandoned`. */
	abandoned_at: number | null
}

export interface WorkspaceInput {
	id: string
	appId: string
	env: string
	ownerId: string
	branch: string
	baseSha: string
	title: string
}

const LIST_LIMIT = 100

export class WorkspaceRepository {
	constructor(
		private readonly d1: SqlDatabase,
		private readonly now: () => number = () => Math.floor(Date.now() / 1000),
	) {}

	async createWorkspace(input: WorkspaceInput): Promise<WorkspaceRow> {
		return firstRow<WorkspaceRow>(
			this.d1
				.prepare(`INSERT INTO workspaces (id, app_id, env, owner_id, branch, base_sha, title)
					VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`)
				.bind(input.id, input.appId, input.env, input.ownerId, input.branch, input.baseSha, input.title),
		)
	}

	async getWorkspace(id: string): Promise<WorkspaceRow | null> {
		return this.d1.prepare('SELECT * FROM workspaces WHERE id = ?').bind(id).first<WorkspaceRow>()
	}

	async getWorkspaceByBranch(branch: string): Promise<WorkspaceRow | null> {
		return this.d1.prepare('SELECT * FROM workspaces WHERE branch = ?').bind(branch).first<WorkspaceRow>()
	}

	/** Remember the pull request opened or found for the workspace; the newest one wins. */
	async recordPullRequest(id: string, pullRequest: { number: number; url: string }): Promise<void> {
		await this.d1.prepare('UPDATE workspaces SET pull_request_number = ?, pull_request_url = ? WHERE id = ?')
			.bind(pullRequest.number, pullRequest.url, id)
			.run()
	}

	/** Mark the workspace abandoned; a second call keeps the first stamp. */
	async markAbandoned(id: string): Promise<void> {
		await this.d1.prepare('UPDATE workspaces SET abandoned_at = ? WHERE id = ? AND abandoned_at IS NULL').bind(this.now(), id).run()
	}

	/** The newest workspaces of one owner that are not abandoned, optionally narrowed to an app and an environment. */
	async listWorkspaces(filter: { ownerId: string; appId?: string; env?: string }): Promise<WorkspaceRow[]> {
		const where = ['owner_id = ?', 'abandoned_at IS NULL']
		const binds: string[] = [filter.ownerId]
		if (filter.appId !== undefined) {
			where.push('app_id = ?')
			binds.push(filter.appId)
		}
		if (filter.env !== undefined) {
			where.push('env = ?')
			binds.push(filter.env)
		}
		const { results } = await this.d1
			.prepare(`SELECT * FROM workspaces WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`)
			.bind(...binds, LIST_LIMIT)
			.all<WorkspaceRow>()
		return results
	}
}
