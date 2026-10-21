import type { AuthContext } from '@fabrika/auth'
import type { RunLogLine } from '@fabrika/control-contract'
import type { SqlDatabase } from '@fabrika/platform'
import type { ControlProvider } from '@fabrika/provider-contract'
import { putAppEnvUseCase } from '../../api/registry/environments'
import type { WorkspaceUseCaseContext } from '../../api/workspaces'
import type { ControlRepositories } from '../../db'
import type { ControlJobMessage } from '../../run-lifecycle'
import {
	type WorkspaceChangedFile,
	type WorkspaceCommit,
	type WorkspaceComparison,
	type WorkspaceFile,
	type WorkspacePullRequestInput,
	type WorkspaceScan,
	type WorkspaceScanInput,
	WorkspaceSourceError,
	type WorkspaceSourcePort,
	type WorkspaceSourceTarget,
	type WorkspaceTree,
	type WorkspaceTreeEntry,
	type WorkspaceUnreadableReason,
} from '../../workspace-source-port'
import { allowAllAuth, authWithPermissions } from './iam'

export const sha = (character: string): string => character.repeat(40)

export const CONNECTION_ID = 'conn-acme'
export const INSTALLATION_ID = 45

/** A Zerops provider double: the authoring flag is Zerops-only, so the id is the real one. */
export const zeropsProvider: ControlProvider = {
	id: 'zerops',
	normalizeRegistration: (input) => input,
	deploy: () => Promise.resolve({ state: 'succeeded' }),
}

export const zeropsEnvelopes = () => ({
	target: { provider: 'zerops', version: 1, payload: {} },
	artifact: { provider: 'zerops', version: 1, payload: {} },
})

/** Every repository call, in order, by operation. */
export type SourceCall =
	| { kind: 'read-branch'; branch: string }
	| { kind: 'create-branch'; branch: string; fromSha: string }
	| { kind: 'list-tree'; commitSha: string; directory?: string }
	| { kind: 'read-files'; commitSha: string; paths: readonly string[] }
	| { kind: 'scan-files'; commitSha: string; directory?: string; maxFiles: number }
	| { kind: 'compare'; baseSha: string; headSha: string }
	| { kind: 'commit'; commit: WorkspaceCommit }
	| { kind: 'pull-request'; pullRequest: WorkspacePullRequestInput }

/** An in-memory Source: branches map to heads; a commit advances the head unless the expected head is stale. */
export class FakeWorkspaceSource implements WorkspaceSourcePort {
	readonly calls: SourceCall[] = []
	readonly targets: WorkspaceSourceTarget[] = []
	readonly branches = new Map<string, string>([['main', sha('a')]])
	/** The content `readFiles` answers for a path; any other path reads as `content of <path>`. */
	readonly contents = new Map<string, string>()
	/** Paths `readFiles` answers as not read, with the reason. */
	readonly unreadable = new Map<string, WorkspaceUnreadableReason>()
	/** The files `compare` answers as changed. */
	changedFiles: WorkspaceChangedFile[] = []
	private commits = 0

	readBranch(input: { target: WorkspaceSourceTarget; branch: string }): Promise<string | null> {
		this.record(input.target, { kind: 'read-branch', branch: input.branch })
		return Promise.resolve(this.branches.get(input.branch) ?? null)
	}

	createBranch(input: { target: WorkspaceSourceTarget; branch: string; fromSha: string }): Promise<string> {
		this.record(input.target, { kind: 'create-branch', branch: input.branch, fromSha: input.fromSha })
		if (this.branches.has(input.branch)) return Promise.reject(new WorkspaceSourceError('conflict'))
		this.branches.set(input.branch, input.fromSha)
		return Promise.resolve(input.fromSha)
	}

	listTree(input: { target: WorkspaceSourceTarget; commitSha: string; directory?: string }): Promise<WorkspaceTree> {
		this.record(input.target, {
			kind: 'list-tree',
			commitSha: input.commitSha,
			...(input.directory === undefined ? {} : { directory: input.directory }),
		})
		const files = [...this.contents.keys()].sort().map((path): WorkspaceTreeEntry => ({ path, kind: 'file', size: 1 }))
		return Promise.resolve({ commitSha: input.commitSha, entries: [{ path: 'src', kind: 'directory' }, ...files], truncated: false })
	}

	readFiles(input: { target: WorkspaceSourceTarget; commitSha: string; paths: readonly string[] }) {
		this.record(input.target, { kind: 'read-files', commitSha: input.commitSha, paths: input.paths })
		return Promise.resolve({
			commitSha: input.commitSha,
			files: input.paths.map((path): WorkspaceFile => {
				const reason = this.unreadable.get(path)
				if (reason !== undefined) return { path, content: null, reason }
				return { path, content: this.contents.get(path) ?? `content of ${path}` }
			}),
		})
	}

	/** Scans the paths of `contents` and `unreadable` as the tree, in path order. */
	scanFiles(input: WorkspaceScanInput & { target: WorkspaceSourceTarget }): Promise<WorkspaceScan> {
		this.record(input.target, {
			kind: 'scan-files',
			commitSha: input.commitSha,
			...(input.directory === undefined ? {} : { directory: input.directory }),
			maxFiles: input.maxFiles,
		})
		const prefix = input.directory === undefined ? '' : `${input.directory}/`
		const admitted = [...new Set([...this.contents.keys(), ...this.unreadable.keys()])].sort()
			.filter((path) => path.startsWith(prefix) && input.include(path))
		const files = admitted.slice(0, input.maxFiles).map((path): WorkspaceFile => {
			const reason = this.unreadable.get(path)
			return reason === undefined ? { path, content: this.contents.get(path) ?? '' } : { path, content: null, reason }
		})
		return Promise.resolve({ commitSha: input.commitSha, files, candidates: admitted.length, treeTruncated: false })
	}

