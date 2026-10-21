/** What happened to one provider deploy step. */
export interface DeployStepResult {
	readonly id: string
	readonly status: 'succeeded' | 'failed' | 'skipped'
	readonly error?: string
	readonly startedAt?: number
	readonly finishedAt?: number
}

export interface RunStepsOptions {
	readonly appId: string
	readonly env: string
	readonly dryRun: boolean
	readonly signal: AbortSignal
	readonly log: (line: string) => void
}

const CANCELLED = 'deploy cancelled'

/** Stop waiting as soon as the run is cancelled; the step receives the same signal and stops its own work. */
const untilCancelled = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> =>
	new Promise<T>((resolve, reject) => {
		const onAbort = (): void => reject(new Error(CANCELLED))
		if (signal.aborted) onAbort()
		else signal.addEventListener('abort', onAbort, { once: true })
		// Always observed, so a step that fails after it was abandoned is not an unhandled rejection.
		void promise.then(resolve, reject).finally(() => {
			signal.removeEventListener('abort', onAbort)
		})
	})

/** Run a provider's steps in order. The first failure or a cancellation skips every later step. */
export const runSteps = async <TStep extends { readonly id: string; readonly description: string }>(
	steps: readonly TStep[],
	options: RunStepsOptions,
	runOne: (step: TStep) => Promise<void>,
): Promise<{ readonly status: 'succeeded' | 'failed'; readonly steps: readonly DeployStepResult[] }> => {
	const { log, signal } = options
	log(`Deploy ${options.appId} → ${options.env}${options.dryRun ? ' (dry-run)' : ''} — ${steps.length} step(s):`)
	for (const step of steps) {
		log(`  • ${step.id} — ${step.description}`)
	}

	const results: DeployStepResult[] = []
	let stopped = false
	for (const step of steps) {
		if (stopped) {
			results.push({ id: step.id, status: 'skipped' })
			continue
		}
		if (signal.aborted) {
			stopped = true
			results.push({ id: step.id, status: 'skipped' })
			log(`∅ ${step.id}: ${CANCELLED}`)
			continue
		}

		const startedAt = Date.now()
		log(`→ ${step.id}`)
		try {
			await untilCancelled(runOne(step), signal)
			const finishedAt = Date.now()
			log(`✓ ${step.id} (${((finishedAt - startedAt) / 1000).toFixed(1)}s)`)
			results.push({ id: step.id, status: 'succeeded', startedAt, finishedAt })
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			stopped = true
			log(`✗ ${step.id}: ${message}`)
			results.push({ id: step.id, status: 'failed', error: message, startedAt, finishedAt: Date.now() })
		}
	}

	return { status: stopped ? 'failed' : 'succeeded', steps: results }
}
