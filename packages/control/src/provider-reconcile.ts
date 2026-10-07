import type { RunLogLine } from '@fabrika/control-contract'
import type { BlobStore } from '@fabrika/platform'
import type { ProviderReconcileOutcome } from '@fabrika/provider-contract'
import { parseProviderJson } from './db'
import { projectedReturnOrigins } from './return-origins'
import { projectTerminalRun, providerEnvironment, type RunDeps, settleRunCancellation } from './run-lifecycle'
import { RunOwnership } from './run-ownership'

export interface ProviderReconcileSummary {
	checked: number
	succeeded: number
	failed: number
	inProgress: number
	waiting: number
}

export type ProviderReconcileDeps = Pick<RunDeps, 'repositories' | 'provider' | 'lock' | 'operations' | 'ownershipTiming'> & {
	projectTerminal?: typeof projectTerminalRun
	/** The run-log store a provider's reconcile appends to; absent, its lines go to the console only. */
	runLogs?: Pick<BlobStore, 'get' | 'put'>
}

async function project(
	deps: ProviderReconcileDeps,
	runId: string,
	state: 'failed' | 'succeeded',
	outcome: Pick<ProviderReconcileOutcome, 'artifactState' | 'dryRun'> = {},
): Promise<void> {
	try {
		await (deps.projectTerminal ?? projectTerminalRun)(deps, runId, outcome.dryRun === true, state, outcome.artifactState)
	} catch {
		console.error(`provider reconcile terminal projection failed for run ${runId}`)
	}
}

/** Append one meta line to a run's log, keeping what the provider's executor already wrote there. */
async function appendRunLog(logs: Pick<BlobStore, 'get' | 'put'>, key: string, text: string): Promise<void> {
	const existing = await logs.get(key)
	const before = existing === null ? '' : await existing.text()
	const line: RunLogLine = { ts: Date.now(), stream: 'meta', text }
	const separator = before === '' || before.endsWith('\n') ? '' : '\n'
	await logs.put(key, `${before}${separator}${JSON.stringify(line)}\n`)
}

export async function reconcileProviderRuns(deps: ProviderReconcileDeps): Promise<ProviderReconcileSummary> {
	const summary: ProviderReconcileSummary = { checked: 0, succeeded: 0, failed: 0, inProgress: 0, waiting: 0 }
	for (const candidate of await deps.repositories.runs.listInFlightRuns(deps.provider.id)) {
		const owner = await RunOwnership.acquire(deps.repositories.runs, deps.lock, candidate, deps.ownershipTiming)
		if (owner === null) {
			summary.inProgress++
			continue
		}
		try {
			const run = owner.row
			if (run.status !== 'pending' && run.status !== 'running') continue
			if (run.cancel_requested_at !== null) {
				summary.checked++
				const settled = await settleRunCancellation(deps, owner)
				if (settled === null) summary.inProgress++
				else {
					summary[settled]++
					await project(deps, run.id, settled)
				}
				continue
			}
			if (run.external_run_id === null) {
				if (run.status === 'pending') {
					summary.waiting++
					continue
				}
				summary.checked++
				await owner.mutate((guard) => deps.repositories.runs.markRunFinished(run.id, 'failed', null, guard))
				summary.failed++
				await project(deps, run.id, 'failed')
				continue
			}
			const reconcile = deps.provider.reconcile
			if (reconcile === undefined) {
				summary.inProgress++
				continue
			}
			summary.checked++
			const appEnv = await deps.repositories.registry.getAppEnv(run.app_id, run.env)
			if (appEnv === null || appEnv.provider !== deps.provider.id) throw new Error('provider environment disappeared or changed owner')
			const returnOrigins = await projectedReturnOrigins(deps.repositories.registry, run.app_id)
			const environment = await providerEnvironment(deps.repositories.registry, appEnv)
			await owner.refreshCancellation()
			owner.work.signal.throwIfAborted()
			const outcome = await reconcile({
				runId: run.id,
				externalId: run.external_run_id,
				environment,
				signal: owner.work.signal,
				...(run.provider_state_json === null ? {} : { providerState: parseProviderJson(run.provider_state_json, 'provider state') }),
				startedAtMs: (run.started_at ?? run.created_at) * 1000,
				...(returnOrigins === undefined ? {} : { returnOrigins }),
				log: async (line) => {
					console.info(`deploy run ${run.id}: ${line}`)
					if (deps.runLogs === undefined || run.log_key === null) return
					await appendRunLog(deps.runLogs, run.log_key, line).catch(() => console.error(`deploy run ${run.id}: failed to persist log output`))
				},
			})
			await owner.drain()
			await owner.refreshCancellation()
			if (owner.work.signal.aborted) {
				const settled = await settleRunCancellation(deps, owner).catch(() => null)
				if (settled === null) summary.inProgress++
				else summary[settled]++
				continue
			}
			if (outcome.state === 'running') {
				summary.inProgress++
				continue
			}
			const state = outcome.state
			await owner.mutate((guard) => deps.repositories.runs.markRunFinished(run.id, state, outcome.exitCode ?? null, guard))
			summary[state]++
			await project(deps, run.id, state, outcome)
		} catch {
			console.error(`provider reconcile failed for run ${candidate.id}`)
			if (!owner.lost && owner.work.signal.aborted && owner.row.cancel_requested_at === null) {
				await settleRunCancellation(deps, owner).catch(() => {})
			}
			summary.inProgress++
		} finally {
			await owner.close().catch(() => console.error(`provider reconcile lock release failed for run ${candidate.id}`))
		}
	}
	return summary
}

export async function sweepStaleRuns(
	deps: Pick<RunDeps, 'repositories' | 'lock' | 'ownershipTiming'>,
	maxAgeSeconds: number,
	now: () => number = () => Math.floor(Date.now() / 1000),
): Promise<number> {
	let swept = 0
	for (const candidate of await deps.repositories.runs.listStaleRuns(maxAgeSeconds)) {
		const owner = await RunOwnership.acquire(deps.repositories.runs, deps.lock, candidate, deps.ownershipTiming)
		if (owner === null) continue
		try {
			const run = owner.row
			if (
				(run.status !== 'pending' && run.status !== 'running') || run.external_run_id !== null || run.cancel_requested_at !== null
				|| (run.started_at ?? run.created_at) >= now() - maxAgeSeconds
			) continue
			await owner.mutate((guard) => deps.repositories.runs.markRunFinished(run.id, 'failed', null, guard))
			swept++
		} finally {
			await owner.close()
		}
	}
	return swept
}
