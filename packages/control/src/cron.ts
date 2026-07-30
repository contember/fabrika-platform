// Scheduled maintenance — the work behind the Worker's `scheduled` handler, extracted so the
// long-running process runs exactly the same code on exactly the same schedule.
//
// Event-driven targets call this from a scheduled handler; long-running targets invoke `node/cron.ts`
// from their platform scheduler. There is no in-process timer: in a horizontally-scaled service it
// would fire once per container and silently reset on every deploy. Both operations tolerate an
// overlapping run — the poll is a conditional GET whose only mutation is guarded by a changed head
// sha, and the sweep is a guarded UPDATE by age.

import type { Env } from './env'
import type { OperationsCatalogSyncSummary } from './operations-catalog'
import type { OperationsReleaseProjectionSummary } from './operations-releases'
import { replayOperationsReleases } from './operations-releases'
import type { ProviderReconcileSummary } from './provider-reconcile'
import { type FetchFn, pollPublicRepos, type PollSummary } from './repo-poll'
import { operationsReleaseDeps, replayOperationsCatalogProjection, repositories, STALE_RUN_MAX_AGE_S } from './services'

/** What one maintenance pass did. Returned for the tests + the log line; counts only, never a URL. */
export interface MaintenanceSummary {
	poll: PollSummary
	/** Provider-owned runs observed or completed. */
	reconcile: ProviderReconcileSummary
	/** Orphaned runs marked failed by the sweep. */
	swept: number
	/** Full Operations catalog replay, isolated from deploy maintenance success. */
	operations: OperationsCatalogSyncSummary
	/** Pending deploy-release projections repaired independently from catalog sync. */
	releases: OperationsReleaseProjectionSummary
}

/** Seams a test drives. Production passes neither and gets the real clock + the global `fetch`. */
export interface MaintenanceOptions {
	/** Wall clock in unix SECONDS — the unit every `*_at` column uses. */
	now?: () => number
	/** The conditional GET of a repo's Atom feed. Injected so no test reaches github.com. */
	fetch?: FetchFn
	/** Provider-specific composition root injects reconciliation when the capability is available. */
	reconcile?: () => Promise<ProviderReconcileSummary>
	/** Test seam for the Operations maintenance replay. */
	operations?: () => Promise<OperationsCatalogSyncSummary>
	/** Test seam for the deploy-release maintenance replay. */
	releases?: () => Promise<OperationsReleaseProjectionSummary>
}

/**
 * One maintenance pass: poll PUBLIC repos (apps with no GitHub App install, which therefore get no push
 * webhook) for new commits and enqueue a deploy when a subscribed ref's head changes — the pull-based
 * trigger alongside the webhook — then reap orphaned runs.
 *
 * A poll-created run is serialized by the same per-app-env deploy lock as any other run (the consumer
 * takes it). The sweep is the backstop-TO-the-backstop: vozka-runner's per-run DO already records a
 * terminal status within ~18 min even when the relay is aborted, so this only catches runs the DO never
 * fired for at all (e.g. vozka-runner itself was down). Logs counts only — never a feed URL or a secret.
 */
export async function runMaintenance(env: Env, options: MaintenanceOptions = {}): Promise<MaintenanceSummary> {
	const persistence = repositories(env)
	const poll = await pollPublicRepos({
		repositories: persistence,
		fetch: options.fetch ?? fetch,
		queue: env.DEPLOY_QUEUE,
		now: options.now ?? (() => Math.floor(Date.now() / 1000)),
	})
	console.info(
		`repo poll: polled=${poll.polled} triggered=${poll.triggered} unchanged=${poll.unchanged} errored=${poll.errored} skipped=${poll.skipped}`,
	)
	const reconcile = options.reconcile === undefined
		? { checked: 0, succeeded: 0, failed: 0, inProgress: 0, waiting: 0 }
		: await options.reconcile()
	if (reconcile.checked > 0 || reconcile.waiting > 0) {
		console.info(
			`provider reconcile: checked=${reconcile.checked} succeeded=${reconcile.succeeded} failed=${reconcile.failed} `
				+ `in-progress=${reconcile.inProgress} waiting=${reconcile.waiting}`,
		)
	}
	const swept = await persistence.runs.sweepStaleRuns(STALE_RUN_MAX_AGE_S)
	if (swept > 0) {
		console.warn(`run sweep: marked ${swept} stale run(s) failed (> ${STALE_RUN_MAX_AGE_S}s in pending/running)`)
	}
	const operations = await (options.operations ?? (() => replayOperationsCatalogProjection(env)))()
	if (operations.outcome === 'failed') {
		console.warn('operations catalog maintenance replay failed')
	}
	const releases = await (options.releases ?? (() => replayOperationsReleases(operationsReleaseDeps(env))))()
	if (releases.failed > 0) console.warn(`operations release maintenance replay failed for ${releases.failed} run(s)`)
	return { poll, reconcile, swept, operations, releases }
}
