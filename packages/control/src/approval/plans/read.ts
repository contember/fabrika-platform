// The snapshot of a commit a plan is made for (ADR-0050 §5): read as a deploy run reads its pinned commit, at the
// application root the provider executes from, against what the environment published and last ran. Nothing is
// published or stored but the plan itself.

import type { ControlProvider } from '@fabrika/provider-contract'
import { fail } from '../../api/domain'
import type { AppEnvRow, AppRow, ControlRepositories } from '../../db'
import type { CommitSource } from '../../github/source/commit-files'
import { SourceFailure, SourceRateLimited } from '../../github/source/failure'
import { runningSnapshot } from '../publish'
import { AppliedMigrationsChanged, ContractMissing, readAccessSnapshot, snapshotReads, SnapshotRefused } from '../read'
import { FrameworkReleaseRefused } from '../readers'
import { type AccessSnapshot, approvedSnapshot } from '../snapshot'

/** Reads the access snapshot of one commit of an application for one of its environments. */
export type PlanCommitReader = (app: AppRow, appEnv: AppEnvRow, commitSha: string) => Promise<AccessSnapshot>

/**
 * The reader over the installation's commit source and provider. Every refusal a deploy would log becomes the 409 of
 * the plan, in the same words: codes, counts and fixed names, never the checkout's text.
 */
export function planCommitReader(deps: {
	readonly repositories: ControlRepositories
	readonly provider: Pick<ControlProvider, 'applicationRoot' | 'applicationDialect' | 'source'>
	readonly commits: CommitSource
}): PlanCommitReader {
	return async (app, appEnv, commitSha) => {
		const binding = deps.provider.source === undefined ? null : await deps.repositories.registry.getSourceBinding(app.id)
		const root = deps.provider.applicationRoot === undefined ? '' : deps.provider.applicationRoot({
			repoUrl: app.repo_url,
			ref: commitSha,
			...(app.worker_dir === null ? {} : { workerDir: app.worker_dir }),
			...(app.build_cmd === null ? {} : { buildCommand: app.build_cmd }),
			...(app.config_path === null ? {} : { configPath: app.config_path }),
		})
		try {
			if (root === null) throw new SnapshotRefused('root-invalid')
			const commit = await deps.commits.open({
				repoUrl: app.repo_url,
				commitSha,
				wanted: snapshotReads(root),
				...(binding === null ? {} : { sourceBinding: binding }),
				signal: AbortSignal.timeout(60_000),
			})
			const running = await deps.repositories.runs.getLatestSucceededRunWithSnapshot({ appId: appEnv.app_id, env: appEnv.env })
			const applied = running === null ? [] : (await runningSnapshot(deps.repositories.runs, running))?.migrations ?? []
			return await readAccessSnapshot(commit, root, app.id, {
				settled: approvedSnapshot(appEnv).snapshot.migrations,
				applied,
				dialect: deps.provider.applicationDialect ?? 'postgres',
			})
		} catch (error) {
			if (error instanceof ContractMissing || error instanceof FrameworkReleaseRefused) fail(409, `the commit cannot be planned: ${error.message}`)
			if (error instanceof SnapshotRefused) fail(409, `the commit cannot be planned: ${error.message}; \`fabrika-check\` names the problems`)
			if (error instanceof AppliedMigrationsChanged) fail(409, `the commit cannot be planned: ${error.lines.join('; ')}`)
			if (error instanceof SourceRateLimited) fail(503, `the commit's files cannot be read: ${error.message}`)
			if (error instanceof SourceFailure) fail(409, `the commit's files cannot be read (${error.code})`)
			throw error
		}
	}
}
