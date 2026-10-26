import { WorkerEntrypoint } from 'cloudflare:workers'
import { controlApp } from './app'
import { runBackupSchedule } from './backups'
import { controlJobLogLine, runControlJob } from './consumer'
import { runMaintenance } from './cron'
import type { Env } from './env'
import { gitHubAppClientFactory } from './github/connections/credentials'
import { createSourceConnections } from './github/connections/port'
import { dispatchMail } from './mail-relay/dispatch'
import { decodeMailDispatchMessage, type MailDispatchMessage } from './mail-relay/queue'
import { cloudflareControlProvider, controlEnv, type WorkerBindings } from './platform-cf'
import { reconcileProviderRuns } from './provider-reconcile'
import { type ControlJobMessage, operationDeploys } from './run-lifecycle'
import { buildRunDeps, iamSchemaDeps, locks, operationsReleaseDeps, opsTransportDeps, platformTransportDeps, repositories, vault } from './services'

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
/** The mail relay's queue, whatever environment prefix the deploy gives it. */
const MAIL_QUEUE_SUFFIX = 'vozka-mail'

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
	 * The two consumers. The mail relay's queue (`<env>-vozka-mail`) carries one relayed message per job: every send
	 * failure settles or requeues its row, so only an unexpected throw is retried (maintenance re-enqueues a lost one).
	 * The control queue carries deploy and namespace jobs, one per message (maxBatchSize 1): ack on a handled message,
	 * including a `deferred` one, whose re-enqueue `runControlJob` has already done; retry only on an unexpected throw
	 * (Cloudflare redelivers, bounded by the queue's maxRetries).
	 */
	override async queue(batch: MessageBatch<unknown>): Promise<void> {
		const env = this.control
		if (batch.queue.endsWith(MAIL_QUEUE_SUFFIX)) {
			await this.dispatchMail(env, batch.messages)
			return
		}
		const provider = cloudflareControlProvider(this.env, env)
		for (const message of batch.messages) {
			try {
				console.info(controlJobLogLine(await runControlJob(env, provider, message.body as ControlJobMessage)))
				message.ack()
			} catch (err) {
				console.error('control consumer error', err instanceof Error ? err.message : 'unknown error')
				message.retry()
			}
		}
	}

	private async dispatchMail(env: Env, messages: readonly Message<unknown>[]): Promise<void> {
		const relay = env.MAIL_RELAY
		for (const message of messages) {
			if (relay === undefined) {
				message.retry()
				continue
			}
			let job: MailDispatchMessage
			try {
				job = decodeMailDispatchMessage(message.body)
			} catch {
				console.error('mail job: undecodable payload, dropped')
				message.ack()
				continue
			}
			try {
				await dispatchMail({
					messages: repositories(env).mailMessages,
					queue: relay.queue,
					sender: relay.sender,
					now: () => Math.floor(Date.now() / 1000),
				}, job)
				message.ack()
			} catch (err) {
				console.error('mail job failed', err instanceof Error ? err.message : 'unknown error')
				message.retry()
			}
		}
	}

	/** The cron handler (`triggers.crons`, every 5 min): poll public repos, then sweep orphaned runs. */
	override async scheduled(_controller: ScheduledController): Promise<void> {
		const env = this.control
		const { opsTransport } = opsTransportDeps(env)
		await runMaintenance(env, {
			// Without a vault Control holds no ops key, so it reaches no object and drives no data operation.
			...(opsTransport === undefined ? {} : {
				backups: async () => {
					const provider = cloudflareControlProvider(this.env, env)
					return await runBackupSchedule({
						repositories: env.REPOSITORIES,
						lock: locks(env),
						ops: opsTransport,
						provider,
						// A restore's own deploys run in the pass that owns it.
						deploys: operationDeploys(await buildRunDeps(env, provider)),
					})
				},
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
