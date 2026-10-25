import { WorkerEntrypoint } from 'cloudflare:workers'
import { controlApp } from './app'
import { runBackupSchedule } from './backups'
import { controlJobLogLine, runControlJob } from './consumer'
import { runMaintenance } from './cron'
import type { Env } from './env'
import { gitHubAppClientFactory } from './github/connections/credentials'
import { createSourceConnections } from './github/connections/port'
import { cloudflareControlProvider, controlEnv, type WorkerBindings } from './platform-cf'
import { reconcileProviderRuns } from './provider-reconcile'
import type { ControlJobMessage } from './run-lifecycle'
import { iamSchemaDeps, locks, operationsReleaseDeps, opsTransportDeps, platformTransportDeps, vault } from './services'

/**
 * The fabrika control plane — the CLOUDFLARE entrypoint, and nothing more. A single `WorkerEntrypoint`
 * carrying `fetch`, `queue` (the deploy consumer) and `scheduled` (repo poll + stale-run sweep).
 *
 * There is no logic here. Every method delegates to the runtime-neutral `controlApp`,
 * `runDeployJob` (src/consumer.ts), and `runMaintenance` (src/cron.ts) — the same
 * functions the Bun entrypoint calls. This composition root selects Cloudflare once.
 * This file's whole job is to bind `cloudflare:workers` to them, and it is the ONLY file in the
 * package that imports it: the Bun process must never load this module, and it must never load
 * `bun:*`/`node:*`. `src/__tests__/entrypoint-isolation.test.ts` walks both graphs and enforces that.
 *
 * `controlEnv` is what makes one `Env` serve both: it presents the raw bindings (`this.env`) as the
 * ports everything downstream is written against. Two of the five need no adapter at all.
 */
export class Vozka extends WorkerEntrypoint<WorkerBindings> {
	/** The runtime-neutral view of this Worker's bindings. Cheap — three closures and a spread. */
	private get control(): Env {
		return controlEnv(this.env, (promise) => this.ctx.waitUntil(promise))
	}

	override fetch(request: Request): Promise<Response> {
		const env = this.control
		return controlApp.fetch(request, {
			env,
			provider: cloudflareControlProvider(this.env, env),
			sourceConnection: createSourceConnections({ provider: 'cloudflare', vault: () => vault(env), createClient: gitHubAppClientFactory() }),
		}, this.ctx)
	}

	/**
	 * The control consumer — deploy jobs and namespace jobs off one queue. One job per message
	 * (maxBatchSize 1). ack on a handled message — including a `deferred` one, whose re-enqueue
	 * `runControlJob` has already done; retry only on an unexpected throw (Cloudflare redelivers,
	 * bounded by the queue's maxRetries).
	 */
	override async queue(batch: MessageBatch<ControlJobMessage>): Promise<void> {
		const env = this.control
		const provider = cloudflareControlProvider(this.env, env)
		for (const message of batch.messages) {
			try {
				console.info(controlJobLogLine(await runControlJob(env, provider, message.body)))
				message.ack()
			} catch (err) {
				console.error('control consumer error', err instanceof Error ? err.message : 'unknown error')
				message.retry()
			}
		}
	}

	/** The cron handler (`triggers.crons`, every 5 min): poll public repos, then sweep orphaned runs. */
	override async scheduled(_controller: ScheduledController): Promise<void> {
		const env = this.control
		const { opsTransport } = opsTransportDeps(env)
		await runMaintenance(env, {
			// Without a vault Control holds no ops key, so it reaches no object and backs up nothing.
			...(opsTransport === undefined ? {} : {
				backups: () =>
					runBackupSchedule({
						repositories: env.REPOSITORIES,
						lock: locks(env),
						ops: opsTransport,
						provider: cloudflareControlProvider(this.env, env),
					}),
			}),
			reconcile: () =>
				reconcileProviderRuns({
					repositories: env.REPOSITORIES,
					provider: cloudflareControlProvider(this.env, env),
					runLogs: env.RUN_LOGS,
					lock: locks(env),
					operations: operationsReleaseDeps(env),
					...platformTransportDeps(env),
					...iamSchemaDeps(env),
				}),
		})
	}
}

export default Vozka