	compare(input: { target: WorkspaceSourceTarget; baseSha: string; headSha: string }): Promise<WorkspaceComparison> {
		this.record(input.target, { kind: 'compare', baseSha: input.baseSha, headSha: input.headSha })
		return Promise.resolve({
			baseSha: input.baseSha,
			headSha: input.headSha,
			aheadBy: this.changedFiles.length === 0 ? 0 : 1,
			files: this.changedFiles,
			filesCapped: false,
		})
	}

	commit(input: WorkspaceCommit & { target: WorkspaceSourceTarget; signal: AbortSignal }): Promise<string> {
		const { target, signal: _signal, ...commit } = input
		this.record(target, { kind: 'commit', commit })
		if (this.branches.get(input.branch) !== input.expectedHeadSha) return Promise.reject(new WorkspaceSourceError('stale_head'))
		this.commits += 1
		const next = sha(String(this.commits % 10))
		this.branches.set(input.branch, next)
		return Promise.resolve(next)
	}

	openPullRequest(input: WorkspacePullRequestInput & { target: WorkspaceSourceTarget; signal: AbortSignal }) {
		const { target, signal: _signal, ...pullRequest } = input
		this.record(target, { kind: 'pull-request', pullRequest })
		return Promise.resolve({ number: 7, url: 'https://github.com/acme/shop/pull/7', created: true })
	}

	kinds(): string[] {
		return this.calls.map((call) => call.kind)
	}

	private record(target: WorkspaceSourceTarget, call: SourceCall): void {
		this.targets.push(target)
		this.calls.push(call)
	}
}

/** An OAuth-backed user holding the given actions globally. */
export function oauthUser(actions: readonly string[], label = 'author@acme.test'): AuthContext {
	return {
		...authWithPermissions(actions.map((action) => ({ action, scope: null })), label),
		oauth: { app: 'vozka', clientId: 'https://claude.ai/oauth/client.json', scopes: ['authoring'], grantId: 'grant-1', tokenId: 'token-1' },
	}
}

export const AUTHOR_ACTIONS = ['source.workspace.read', 'source.workspace.write', 'source.pull-request.create', 'deploy.trigger', 'deploy.read']

export interface WorkspaceWorld {
	repositories: ControlRepositories
	source: FakeWorkspaceSource
	queued: ControlJobMessage[]
	logs: Map<string, RunLogLine[]>
	context(auth: AuthContext): WorkspaceUseCaseContext
}

/**
 * Seed `shop` (GitHub-connected, its `stage` an authoring target, its `prod` not) and `plain` (no
 * GitHub connection) over any SQL backend.
 */
export async function seedWorkspaceWorld(repositories: ControlRepositories, db: SqlDatabase): Promise<WorkspaceWorld> {
	await db.prepare(`INSERT INTO github_source_connections_keyed (
		connection_id, app_id, app_slug, app_html_url, app_owner, app_name, app_public,
		app_credential_ref, webhook_url, webhook_secret_ref, installation_id,
		installation_account_login, installation_selection, verified_repositories_json,
		requested_repositories_json, connected_by, connected_at, verified_at, version
	) VALUES (?, '123', 'acme-app', 'https://github.com/apps/acme-app', 'acme', 'acme-app', 0, ?, ?, ?, ?, 'acme', 'all',
		'["acme/shop"]', '["acme/shop"]', 'principal-1', 800, 900, 1)`)
		.bind(
			CONNECTION_ID,
			`vault:${CONNECTION_ID}-app-credential`,
			`https://control.example/webhooks/github/${CONNECTION_ID}`,
			`vault:${CONNECTION_ID}-webhook`,
			INSTALLATION_ID,
		)
		.run()
	await repositories.registry.createApp({
		id: 'shop',
		repoUrl: 'github.com/acme/shop',
		defaultBranch: 'main',
		githubConnectionId: CONNECTION_ID,
		githubInstallationId: INSTALLATION_ID,
	})
	await repositories.registry.createApp({ id: 'plain', repoUrl: 'github.com/acme/plain', defaultBranch: 'main' })
	const registry = registryContext(repositories)
	await putAppEnvUseCase(registry, 'shop', 'stage', { ...zeropsEnvelopes(), publicOrigin: 'https://shop-stage.example.com', authoring: true })
	await putAppEnvUseCase(registry, 'shop', 'prod', zeropsEnvelopes())
	await putAppEnvUseCase(registry, 'plain', 'stage', zeropsEnvelopes())
	const source = new FakeWorkspaceSource()
	const queued: ControlJobMessage[] = []
	const logs = new Map<string, RunLogLine[]>()
	return {
		repositories,
		source,
		queued,
		logs,
		context: (auth) => ({
			repositories,
			source,
			consoleOrigin: 'https://console.example.test',
			queue: {
				send(message) {
					queued.push(message)
					return Promise.resolve()
				},
			},
			logs: {
				get: (key) => {
					const lines = logs.get(key)
					if (lines === undefined) return Promise.resolve(null)
					const text = lines.map((line) => JSON.stringify(line)).join('\n')
					return Promise.resolve({ body: new Blob([text]).stream(), text: () => Promise.resolve(text) })
				},
			},
			auth,
			signal: new AbortController().signal,
		}),
	}
}

export function registryContext(repositories: ControlRepositories, provider: ControlProvider = zeropsProvider) {
	return { repositories, provider, auth: allowAllAuth(), signal: new AbortController().signal }
}
