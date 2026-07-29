import type {
	ProviderDeployResult,
	ProviderDeployStep,
	ProviderJobSpec,
	ProviderRunStatus,
	RuntimeProvider,
	RuntimeProviderRun,
} from '@fabrika/provider-contract'

/** The message recorded when a run is cancelled while a step is active. */
export const CANCELLED = 'deploy cancelled'

interface MutableDeployStep {
	spec: ProviderJobSpec
	status: ProviderRunStatus
	error?: string
	startedAt?: number
	finishedAt?: number
}

const initSteps = (specs: readonly ProviderJobSpec[]): MutableDeployStep[] => specs.map((spec): MutableDeployStep => ({ spec, status: 'pending' }))

/**
 * Stop waiting for provider work as soon as the run is cancelled. Providers receive the same signal
 * and remain responsible for stopping their underlying operation.
 */
const untilCancelled = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
	if (signal.aborted) {
		return Promise.reject(new Error(CANCELLED))
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => reject(new Error(CANCELLED))
		signal.addEventListener('abort', onAbort, { once: true })
		void promise.then(resolve, reject).finally(() => {
			signal.removeEventListener('abort', onAbort)
		})
	})
}

const failureMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * Execute one provider-derived plan in order. Provider selection is explicit and static: callers
 * pass the single runtime provider assembled by their composition root.
 */
export const deploy = async (provider: RuntimeProvider, run: RuntimeProviderRun): Promise<ProviderDeployResult> => {
	const session = await provider.open(run)
	const { plan } = session
	if (plan.appId !== run.appId || plan.env !== run.env) {
		throw new Error(
			`deploy: provider "${provider.id}" returned plan ${plan.appId}/${plan.env}, expected ${run.appId}/${run.env}`,
		)
	}

	const steps = initSteps(plan.steps)
	run.events.log(`Deploy ${plan.appId} → ${plan.env}${run.dryRun ? ' (dry-run)' : ''} — ${steps.length} step(s):`)
	for (const step of steps) {
		run.events.log(`  • ${step.spec.id} — ${step.spec.description}`)
	}

	let stopped = false
	for (const step of steps) {
		if (stopped) {
			step.status = 'skipped'
			continue
		}
		if (run.signal.aborted) {
			stopped = true
			step.status = 'skipped'
			run.events.log(`∅ ${step.spec.id}: ${CANCELLED}`)
			continue
		}

		step.status = 'running'
		step.startedAt = Date.now()
		run.events.log(`→ ${step.spec.id}`)
		try {
			await untilCancelled(session.execute(step.spec.id), run.signal)
			step.status = 'succeeded'
		} catch (error) {
			step.status = 'failed'
			step.error = failureMessage(error)
			stopped = true
			run.events.log(`✗ ${step.spec.id}: ${step.error}`)
		}
		step.finishedAt = Date.now()
	}

	const resultSteps: readonly ProviderDeployStep[] = steps
	return {
		appId: plan.appId,
		env: plan.env,
		status: stopped ? 'failed' : 'succeeded',
		plan,
		steps: resultSteps,
	}
}
