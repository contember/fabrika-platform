// The per-run container Durable Object. Mirrors the preventado pattern: a subclass of
// `@cloudflare/containers` `Container` whose `defaultPort` matches the in-container server, with a
// generous `sleepAfter` so a long clone + install + provider deploy is never reaped mid-run.
//
// One DO instance == one container == one run. The vozka-runner Worker addresses a fresh instance per
// run (`idFromName(runId)`), `startAndWaitForPorts()`, then relays the job through it. This DO lives in
// vozka-runner (NOT the fabrika control plane) so a deploy of fabrika never resets the container that is
// running that very deploy — the self-reset that previously orphaned fabrika's own runs.

import { Container } from '@cloudflare/containers'
import { RUNNER_LOGS_PATH, RUNNER_PORT, RUNNER_RUN_PATH, RUNNER_STATUS_PATH, type RunnerStatus } from '@fabrika/provider-cloudflare/runner'
import { z } from 'zod'
import { backstopPayloadSchema, parseRunLogLine, parseRunnerStatus } from './protocol'
import { logsKey } from './relay'
import { RunContainerGate } from './run-container-gate'
import {
	BACKSTOP_FIRST_DELAY_S,
	BACKSTOP_POLL_S,
	backstopTick,
	recoverDispatched,
	RUN_DEADLINE_MS,
	type RunSettlementPorts,
	settleRun,
} from './run-outcome'
import type { Env } from './worker-env'

const DISPATCHED_AT = 'dispatchedAt'
const DRY_RUN = 'dryRun'

export class RunnerContainer extends Container<Env> {
	private readonly runGate = new RunContainerGate({
		read: async () => (await this.ctx.storage.get<boolean>('runCancelled')) === true,
		write: () => this.ctx.storage.put('runCancelled', true),
	})

	async startDeploy(runId: string, dryRun: boolean): Promise<void> {
		await this.runGate.run(async () => {
			await this.ctx.storage.put(DRY_RUN, dryRun)
			await this.startAndWaitForPorts()
			await this.armBackstop(runId)
		})
	}

	deployFetch(input: string, init?: RequestInit): Promise<Response> {
		return this.runGate.run(async () => {
			if (new URL(input).pathname === RUNNER_RUN_PATH) await this.ctx.storage.put(DISPATCHED_AT, Date.now())
			return this.containerFetch(input, init)
		})
	}

	/** The run's terminal status once known (persisting it if needed), or null while it is in flight. */
	async recoverDeploy(runId: string): Promise<RunnerStatus | null> {
		const gate = await this.runGate.recover(async () => (await this.dispatchedAt()) !== null, () => this.destroy())
		return recoverDispatched(await this.settlementPorts(runId), gate === 'running' ? await this.dispatchedAt() : null)
	}

	private async dispatchedAt(): Promise<number | null> {
		const parsed = z.number().finite().safeParse(await this.ctx.storage.get(DISPATCHED_AT))
		return parsed.success ? parsed.data : null
	}

	private async settlementPorts(runId: string): Promise<RunSettlementPorts> {
		return {
			runId,
			dryRun: z.boolean().safeParse(await this.ctx.storage.get(DRY_RUN)).data === true,
			bucket: this.env.RUN_LOGS,
			now: () => Date.now(),
			containerStatus: async () => {
				try {
					const res = await this.deployFetch(`http://container${RUNNER_STATUS_PATH}`)
					return parseRunnerStatus(await res.json(), runId)
				} catch {
					return null
				}
			},
			// Never log the error object (it may hold a token).
			flushLogs: async () => {
				try {
					const logs = await this.deployFetch(`http://container${RUNNER_LOGS_PATH}`)
					const text = await logs.text()
					const lines = text.split('\n').filter((l) => l.length > 0).map((line) => JSON.stringify(parseRunLogLine(line)))
					if (lines.length > 0) await this.env.RUN_LOGS.put(logsKey(runId), lines.join('\n'))
				} catch (err) {
					console.error('runner: final log flush failed', err instanceof Error ? err.message : 'unknown error')
				}
			},
		}
	}

	cancelDeploy(): Promise<void> {
		return this.runGate.cancel(() => this.destroy())
	}
	// Must match the in-container Bun server's fixed port (and the oblaka Container image's EXPOSE).
	override defaultPort = RUNNER_PORT

	// Heartbeat / long-job safety: a deploy run (clone + install + deploy) can take many minutes,
	// and a quiet `bun install` produces no traffic. A long inactivity window keeps the instance
	// from being reaped; the relay additionally calls `heartbeat()` to renew the timer (see below).
	// CF still SIGTERMs on a rollout and hard-kills ~15 min later — runs are expected to finish well
	// inside that, and the backstop persists a terminal status to R2 regardless.
	override sleepAfter = '20m'

	override onStart(): void {
		console.info('vozka runner container started')
	}

	override onStop(params: { exitCode: number; reason: string }): void {
		console.info(`vozka runner container stopped (exit ${params.exitCode}, ${params.reason})`)
	}

	override onError(error: unknown): void {
		console.error('vozka runner container error:', error)
	}

	/**
	 * Renew the activity timeout. The relay calls this on each log line and on a timer so a long,
	 * output-quiet step (e.g. `bun install`) doesn't let the inactivity timer trip mid-run.
	 */
	heartbeat(): void {
		this.renewActivityTimeout()
	}

	/**
	 * Arm the run-completion BACKSTOP. The relay (logs + terminal status → R2) runs INSIDE the
	 * `RUNNER_SVC.startRun` RPC from the control plane; when a deploy redeploys fabrika ITSELF, fabrika's
	 * reset aborts that RPC and kills the relay before it persists the outcome — yet this container (a DO
	 * in the SEPARATE vozka-runner worker) survives and the deploy completes. The backstop polls the
	 * container from the DO's own caller-independent context and persists the terminal status the control
	 * plane's reconcile reads back. Scheduled via the Container's own `schedule()` (NOT a raw `alarm()`
	 * override — the base class owns the alarm).
	 */
	async armBackstop(runId: string): Promise<void> {
		await this.schedule(BACKSTOP_FIRST_DELAY_S, 'backstopCheck', { runId, deadline: Date.now() + RUN_DEADLINE_MS })
	}

	/** Scheduled backstop tick — persists the run's terminal status if the relay didn't. Re-schedules itself until settled. */
	async backstopCheck(payload: { runId: string; deadline: number }): Promise<void> {
		const parsed = backstopPayloadSchema.safeParse(payload)
		if (!parsed.success) throw new Error('runner: invalid backstop payload')
		const { runId, deadline } = parsed.data
		await backstopTick(
			async () => settleRun(await this.settlementPorts(runId), deadline),
			async () => {
				await this.schedule(BACKSTOP_POLL_S, 'backstopCheck', { runId, deadline })
			},
		)
	}
}
