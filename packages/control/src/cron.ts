// Scheduled maintenance — the work behind the Worker's `scheduled` handler, extracted so the
// long-running process runs exactly the same code on exactly the same schedule.
//
// Event-driven targets call this from a scheduled handler; long-running targets invoke `bun/cron.ts` through their composition root
// from their platform scheduler. There is no in-process timer: in a horizontally-scaled service it
// would fire once per container and silently reset on every deploy. Both operations tolerate an
// overlapping run — the poll is a conditional GET whose only mutation is guarded by a changed head
// sha, and the sweep is a guarded UPDATE by age.

import type { ControlProvider } from '@fabrika/provider-contract'
import { enqueueUnsettledNamespaces } from './api/namespaces'
import { convergeIamGates, type IamMirrorSummary } from './approval/iam-mirror'
import { sweepUnfetchedKeys, type UnfetchedKeySweepSummary } from './approval/requests/deliveries'
import { type ApprovalRequestSweepSummary, sweepApprovalRequests } from './approval/requests/execute'
import type { BackupScheduleSummary } from './backups'
import type { ControlRegistryRepository } from './db'
import type { DevMaintenanceSummary } from './dev/service'
import type { Env } from './env'
import { exposureProvider, type ExposureWatchSummary, NO_EXPOSURE_WATCH, watchExposure } from './exposure-watch'
import { type FetchFn, pollPublicRepos, type PollSummary } from './github/triggers/poll'
import { type MailMaintenanceSummary, runMailMaintenance } from './mail-relay/maintenance'
import type { OperationsCatalogSyncSummary } from './operations-catalog'
import type { OperationsReleaseProjectionSummary } from './operations-releases'
import { replayOperationsReleases } from './operations-releases'
import { type ParkedRunSweepSummary, type ProviderReconcileSummary, sweepParkedRuns, sweepStaleRuns } from './provider-reconcile'
import { WORKSPACE_REF_PREFIX } from './ref-match'
import {
	grantApprovalDeps,
	iamGrantsDeps,
	locks,
	operationsReleaseDeps,
	replayOperationsCatalogProjection,
	repositories,
	STALE_RUN_MAX_AGE_S,
	vault,
	workloadCredentialDeps,
} from './services'
import { warnExpiringWorkloadKeys, type WorkloadKeyExpirySummary } from './workload-key-expiry'
import { NO_WORKLOAD_KEY_ROTATION, rotateWorkloadKeys, rotatingProvider, type WorkloadKeyRotationSummary } from './workload-key-rotation'

/** What one maintenance pass did. Returned for the tests + the log line; counts only, never a URL. */
export interface MaintenanceSummary {
	poll: PollSummary
	/** Provider-owned runs observed or completed. */
	reconcile: ProviderReconcileSummary
	/** Orphaned runs marked failed by the sweep. */
	swept: number
	/** Parked runs given a deadline, and parked runs expired past theirs (ADR-0050 §4). */
	parked: ParkedRunSweepSummary
	/** Approval requests expired past their deadline, and interrupted executions settled (ADR-0083 §8). */
	requests: ApprovalRequestSweepSummary
	/** Keys approved requests issued that nobody fetched by their deadline: expired, and revoked in IAM (ADR-0083 §8). */
	requestedKeys: UnfetchedKeySweepSummary
	/** Environments whose approval gates IAM had not taken at their protection revision, written now (ADR-0083 §4, §8). */
	iamGates: IamMirrorSummary
	/** Full Operations catalog replay, isolated from deploy maintenance success. */
	operations: OperationsCatalogSyncSummary
	/** Pending deploy-release projections repaired independently from catalog sync. */
	releases: OperationsReleaseProjectionSummary
	/** Relayed mail: queued messages re-enqueued, final messages whose content was forgotten. */
	mail: MailMaintenanceSummary
	/** `dev` workspace sandboxes parked after their idle period, sandboxes removed, and what failed. */
	dev: DevMaintenanceSummary
	/** Restores and orphaned migrations taken over, daily backups carried on and started (ADR-0070 §8–§9). */
	backups: BackupScheduleSummary
	/** Workload keys renewed before expiry and handed to the running version without a deploy. */
	workloadKeys: WorkloadKeyRotationSummary
	/** Environments warned through their Operations that a key the running version holds is about to expire. */
	workloadKeyExpiry: WorkloadKeyExpirySummary
	/** Environments read back for a service exposed past their proxy since their last deploy, and alerted on a change. */
	exposure: ExposureWatchSummary
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
	/** A composition root whose provider runs `dev` environments injects their sandboxes' idle park and stale removal. */
	devIdle?: () => Promise<DevMaintenanceSummary>
	/** A composition root whose provider serves the ops channel injects the data operations' pass (`runBackupSchedule`). */
	backups?: () => Promise<BackupScheduleSummary>
	/** The installation's provider: an approval request whose effect it keeps (a secret) is settled by reading it back. */
	provider?: ControlProvider
	/**
	 * How Control reaches an application's Operations ingest. The Worker passes its Operations binding, which serves the
	 * ingest hostname too; without it, the global `fetch` to the ingest origin.
	 */
	operationsIngest?: (request: Request) => Promise<Response>
}

