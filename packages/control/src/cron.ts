// Scheduled maintenance — the work behind the Worker's `scheduled` handler, extracted so the
// long-running process runs exactly the same code on exactly the same schedule.
//
// Event-driven targets call this from a scheduled handler; long-running targets invoke `bun/cron.ts` through their composition root
// from their platform scheduler. There is no in-process timer: in a horizontally-scaled service it
// would fire once per container and silently reset on every deploy. Both operations tolerate an
// overlapping run — the poll is a conditional GET whose only mutation is guarded by a changed head
// sha, and the sweep is a guarded UPDATE by age.

import { enqueueUnsettledNamespaces } from './api/namespaces'
import type { BackupScheduleSummary } from './backups'
import type { ControlRegistryRepository } from './db'
import type { DevIdleSummary } from './dev/service'
import type { Env } from './env'
import { type FetchFn, pollPublicRepos, type PollSummary } from './github/triggers/poll'
import { type MailMaintenanceSummary, runMailMaintenance } from './mail-relay/maintenance'
import type { OperationsCatalogSyncSummary } from './operations-catalog'
import type { OperationsReleaseProjectionSummary } from './operations-releases'
import { replayOperationsReleases } from './operations-releases'
import { type ProviderReconcileSummary, sweepStaleRuns } from './provider-reconcile'
import { locks, operationsReleaseDeps, replayOperationsCatalogProjection, repositories, STALE_RUN_MAX_AGE_S } from './services'

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
	/** Relayed mail: queued messages re-enqueued, final messages whose content was forgotten. */
	mail: MailMaintenanceSummary
	/** `dev` environments stopped after their idle period, and stops that failed. */
	dev: DevIdleSummary
	/** Restores and orphaned migrations taken over, daily backups carried on and started (ADR-0070 §8–§9). */
	backups: BackupScheduleSummary
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
	/** A composition root whose provider runs `dev` environments injects their idle stop. */
	devIdle?: () => Promise<DevIdleSummary>
	/** A composition root whose provider serves the ops channel injects the data operations' pass (`runBackupSchedule`). */
	backups?: () => Promise<BackupScheduleSummary>
}

/**
 * One maintenance pass: poll PUBLIC repos (apps with no GitHub App install, which therefore get no push
 * webhook) for new commits and enqueue a deploy when a subscribed ref's head changes — the pull-based
 * trigger alongside the webhook — then reap orphaned runs.
 *
 * A poll-created run is serialized by the same per-app-env deploy lock as any other run (the consumer
 * takes it). The provider reconcile settles a run whose provider accepted it — on Cloudflare from the
 * status vozka-runner persists within ~18 min even when the relay is aborted. The sweep only fails runs
 * no provider ever accepted. Logs counts, coordinates and trigger refs only — never a feed URL or a secret.
 */
export async function runMaintenance(env: Env, options: MaintenanceOptions = {}): Promise<MaintenanceSummary> {
	const persistence = repositories(env)
	const now = options.now ?? (() => Math.floor(Date.now() / 1000))
	await enqueueUnsettledNamespaces(persistence.registry, env.DEPLOY_QUEUE)
	await warnBareTriggerRefs(persistence.registry)
	const poll = await pollPublicRepos({
		repositories: persistence,
		fetch: options.fetch ?? fetch,
		queue: env.DEPLOY_QUEUE,
		now,
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
	const swept = await sweepStaleRuns({ repositories: persistence, lock: locks(env), runLogs: env.RUN_LOGS }, STALE_RUN_MAX_AGE_S, options.now)
	if (swept > 0) {
		console.warn(`run sweep: marked ${swept} stale run(s) failed (> ${STALE_RUN_MAX_AGE_S}s in pending/running)`)
	}
	// The sync logs its own outcome line (operations-catalog.ts), so a second warn here would only repeat it.
	const operations = await (options.operations ?? (() => replayOperationsCatalogProjection(env)))()
	const releases = await (options.releases ?? (() => replayOperationsReleases(operationsReleaseDeps(env))))()
	if (releases.failed > 0) console.warn(`operations release maintenance replay failed for ${releases.failed} run(s)`)
	const mail = await runMailMaintenance({
		messages: persistence.mailMessages,
		...(env.MAIL_RELAY === undefined ? {} : { queue: env.MAIL_RELAY.queue }),
		now: now(),
	})
	if (mail.requeued > 0 || mail.purged > 0) console.info(`mail maintenance: requeued=${mail.requeued} purged=${mail.purged}`)
	const dev = options.devIdle === undefined ? { stopped: 0, failed: 0 } : await options.devIdle()
	if (dev.stopped > 0 || dev.failed > 0) console.info(`dev environments: stopped=${dev.stopped} failed=${dev.failed}`)
	// Last: a pass spends at most `BACKUP_PASS_MS` on dump requests, and what it leaves running the next pass continues.
	const backups = options.backups === undefined
		? { resumed: 0, continued: 0, started: 0, succeeded: 0, failed: 0, unfinished: 0, skipped: 0, errored: 0 }
		: await options.backups()
	if (backups.resumed > 0 || backups.continued > 0 || backups.started > 0 || backups.errored > 0) {
		console.info(
			`data operations: resumed=${backups.resumed} continued=${backups.continued} started=${backups.started} `
				+ `succeeded=${backups.succeeded} failed=${backups.failed} unfinished=${backups.unfinished} skipped=${backups.skipped} `
				+ `errored=${backups.errored}`,
		)
	}
	return { poll, reconcile, swept, operations, releases, mail, dev, backups }
}

/**
 * Name every environment whose trigger ref no push can match: a bare name `0009_canonical_trigger_refs.sql` left as it
 * was because another environment of the app holds its `refs/heads/` form. Returns the `<app>/<env>` coordinates warned of.
 */
export async function warnBareTriggerRefs(registry: ControlRegistryRepository): Promise<string[]> {
	const bare = await registry.listBareTriggerEnvs()
	for (const row of bare) {
		console.warn(
			`trigger ref "${row.trigger_ref}" of ${row.app_id}/${row.env} is not a full git ref, so no push deploys it; `
				+ `put ${row.app_id}/${row.env} again with a refs/heads/<branch> or refs/tags/<tag> trigger ref no other environment holds`,
		)
	}
	return bare.map((row) => `${row.app_id}/${row.env}`)
}