/**
 * One maintenance pass: poll PUBLIC repos (apps with no GitHub App install, which therefore get no push
 * webhook) for new commits and enqueue a deploy when a subscribed ref's head changes — the pull-based
 * trigger alongside the webhook — then reap orphaned runs.
 *
 * A poll-created run is serialized by the same per-app-env deploy lock as any other run (the consumer
 * takes it). The provider reconcile settles a run whose provider accepted it — on Cloudflare from the
 * status the runner Worker persists within ~18 min even when the relay is aborted. The sweep only fails runs
 * no provider ever accepted. Logs counts, coordinates and trigger refs only — never a feed URL or a secret.
 */
export async function runMaintenance(env: Env, options: MaintenanceOptions = {}): Promise<MaintenanceSummary> {
	const persistence = repositories(env)
	const now = options.now ?? (() => Math.floor(Date.now() / 1000))
	await enqueueUnsettledNamespaces(persistence.registry, env.DEPLOY_QUEUE)
	await warnBareTriggerRefs(persistence.registry)
	await warnWorkspaceTriggerRefs(persistence.registry)
	const poll = await pollPublicRepos({
		repositories: persistence,
		// Wrapped: the poller calls it as `deps.fetch`, and a Worker refuses the global `fetch` with that `this`.
		fetch: options.fetch ?? ((input, init) => fetch(input, init)),
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
	const parked = await sweepParkedRuns({ repositories: persistence, lock: locks(env), runLogs: env.RUN_LOGS })
	if (parked.deadlines > 0 || parked.expired > 0) {
		console.info(`parked runs: deadlines=${parked.deadlines} expired=${parked.expired}`)
	}
	const iam = iamGrantsDeps(env)
	const requests = await sweepApprovalRequests({
		repositories: persistence,
		lock: locks(env),
		vault: () => vault(env),
		...iam,
		...(options.provider === undefined ? {} : { provider: options.provider }),
	})
	if (requests.expired > 0 || requests.interrupted > 0 || requests.settled > 0 || requests.orphans > 0) {
		console.info(
			`approval requests: expired=${requests.expired} interrupted=${requests.interrupted} settled=${requests.settled} orphans=${requests.orphans}`,
		)
	}
	const requestedKeys = await sweepUnfetchedKeys({ repositories: persistence, ...(iam.iamKeys === undefined ? {} : { iamKeys: iam.iamKeys }) })
	if (requestedKeys.expired > 0 || requestedKeys.revoked > 0) {
		console.info(`requested keys: expired=${requestedKeys.expired} revoked=${requestedKeys.revoked}`)
	}
	const iamGates = await convergeIamGates({ repositories: persistence, ...grantApprovalDeps(env) })
	if (iamGates.written > 0 || iamGates.failed > 0) {
		console.info(`IAM approval gates: written=${iamGates.written} failed=${iamGates.failed}`)
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
	if (mail.requeued > 0 || mail.purged > 0 || mail.collected > 0) {
		console.info(`mail maintenance: requeued=${mail.requeued} purged=${mail.purged} collected=${mail.collected}`)
	}
	// Before the backups, which may spend the rest of the pass: an expired key stops the application's jobs.
	// On every provider: a key a succeeded run handed is the one the running version holds, before anything renews it.
	const handedKeys = await persistence.workloadCredentials.confirmHanded()
	if (handedKeys > 0) console.info(`workload keys: confirmed=${handedKeys} handed by succeeded runs`)
	const workloadKeys = await renewWorkloadKeys(env, options.provider, now)
	if (workloadKeys.written > 0 || workloadKeys.confirmed > 0 || workloadKeys.busy > 0 || workloadKeys.failed > 0) {
		console.info(
			`workload keys: written=${workloadKeys.written} confirmed=${workloadKeys.confirmed} busy=${workloadKeys.busy} failed=${workloadKeys.failed}`,
		)
	}
	const workloadKeyExpiry = await warnExpiringWorkloadKeys({
		repositories: persistence,
		ingest: options.operationsIngest ?? ((request) => fetch(request)),
		now,
	})
	if (workloadKeyExpiry.warned > 0 || workloadKeyExpiry.failed > 0) {
		console.info(`workload key expiry: warned=${workloadKeyExpiry.warned} failed=${workloadKeyExpiry.failed}`)
	}
	const exposure = await checkExposure(env, options, now)
	if (exposure.alerted > 0 || exposure.cleared > 0 || exposure.failed > 0) {
		console.info(
			`exposure: checked=${exposure.checked} alerted=${exposure.alerted} cleared=${exposure.cleared} busy=${exposure.busy} failed=${exposure.failed}`,
		)
	}
	const dev = options.devIdle === undefined ? { parked: 0, removed: 0, failed: 0 } : await options.devIdle()
	if (dev.parked > 0 || dev.removed > 0 || dev.failed > 0) {
		console.info(`dev environments: parked=${dev.parked} removed=${dev.removed} failed=${dev.failed}`)
	}
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
	return {
		poll,
		reconcile,
		swept,
		parked,
		requests,
		requestedKeys,
		iamGates,
		operations,
		releases,
		mail,
		dev,
		backups,
		workloadKeys,
		workloadKeyExpiry,
		exposure,
	}
}

/** Without a provider that reads exposure back outside a run, only a deploy reads it. */
async function checkExposure(env: Env, options: MaintenanceOptions, now: () => number): Promise<ExposureWatchSummary> {
	const provider = exposureProvider(options.provider)
	if (provider === null) return { ...NO_EXPOSURE_WATCH }
	return watchExposure({
		repositories: repositories(env),
		provider,
		locks: locks(env),
		ingest: options.operationsIngest ?? ((request) => fetch(request)),
		now,
	})
}

/** Without a provider that writes managed credentials, or without a vault and IAM, keys reach an application only by a deploy. */
async function renewWorkloadKeys(env: Env, provider: ControlProvider | undefined, now: () => number): Promise<WorkloadKeyRotationSummary> {
	const rotating = rotatingProvider(provider)
	const { workloadCredentials } = workloadCredentialDeps(env)
	if (rotating === null || workloadCredentials === undefined) return { ...NO_WORKLOAD_KEY_ROTATION }
	return rotateWorkloadKeys({ repositories: repositories(env), credentials: workloadCredentials, provider: rotating, locks: locks(env), now })
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

/**
 * Name every environment whose trigger ref is under the branches reserved for MCP workspaces, which no push or poll
 * deploys: a row stored before `canonicalTriggerRef` refused them. Returns the `<app>/<env>` coordinates warned of.
 */
export async function warnWorkspaceTriggerRefs(registry: ControlRegistryRepository): Promise<string[]> {
	const reserved = await registry.listWorkspaceTriggerEnvs()
	for (const row of reserved) {
		console.warn(
			`trigger ref "${row.trigger_ref}" of ${row.app_id}/${row.env} is under ${WORKSPACE_REF_PREFIX}, the branches reserved for `
				+ `MCP workspaces, so no push deploys it; put ${row.app_id}/${row.env} again with a trigger ref outside ${WORKSPACE_REF_PREFIX}`,
		)
	}
	return reserved.map((row) => `${row.app_id}/${row.env}`)
}
